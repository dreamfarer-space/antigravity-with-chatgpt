/**
 * cdp_transport.mjs - 专用 Chrome CDP 驱动与传输适配器
 * ---------------------------------------------------------------------------
 * 零 npm 依赖：纯原生 WebSocket + fetch 驱动 127.0.0.1:9222
 *   - Base64 + execCommand 毫秒级极速注入
 *   - 350ms MutationObserver DOM Quiet 低延迟完成监听
 *   - Node 24 Windows libuv 异步关闭竞态防护
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { computeFingerprint, BROWSER_FINGERPRINT_SNIPPET } from './fingerprint.mjs';
import {
  selectTargetPage,
  canonicalizeConversationUrl,
  conversationPathname,
  isRootConversation,
  isEphemeralConversation,
  isPinnableConversation,
  isSameConversation,
  isSameConversationStrict,
} from './target_selector.mjs';

// 会话身份工具同时对外暴露（历史 API 兼容，测试与上层均从此模块导入）
export { canonicalizeConversationUrl, isRootConversation, isEphemeralConversation, isPinnableConversation, isSameConversation, isSameConversationStrict };

/**
 * 端到端共享的绝对截止时间安全边界。
 * 所有等待（CDP 连接、DOM 探测、静默窗口、文本读取）都必须来自同一条 deadlineMs 预算，
 * 任何一步都不得用 Math.max(x, ...) 人为制造"额外时间"。
 */
export const DEFAULT_SAFETY_MARGIN_MS = 5000;

/**
 * 计算某一步实际可用的剩余预算（毫秒）；返回值 <= 0 表示预算已耗尽，调用方必须立刻收尾。
 * @param {number} deadlineMs 绝对截止时间戳
 * @param {number} capMs 单步上限
 * @param {number} [marginMs=0] 预留安全边际
 * @returns {number}
 */
export function remainingBudgetMs(deadlineMs, capMs, marginMs = 0) {
  if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs)) return capMs;
  return Math.max(0, Math.min(capMs, deadlineMs - Date.now() - marginMs));
}

/**
 * 申请本步预算；当统一 deadline 已耗尽时立即抛错中止。
 * 用于所有"必须成功才能继续"的关键步骤（注入、提交、连接等），
 * 确保任何一层都不会为了"再试一次"而突破宿主超时。
 * @param {number|undefined} deadlineMs
 * @param {number} capMs
 * @param {string} label
 * @returns {number}
 */
function requireBudgetMs(deadlineMs, capMs, label) {
  const budget = remainingBudgetMs(deadlineMs, capMs);
  if (typeof deadlineMs === 'number' && Number.isFinite(deadlineMs) && budget <= 0) {
    throw new Error(`总截止时间预算已耗尽（${label}），已中止以防突破宿主超时`);
  }
  return budget;
}

/**
 * 把"相对 N 毫秒的循环截止时间"收敛到统一 deadline，取二者更早者。
 * @param {number|undefined} deadlineMs
 * @param {number} capMs
 * @returns {number} 绝对时间戳
 */
function stepDeadline(deadlineMs, capMs) {
  const local = Date.now() + capMs;
  return (typeof deadlineMs === 'number' && Number.isFinite(deadlineMs))
    ? Math.min(local, deadlineMs)
    : local;
}

/**
 * 受统一 deadline 约束的 sleep：预算不足时只睡剩余部分，已耗尽则完全不睡。
 * @param {number} ms
 * @param {number|undefined} deadlineMs
 * @returns {Promise<number>} 实际睡眠毫秒数
 */
async function sleepWithin(ms, deadlineMs) {
  const budget = remainingBudgetMs(deadlineMs, ms);
  if (budget > 0) {
    await sleep(budget);
    return budget;
  }
  return 0;
}

/**
 * 构造统一的 inProgress（优雅降级）结果。
 * 恢复凭证规则：`conversationUrl` 仅在拿到 durable `/c/<id>` 身份时给出；
 * 否则必须为 null（绝不把 `/` 或临时 `/c/WEB:<uuid>` 当凭证），
 * 此时用 `targetId`（Chrome target，opaque）作为兜底恢复凭证。
 */
function buildInProgressResult({ text = '', turns = 0, expectedTurn, url = null, conversationUrl = null, targetId = null, isStreaming = false, message = '' } = {}) {
  return {
    ok: true,
    inProgress: true,
    isStreaming: Boolean(isStreaming),
    text: text || '',
    turns: typeof turns === 'number' ? turns : 0,
    expectedTurn,
    url,
    conversationUrl: conversationUrl || null,
    targetId: targetId || null,
    message,
  };
}

function resolveProfileDir() {
  if (process.env.CHATGPT_BRAIN_PROFILE_DIR) {
    return process.env.CHATGPT_BRAIN_PROFILE_DIR;
  }
  // 保留原有 Windows 专用路径向后兼容
  const legacyWindowsPath = 'D:\\ChatGPT-Brain-Bridge\\chrome-profile';
  if (process.platform === 'win32' && fs.existsSync(legacyWindowsPath)) {
    return legacyWindowsPath;
  }
  return path.join(os.homedir(), '.antigravity-with-chatgpt', 'chrome-profile');
}

const PROFILE_DIR = resolveProfileDir();
const DEBUG_PORT = Number(process.env.CHATGPT_BRAIN_PORT || 9222);
const DEBUG_HOST = '127.0.0.1';
const HTTP_BASE = `http://${DEBUG_HOST}:${DEBUG_PORT}`;
const DEFAULT_TARGET_URL = 'https://chatgpt.com/';

const CHROME_PATHS = [
  // Windows
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : null,
  process.env.PROGRAMFILES
    ? path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
    : null,
  // macOS (Darwin)
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
].filter(Boolean);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(`[brain-transport] ${a.join(' ')}\n`);
const warn = (...a) => process.stderr.write(`[brain-transport][warn] ${a.join(' ')}\n`);

export function findChrome() {
  if (process.env.CHATGPT_BRAIN_CHROME_PATH && fs.existsSync(process.env.CHATGPT_BRAIN_CHROME_PATH)) {
    return process.env.CHATGPT_BRAIN_CHROME_PATH;
  }
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  return CHROME_PATHS.find((p) => fs.existsSync(p)) || null;
}

// ---------------------------------------------------------------------------
// DOM Selector Tables & Scripts
// ---------------------------------------------------------------------------

const COMPOSER_SELECTORS = [
  '#prompt-textarea',
  'div[contenteditable="true"]#prompt-textarea',
  'textarea#prompt-textarea',
  'div#prompt-textarea',
  'div.ProseMirror[contenteditable="true"]#prompt-textarea',
  'div[contenteditable="true"][data-placeholder]',
  'textarea[data-id="root"]',
  'main form textarea',
  'form textarea',
  'main form [contenteditable="true"]',
];

const SEND_BUTTON_SELECTORS = [
  'button[data-testid="send-button"]',
  'button#composer-submit-button',
  'button[data-testid="composer-send-button"]',
  'button[aria-label="Send prompt"]',
  'button[aria-label="Send message"]',
  'button[aria-label*="Send" i]',
  'button[aria-label*="发送"]',
  'form button[type="submit"]',
  'button[data-testid="fruitjuice-send-button"]',
];

const STOP_BUTTON_SELECTORS = [
  'button[data-testid="stop-button"]',
  'button[data-testid="composer-stop-button"]',
  'button[aria-label="Stop streaming"]',
  'button[aria-label*="Stop" i]',
  'button[aria-label*="停止"]',
  'button[aria-label*="停用"]',
];

const ASSISTANT_SELECTORS = [
  '[data-message-author-role="assistant"]',
  'div.agent-turn',
  '[data-testid^="conversation-turn"][data-turn="assistant"]',
  'article[data-turn="assistant"]',
  '.markdown.prose',
  '.markdown',
];

const LOGIN_HINT_SELECTORS = [
  'button[data-testid="login-button"]',
  'a[href*="/auth/login"]',
  'a[href*="auth/login"]',
  'button[data-testid="signup-button"]',
  'button[data-testid="login-button-header"]',
  'a[data-testid="login-button"]',
  '[data-testid="welcome-login-button"]',
];

const PRELUDE = `
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    try {
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const s = getComputedStyle(el);
      if (s.visibility === 'hidden' || s.display === 'none' || s.opacity === '0') return false;
      return (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0);
    } catch (e) { return false; }
  };
  const pickVisible = (selectors) => {
    for (let i = 0; i < selectors.length; i++) {
      const sel = selectors[i];
      let nodes = [];
      try { nodes = Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { continue; }
      for (let j = nodes.length - 1; j >= 0; j--) {
        if (isVisible(nodes[j])) return { el: nodes[j], sel: sel };
      }
    }
    return null;
  };
  const hashOf = (s) => {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return h;
  };
  const textOfTurn = (el, fast = false) => {
    if (!el) return '';
    let target = el;
    try {
      const md = el.querySelector('.markdown, .prose, [class*="markdown"]');
      if (md) target = md;
    } catch (e) {}
    if (fast) return (target.textContent || '').trim();
    return ((target.innerText || target.textContent || '') + '').trim();
  };
  const extractComposerText = (el) => {
    if (!el) return '';
    const isTextarea = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    if (isTextarea) return el.value || '';
    const children = Array.prototype.slice.call(el.children);
    if (!children.length) {
      return (el.innerText || el.textContent || '').replace(new RegExp(String.fromCharCode(160), 'g'), ' ');
    }
    const lines = [];
    for (let i = 0; i < children.length; i++) {
      const node = children[i];
      if (node.getAttribute && node.getAttribute('data-empty-paragraph') === 'true') {
        lines.push('');
      } else {
        lines.push(node.textContent || '');
      }
    }
    return lines.join(String.fromCharCode(10)).replace(new RegExp(String.fromCharCode(160), 'g'), ' ');
  };
`;

const PROBE_JS = `(() => {
  ${PRELUDE}
  const COMPOSER = ${JSON.stringify(COMPOSER_SELECTORS)};
  const SEND = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
  const STOP = ${JSON.stringify(STOP_BUTTON_SELECTORS)};
  const ASSIST = ${JSON.stringify(ASSISTANT_SELECTORS)};
  const LOGIN = ${JSON.stringify(LOGIN_HINT_SELECTORS)};

  const composer = pickVisible(COMPOSER);
  const send = pickVisible(SEND);
  const stop = pickVisible(STOP);

  let turn = null;
  for (let i = 0; i < ASSIST.length; i++) {
    let nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(ASSIST[i])); } catch (e) { continue; }
    if (!nodes.length) continue;
    for (let j = nodes.length - 1; j >= 0; j--) {
      if (isVisible(nodes[j])) {
        turn = { el: nodes[j], sel: ASSIST[i], count: nodes.length };
        break;
      }
    }
    if (turn) break;
  }

  let lastText = '';
  let turnCount = 0;
  if (turn) { lastText = textOfTurn(turn.el, true); turnCount = turn.count; }

  let loginSignals = [];
  for (let i = 0; i < LOGIN.length; i++) {
    if (pickVisible([LOGIN[i]])) loginSignals.push(LOGIN[i]);
  }

  let composerEmpty = true;
  let composerSel = null;
  if (composer) {
    composerSel = composer.sel;
    const raw = extractComposerText(composer.el);
    composerEmpty = (raw || '').trim().length === 0;
  }

  let userCount = 0;
  try {
    const us = Array.prototype.slice.call(document.querySelectorAll('[data-message-author-role="user"]'));
    userCount = us.length;
  } catch (e) {}

  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    composer: { found: !!composer, sel: composerSel, empty: composerEmpty },
    sendButton: { found: !!send, sel: send ? send.sel : null, disabled: send ? (send.el.disabled || send.el.getAttribute('aria-disabled') === 'true') : true },
    stopButton: { found: !!stop, sel: stop ? stop.sel : null },
    assistant: { found: !!turn, sel: turn ? turn.sel : null, count: turnCount, len: lastText.length, hash: hashOf(lastText) },
    userTurn: { count: userCount },
    login: { signals: loginSignals },
  };
})()`;

const GET_LAST_TEXT_JS = `(() => {
${PRELUDE}
  const ASSIST = ${JSON.stringify(ASSISTANT_SELECTORS)};
  for (let i = 0; i < ASSIST.length; i++) {
    let nodes = [];
    try { nodes = Array.prototype.slice.call(document.querySelectorAll(ASSIST[i])); } catch (e) { continue; }
    const vis = nodes.filter(isVisible);
    if (vis.length) { return textOfTurn(vis[vis.length - 1]); }
  }
  return '';
})()`;

// ---------------------------------------------------------------------------
// Minimal CDP WebSocket Client
// ---------------------------------------------------------------------------

export class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
  }

  connect(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws;
      try {
        ws = new WebSocket(this.wsUrl);
      } catch (e) {
        return reject(new Error(`无法创建 WebSocket: ${e.message}`));
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch {}
        reject(new Error(`CDP WebSocket 连接超时 (${timeoutMs}ms): ${this.wsUrl}`));
      }, timeoutMs);

      ws.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.ws = ws;
        this.closed = false;
        resolve();
      };
      ws.onerror = (ev) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 连接失败: ${this.wsUrl}${ev && ev.message ? ' - ' + ev.message : ''}`));
      };
      ws.onclose = () => {
        this.closed = true;
        for (const [, p] of this.pending) p.reject(new Error('CDP 连接已关闭'));
        this.pending.clear();
      };
      ws.onmessage = (ev) => {
        try {
          const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
          const msg = JSON.parse(raw);
          if (msg.id == null) return;
          const p = this.pending.get(msg.id);
          if (!p) return;
          this.pending.delete(msg.id);
          clearTimeout(p.timer);
          if (msg.error) p.reject(new Error(`CDP ${p.method} 失败: ${msg.error.message || JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        } catch {}
      };
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (!this.ws || this.closed) return Promise.reject(new Error('CDP 未连接'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时 (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  async close(timeoutMs = 1500) {
    if (this.closed) return;
    this.closed = true;

    // 拒绝并清理所有等待中的 CDP 请求
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`CDP 连接已关闭: ${p.method}`));
    }
    this.pending.clear();

    // 事件驱动等待 WebSocket 真正断开，避免 libuv 竞态
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.ws.onclose = () => {
          clearTimeout(timer);
          resolve();
        };
        try { this.ws.close(); } catch { resolve(); }
      });
    }
    await sleep(20);
  }
}

export async function evaluate(cdp, expression, optionsOrTimeout = 20000) {
  const opts = typeof optionsOrTimeout === 'number'
    ? { timeoutMs: optionsOrTimeout, awaitPromise: false }
    : { timeoutMs: 20000, awaitPromise: false, ...optionsOrTimeout };

  const r = await cdp.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: Boolean(opts.awaitPromise),
    userGesture: true,
  }, opts.timeoutMs);
  if (r.exceptionDetails) {
    const msg = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'unknown';
    throw new Error(`页面脚本异常: ${msg}`);
  }
  return r.result ? r.result.value : undefined;
}

// ---------------------------------------------------------------------------
// Browser Management
// ---------------------------------------------------------------------------

export async function checkCdpStatus() {
  try {
    const version = await fetch(`${HTTP_BASE}/json/version`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    const list = await fetch(`${HTTP_BASE}/json/list`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json());
    const pages = list.filter((t) => t.type === 'page');
    const chatPages = pages.filter((t) => /(^|\.)chatgpt\.com$/.test((() => { try { return new URL(t.url).hostname; } catch { return ''; } })()));

    return {
      running: true,
      browser: version.Browser,
      port: DEBUG_PORT,
      pagesCount: pages.length,
      chatgptPages: chatPages.map((p) => ({ title: p.title, url: p.url, id: p.id })),
    };
  } catch (err) {
    return { running: false, error: err.message };
  }
}

async function ensureCdpReady(chromeExe, deadlineMs = null) {
  const status = await checkCdpStatus();
  if (status.running) return;

  log(`专用 Chrome 未运行，正在从 ${chromeExe} 启动...`);
  try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}

  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--remote-debugging-address=${DEBUG_HOST}`,
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE_DIR}`,
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--no-first-run',
    '--no-default-browser-check',
    DEFAULT_TARGET_URL,
  ];

  // 启动等待必须受总 deadline 约束：绝不无条件等待 45s
  const waitCap = remainingBudgetMs(deadlineMs, 45000);
  if (waitCap <= 0) {
    throw new Error('总截止时间预算已耗尽（在启动/等待专用 Chrome 之前），已中止以防突破宿主超时');
  }

  const child = spawn(chromeExe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + waitCap;
  while (Date.now() < deadline) {
    await sleep(600);
    const s = await checkCdpStatus();
    if (s.running) {
      log('专用 Chrome 已成功启动并就绪');
      return;
    }
  }
  throw new Error('等待专用 Chrome CDP 启动超时');
}

let boundTargetId = null;

export function getBoundTargetId() {
  return boundTargetId;
}

export function setBoundTargetId(id) {
  boundTargetId = id;
}

export function resetBoundTargetId() {
  boundTargetId = null;
}

export async function resolveTarget(preferredId = null, allowRebind = false, extra = {}) {
  const list = await fetch(`${HTTP_BASE}/json/list`).then((r) => r.json());
  const selection = selectTargetPage(list, boundTargetId, {
    preferredId,
    allowRebind,
    conversationUrl: extra && extra.conversationUrl ? extra.conversationUrl : null,
  });
  if (selection.target) {
    boundTargetId = selection.target.id;
    await fetch(`${HTTP_BASE}/json/activate/${boundTargetId}`).catch(() => {});
    return selection.target;
  }

  // 若无可用标签页，开启新标签页并认领
  log('新建 ChatGPT 标签页...');
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await fetch(`${HTTP_BASE}/json/new?${encodeURIComponent(DEFAULT_TARGET_URL)}`, { method });
      if (res.ok) {
        const created = await res.json();
        if (created.webSocketDebuggerUrl) {
          boundTargetId = created.id;
          await fetch(`${HTTP_BASE}/json/activate/${boundTargetId}`).catch(() => {});
          return created;
        }
      }
    } catch {}
  }

  throw new Error('无法定位或创建有效的 ChatGPT 标签页');
}

// ---------------------------------------------------------------------------
// Fast Text Injection & Send
// ---------------------------------------------------------------------------

export function getInjectionTimeout(text) {
  const bytes = typeof text === 'string' ? Buffer.byteLength(text, 'utf8') : 0;
  if (bytes <= 8 * 1024) return 20_000;
  if (bytes <= 32 * 1024) return 60_000;
  if (bytes <= 64 * 1024) return 90_000;
  if (bytes <= 128 * 1024) return 120_000;
  return 180_000;
}

export const PROBE_COMPOSER_JS = `(() => {
  ${PRELUDE}
  ${BROWSER_FINGERPRINT_SNIPPET}
  const COMPOSER = ${JSON.stringify(COMPOSER_SELECTORS)};
  const c = pickVisible(COMPOSER);
  if (!c) return { found: false, empty: true, length: 0, hash: '811c9dc5', isTextarea: false };

  const el = c.el;
  const isTextarea = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
  const content = extractComposerText(el);
  const trimmed = content.trim();
  const fp = computeFingerprint(content);

  return {
    found: true,
    sel: c.sel,
    isTextarea,
    empty: trimmed.length === 0,
    length: fp.length,
    hash: fp.hash,
  };
})()`;

export async function clearComposer(cdp, options = {}) {
  const budget = remainingBudgetMs(options.deadlineMs, 10000);
  if (budget <= 0) {
    warn('清空 Composer 被跳过：统一 deadline 预算已耗尽');
    return false;
  }
  try {
    await evaluate(cdp, `(() => {
    ${PRELUDE}
    const COMPOSER = ${JSON.stringify(COMPOSER_SELECTORS)};
    const c = pickVisible(COMPOSER);
    if (!c) return false;
    const el = c.el;
    el.focus();

    const isTextarea = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
    if (isTextarea) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }

    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('delete', false, null);
    } catch {}
    el.innerHTML = '<p><br></p>';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`, budget).catch(() => {});
  } catch (err) {
    warn('清空 Composer 失败:', err.message);
    return false;
  }
}

export async function insertTextReliable(cdp, text, options = {}) {
  const deadlineMs = options.deadlineMs;
  const normalizedText = typeof text === 'string' ? text.replace(/\r\n/g, '\n') : '';
  const bytes = Buffer.byteLength(normalizedText, 'utf8');
  const expected = computeFingerprint(normalizedText);
  const baseInjectionTimeout = getInjectionTimeout(normalizedText);
  // 注入超时本身也受统一 deadline 夹逼：剩余预算不足时按剩余时间注入，已耗尽则直接中止
  const timeoutMs = requireBudgetMs(deadlineMs, baseInjectionTimeout, '在注入 Prompt 之前');
  const b64 = Buffer.from(normalizedText, 'utf8').toString('base64');

  let timedOut = false;
  let verifiedAfterTimeout = false;
  let retryCount = 0;
  const t0 = performance.now();

  const runSingleShot = async (attemptTimeoutMs) => {
    return evaluate(cdp, `(() => {
      ${PRELUDE}
      ${BROWSER_FINGERPRINT_SNIPPET}
      const COMPOSER = ${JSON.stringify(COMPOSER_SELECTORS)};
      const c = pickVisible(COMPOSER);
      if (!c) return { error: 'no_composer' };
      const el = c.el;
      el.focus();

      const raw = atob(${JSON.stringify(b64)});
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
      const str = new TextDecoder('utf-8').decode(bytes);

      const isTextarea = el.tagName === 'TEXTAREA' || el.tagName === 'INPUT';
      if (isTextarea) {
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? el.value.length;
        if (typeof el.setRangeText === 'function') {
          el.setRangeText(str, start, end, 'end');
        } else {
          el.value = str;
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        const fp = computeFingerprint(el.value || '');
        return { ok: true, length: fp.length, hash: fp.hash, isTextarea: true };
      }

      try {
        document.execCommand('selectAll', false, null);
        document.execCommand('insertText', false, str);
      } catch {}

      let content = extractComposerText(el);
      if (content.length === 0 || !content.includes(str.slice(0, 30))) {
        const p = document.createElement('p');
        p.textContent = str;
        el.innerHTML = '';
        el.appendChild(p);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        content = extractComposerText(el);
      }
      try {
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: str }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } catch {}
      const fp = computeFingerprint(content);
      return { ok: true, length: fp.length, hash: fp.hash, isTextarea: false };
    })()`, attemptTimeoutMs);
  };

  // 尝试初次注入
  let singleShotRes = null;
  try {
    singleShotRes = await runSingleShot(timeoutMs);
  } catch (err) {
    if (err.message && err.message.includes('CDP 调用超时')) {
      timedOut = true;
    } else {
      throw err;
    }
  }

  let probe = null;
  let fingerprintMatched = false;

  if (singleShotRes && singleShotRes.ok && singleShotRes.length === expected.length && singleShotRes.hash === expected.hash) {
    fingerprintMatched = true;
    probe = singleShotRes;
  } else {
    // 若初次注入发生 CDP evaluate 超时或返回值异常，启动探针轮询比对指纹
    for (let i = 0; i < 3; i++) {
      const probeTimeout = remainingBudgetMs(deadlineMs, Math.min(timeoutMs, 25000));
      if (probeTimeout <= 0) break;
      probe = await evaluate(cdp, PROBE_COMPOSER_JS, probeTimeout).catch(() => null);
      if (probe && probe.found && probe.length === expected.length && probe.hash === expected.hash) {
        fingerprintMatched = true;
        break;
      }
      if (i < 2) await sleepWithin(500, deadlineMs);
    }
  }

  if (timedOut && fingerprintMatched) {
    verifiedAfterTimeout = true;
  }

  // 若指纹不匹配（部分写入、空或被污染）：清空后执行一次受控重试
  if (!fingerprintMatched) {
    retryCount = 1;
    warn(`注入指纹不匹配 (期望: len=${expected.length}, hash=${expected.hash}; 实际: len=${probe?.length}, hash=${probe?.hash})，清空并受控重试...`);
    await clearComposer(cdp, { deadlineMs });
    await sleepWithin(400, deadlineMs);

    const emptyProbeBudget = requireBudgetMs(deadlineMs, 10000, '在重试前校验 Composer 是否已清空');
    const emptyProbe = await evaluate(cdp, PROBE_COMPOSER_JS, emptyProbeBudget).catch(() => null);
    if (emptyProbe && !emptyProbe.empty) {
      throw new Error('清空 Composer 失败，中止注入重试以防 Prompt 污染');
    }

    let retryRes = null;
    const retryTimeoutMs = remainingBudgetMs(deadlineMs, baseInjectionTimeout);
    if (retryTimeoutMs <= 0) {
      throw new Error('总截止时间预算已耗尽（在注入重试之前），已中止以防突破宿主超时');
    }
    try {
      retryRes = await runSingleShot(retryTimeoutMs);
    } catch (err) {
      if (err.message && err.message.includes('CDP 调用超时')) {
        timedOut = true;
      }
    }

    if (retryRes && retryRes.ok && retryRes.length === expected.length && retryRes.hash === expected.hash) {
      fingerprintMatched = true;
      probe = retryRes;
    } else {
      for (let i = 0; i < 3; i++) {
        const probeTimeout = remainingBudgetMs(deadlineMs, Math.min(retryTimeoutMs, 25000));
        if (probeTimeout <= 0) break;
        probe = await evaluate(cdp, PROBE_COMPOSER_JS, probeTimeout).catch(() => null);
        if (probe && probe.found && probe.length === expected.length && probe.hash === expected.hash) {
          fingerprintMatched = true;
          break;
        }
        if (i < 2) await sleepWithin(500, deadlineMs);
      }
    }

    if (!fingerprintMatched) {
      const elapsedMs = Math.round(performance.now() - t0);
      const telemetry = `[brain-transport] inject strategy=execCommand chars=${expected.length} bytes=${bytes} timeoutMs=${timeoutMs} elapsedMs=${elapsedMs} timedOut=${timedOut} verifiedAfterTimeout=false fingerprintMatched=false retryCount=${retryCount}`;
      process.stderr.write(telemetry + '\n');
      throw new Error(`注入完整性校验失败 (期望: 长度 ${expected.length}, 哈希 ${expected.hash}; 实际: 长度 ${probe?.length}, 哈希 ${probe?.hash})`);
    }
  }

  const elapsedMs = Math.round(performance.now() - t0);
  const telemetry = `[brain-transport] inject strategy=execCommand chars=${expected.length} bytes=${bytes} timeoutMs=${timeoutMs} elapsedMs=${elapsedMs} timedOut=${timedOut} verifiedAfterTimeout=${verifiedAfterTimeout} fingerprintMatched=true retryCount=${retryCount}`;
  process.stderr.write(telemetry + '\n');

  return {
    status: 'inserted',
    expectedLength: expected.length,
    actualLength: probe.length,
    expectedHash: expected.hash,
    actualHash: probe.hash,
    timedOut,
    verifiedAfterTimeout,
    elapsedMs,
    retryCount,
  };
}

export const insertTextFast = insertTextReliable;

export const SUBMIT_STATUS = Object.freeze({
  NOT_SUBMITTED: 'NOT_SUBMITTED',
  SUBMITTED: 'SUBMITTED',
  UNKNOWN: 'UNKNOWN',
});

export async function submitMessageReliable(cdp, options = {}) {
  const opts = typeof options === 'number' ? { checkTimeoutMs: options } : (options || {});
  const checkTimeoutMs = opts.checkTimeoutMs || 10000;
  const deadlineMs = opts.deadlineMs;

  // 1. 强制获取发送前 User Turns 与流式状态作为强基准证据 (Mandatory Baseline)
  const baselineProbeScript = `(() => {
    const us = document.querySelectorAll('[data-message-author-role="user"]').length;
    const stop = document.querySelector('button[data-testid="stop-button"]') ||
                 document.querySelector('button[aria-label*="Stop" i]') ||
                 document.querySelector('button[aria-label*="停止"]');
    return {
      userTurns: us,
      isStreaming: Boolean(stop),
    };
  })()`;

  let baseline = null;
  try {
    baseline = await evaluate(cdp, baselineProbeScript, requireBudgetMs(deadlineMs, 5000, '在提交基准探测之前'));
  } catch (err) {
    // 基准探测失败：严禁盲目假定为 0（在已有对话页面中会产生严重假阳性），直接进入 UNKNOWN
    return {
      status: SUBMIT_STATUS.UNKNOWN,
      reason: 'baseline_probe_failed',
      error: err.message,
    };
  }

  if (!baseline || typeof baseline.userTurns !== 'number' || typeof baseline.isStreaming !== 'boolean') {
    return {
      status: SUBMIT_STATUS.UNKNOWN,
      reason: 'baseline_probe_invalid',
    };
  }

  // 2. 检查并调度发送动作 (Click vs Enter)
  const clickProbeScript = `(() => {
    ${PRELUDE}
    const SEND = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
    const b = pickVisible(SEND);
    if (!b) return { action: 'NOT_FOUND' };
    const disabled = Boolean(b.el.disabled || b.el.getAttribute('aria-disabled') === 'true');
    if (disabled) return { action: 'DISABLED' };
    try {
      b.el.click();
      return { action: 'CLICKED' };
    } catch (err) {
      return { action: 'CLICK_ERROR', error: err.message };
    }
  })()`;

  let clickRes = null;
  const deadline = stepDeadline(deadlineMs, 4000);
  while (Date.now() < deadline) {
    const clickBudget = remainingBudgetMs(deadlineMs, 3000);
    if (clickBudget <= 0) break;
    try {
      clickRes = await evaluate(cdp, clickProbeScript, clickBudget);
      if (clickRes && clickRes.action === 'CLICKED') {
        break;
      }
    } catch (err) {
      clickRes = { action: 'CLICK_UNKNOWN', error: err.message };
      break;
    }
    await sleepWithin(250, deadlineMs);
  }

  let enterDispatched = false;
  if (!clickRes || clickRes.action === 'NOT_FOUND') {
    // 发送按钮确不存在，回退 Enter 键
    const keyBudget = remainingBudgetMs(deadlineMs, 10000);
    if (keyBudget <= 0) {
      return {
        status: SUBMIT_STATUS.NOT_SUBMITTED,
        reason: 'budget_exhausted_before_enter',
        beforeUserTurns: baseline.userTurns,
      };
    }
    try {
      const base = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, code: 'Enter', key: 'Enter' };
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: '\r', unmodifiedText: '\r' }, keyBudget);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, remainingBudgetMs(deadlineMs, 10000) || keyBudget);
      enterDispatched = true;
    } catch (err) {
      return {
        status: SUBMIT_STATUS.NOT_SUBMITTED,
        reason: 'dispatch_enter_failed',
        error: err.message,
        beforeUserTurns: baseline.userTurns,
      };
    }
  } else if (clickRes.action === 'DISABLED') {
    // 发送按钮明确为禁用状态（如输入框为空或未就绪），严禁回车，明确返回 NOT_SUBMITTED
    return {
      status: SUBMIT_STATUS.NOT_SUBMITTED,
      reason: 'send_button_disabled',
      beforeUserTurns: baseline.userTurns,
    };
  }
  // 若 clickRes.action 为 'CLICK_UNKNOWN' 或 'CLICK_ERROR'，严禁盲目发送 Enter（防双重提交），直接通过后续收据验证

  // 3. 强收据轮询验证 (User turn 计数递增 或 流式边沿触发)
  const checkDeadline = stepDeadline(deadlineMs, checkTimeoutMs);
  while (Date.now() < checkDeadline) {
    await sleepWithin(300, deadlineMs);
    const receiptBudget = remainingBudgetMs(deadlineMs, 4000);
    if (receiptBudget <= 0) break;
    const receipt = await evaluate(cdp, baselineProbeScript, receiptBudget).catch(() => null);

    if (receipt && typeof receipt.userTurns === 'number') {
      // 强收据 1：User Turns 计数绝对递增
      if (receipt.userTurns > baseline.userTurns) {
        return {
          status: SUBMIT_STATUS.SUBMITTED,
          beforeUserTurns: baseline.userTurns,
          afterUserTurns: receipt.userTurns,
          method: clickRes?.action === 'CLICKED' ? 'click' : (enterDispatched ? 'enter' : 'click_fallback'),
        };
      }
      // 强收据 2：流式状态边沿触发 (必须从 false 跃迁至 true，排除前一条遗留流式响应)
      if (!baseline.isStreaming && receipt.isStreaming) {
        return {
          status: SUBMIT_STATUS.SUBMITTED,
          beforeUserTurns: baseline.userTurns,
          afterUserTurns: receipt.userTurns,
          streamingTransition: true,
          method: clickRes?.action === 'CLICKED' ? 'click' : (enterDispatched ? 'enter' : 'click_fallback'),
        };
      }
    }
  }

  // 4. 超时未确认强收据 -> UNKNOWN 状态，严禁自动重试
  return {
    status: SUBMIT_STATUS.UNKNOWN,
    beforeUserTurns: baseline.userTurns,
    reason: 'receipt_timeout',
    clickAction: clickRes?.action || 'NONE',
    enterDispatched,
  };
}

export const submitMessage = submitMessageReliable;

/**
 * 对 UNKNOWN 提交状态进行 fail-closed 强校验
 * @param {object} cdp
 * @param {object} submitReceipt
 * @param {number} beforeTurns
 * @returns {Promise<object>}
 */
export async function verifyUnknownReceiptOrThrow(cdp, submitReceipt, beforeTurns, options = {}) {
  const deadlineMs = options.deadlineMs;

  if (!submitReceipt || typeof submitReceipt !== 'object') {
    throw new Error('提交消息状态未知 (UNKNOWN): submitReceipt 必须为非空对象，立即中止以防重复提交');
  }

  if (submitReceipt.reason === 'baseline_probe_failed' || submitReceipt.reason === 'baseline_probe_invalid') {
    throw new Error(`提交基准获取失败 (UNKNOWN/${submitReceipt.reason})：无法确立确定性状态基准，立即中止以防重复提交`);
  }

  // 严格基准有效性校验：beforeUserTurns 必须为非负整数，缺少或非法时立即 fail-closed 抛错
  if (!Number.isInteger(submitReceipt.beforeUserTurns) || submitReceipt.beforeUserTurns < 0) {
    throw new Error(`提交消息状态未知 (UNKNOWN): submitReceipt 缺少合法的 user-turn 基准计数，立即中止以防重复提交`);
  }

  const probeBudget = requireBudgetMs(deadlineMs, 3000, '在 UNKNOWN 收据复核之前');
  const p = await evaluate(cdp, PROBE_JS, probeBudget).catch(() => null);
  const userTurns = p?.userTurn?.count ?? p?.userTurns ?? 0;
  const beforeUserTurns = submitReceipt.beforeUserTurns;

  // 因果性强收据：必须有当前会话的 User Turn 实际增加证据，绝不能单独由 Assistant Turn 替代
  if (!p || userTurns <= beforeUserTurns) {
    throw new Error(`提交消息状态未知 (UNKNOWN/${submitReceipt.reason || 'timeout'})：未能在时限内获取 User Turn 递增因果证据 (baseline: ${beforeUserTurns}, current: ${userTurns})，已中止以防重复提交`);
  }
  return p;
}

/**
 * 等待 Composer 加载稳定（连续 2 次探针命中）
 * @param {object} cdp
 * @param {number} [absoluteDeadlineMs] 统一绝对截止时间戳；缺省时退化为 30s 相对预算
 * @returns {Promise<object>}
 */
async function waitForComposer(cdp, absoluteDeadlineMs) {
  const deadline = (typeof absoluteDeadlineMs === 'number' && Number.isFinite(absoluteDeadlineMs))
    ? absoluteDeadlineMs
    : (Date.now() + 30000);
  let hits = 0;
  while (Date.now() < deadline) {
    const probeBudget = remainingBudgetMs(deadline, 12000);
    if (probeBudget <= 0) break;
    try {
      const p = await evaluate(cdp, PROBE_JS, probeBudget);
      if (p && p.composer && p.composer.found) {
        hits++;
        if (hits >= 2) return p;
      } else {
        hits = 0;
      }
    } catch (err) {
      warn('waitForComposer probe error:', err.message);
    }
    if ((await sleepWithin(600, deadline)) === 0) break;
  }
  throw new Error('等待 ChatGPT 输入框加载稳定超时（或总截止时间预算已耗尽）');
}

// ---------------------------------------------------------------------------
// High-Level Transport Entry
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Concurrency & Mutex (Single-flight Serialization per Target)
// ---------------------------------------------------------------------------

class AsyncMutex {
  constructor() {
    this._queue = Promise.resolve();
  }

  runExclusive(fn) {
    let release;
    const next = new Promise((resolve) => { release = resolve; });
    const current = this._queue;
    this._queue = this._queue.then(() => next, () => next);
    return current.then(() => fn()).finally(() => release());
  }
}

const cdpMutex = new AsyncMutex();

export async function waitForStreamingCompletion(cdp, options = {}) {
  const deadlineMs = typeof options.deadlineMs === 'number'
    ? options.deadlineMs
    : (Date.now() + (typeof options.timeoutMs === 'number' ? options.timeoutMs : 150000));
  const beforeTurns = typeof options.beforeTurns === 'number' ? options.beforeTurns : 0;
  const expectedTurn = options.expectedTurn;
  const targetUrl = options.targetUrl || DEFAULT_TARGET_URL;
  const expectedConversationUrl = options.expectedConversationUrl || null;
  const targetId = options.targetId || null;
  const safeTimeout = options.safeTimeout !== false;

  const SAFETY_MARGIN_MS = DEFAULT_SAFETY_MARGIN_MS;
  let lastHash = 0;
  let lastLen = 0;
  let stableHits = 0;
  const minRequiredTurns = typeof expectedTurn === 'number' ? expectedTurn : (beforeTurns + 1);

  // -------------------------------------------------------------------------
  // 会话身份状态机：UNBOUND_ROOT --(首次观测到具体 /c/<id>)--> PINNED(/c/<id>)
  // 一旦锁定，之后一律严格比较（`/` 不再兼容任何会话），彻底封死
  // `/ → /c/A → /c/B` 的 wildcard 漏判。
  // 注意：新会话提交后 SPA 会短暂停留在客户端临时身份 `/c/WEB:<uuid>`，
  // 该形态没有持久身份，既不参与锁定，也不能当作恢复凭证。
  // -------------------------------------------------------------------------
  let pinnedConversationUrl = isPinnableConversation(expectedConversationUrl)
    ? canonicalizeConversationUrl(expectedConversationUrl)
    : null;

  const observeIdentity = (currentUrl) => {
    if (!currentUrl || typeof currentUrl !== 'string') return;
    if (pinnedConversationUrl) {
      if (!isSameConversationStrict(currentUrl, pinnedConversationUrl)) {
        throw new Error(
          `会话身份校验失败: 已锁定会话为 ${pinnedConversationUrl}，但页面当前为 ${canonicalizeConversationUrl(currentUrl)}`
        );
      }
      return;
    }
    if (isPinnableConversation(currentUrl)) {
      // 首次观测到具体会话 → 立刻升级锁定，并作为恢复凭证向上返回
      pinnedConversationUrl = canonicalizeConversationUrl(currentUrl);
    }
  };

  // 恢复凭证（P1）：只有 durable `/c/<id>` 才能作为 conversationUrl 返回；
  // 停留在 `/` 或临时 `/c/WEB:<uuid>` 时必须返回 null，由 targetId 兜底恢复身份。
  const durableConversationUrl = () => {
    if (pinnedConversationUrl) return pinnedConversationUrl;
    const candidate = canonicalizeConversationUrl(targetUrl);
    return isPinnableConversation(candidate) ? candidate : null;
  };
  const displayUrl = () => pinnedConversationUrl || canonicalizeConversationUrl(targetUrl) || targetUrl;
  const stepBudget = (capMs, marginMs = 0) => remainingBudgetMs(deadlineMs, capMs, marginMs);

  while (stepBudget(1, SAFETY_MARGIN_MS) > 0) {
    const probeTimeout = stepBudget(5000, SAFETY_MARGIN_MS);
    if (probeTimeout <= 0) break;

    const p = await evaluate(cdp, PROBE_JS, probeTimeout).catch(() => null);
    if (!p) {
      await sleep(400);
      continue;
    }

    // 每轮都观测一次身份（涵盖 root → /c/<id> 的 SPA 跃迁锁定）
    observeIdentity(p.url);

    const isStreaming = Boolean(p.stopButton && p.stopButton.found);

    if (!isStreaming && p.assistant && p.assistant.count >= minRequiredTurns && p.assistant.len > 0) {
      if (p.assistant.hash === lastHash && p.assistant.len === lastLen) {
        stableHits++;
      } else {
        lastHash = p.assistant.hash;
        lastLen = p.assistant.len;
        stableHits = 0;
      }

      if (stableHits >= 2) {
        const quietBudget = stepBudget(2500, SAFETY_MARGIN_MS);
        if (quietBudget <= 0) break;
        const quietTimeout = Math.max(100, quietBudget);

        const quiet = await evaluate(cdp, `new Promise((resolve) => {
          let t = setTimeout(() => resolve(true), 350);
          const obs = new MutationObserver(() => {
            clearTimeout(t);
            t = setTimeout(() => { obs.disconnect(); resolve(true); }, 350);
          });
          obs.observe(document.body, { childList: true, subtree: true, characterData: true });
          setTimeout(() => { obs.disconnect(); resolve(false); }, ${quietTimeout});
        })`, { timeoutMs: quietTimeout + 500, awaitPromise: true }).catch(() => false);

        if (quiet) {
          // 返回文本前再次读取 live location.href：既做 TOCTOU 拦截，也完成身份升级锁定
          const hrefBudget = stepBudget(2000, SAFETY_MARGIN_MS);
          if (hrefBudget <= 0) break;
          const liveHref = await evaluate(cdp, 'location.href', hrefBudget).catch(() => '');
          if (liveHref) observeIdentity(liveHref);

          const fetchBudget = stepBudget(10000, SAFETY_MARGIN_MS);
          if (fetchBudget <= 0) break;
          const text = await evaluate(cdp, GET_LAST_TEXT_JS, fetchBudget).catch(() => '');
          if (text && text.trim()) {
            return {
              ok: true,
              inProgress: false,
              text: text.trim(),
              url: displayUrl(),
              conversationUrl: durableConversationUrl(),
              targetId,
              turns: p.assistant.count,
            };
          }
        }
      }
    } else {
      stableHits = 0;
    }

    await sleep(400);
  }

  // -------------------------------------------------------------------------
  // 收尾：预算严格单调递减，绝不借用额外时间。
  // deadline 已耗尽时一个 CDP evaluate 都不再执行。
  // -------------------------------------------------------------------------
  let tailBudget = Math.max(0, deadlineMs - Date.now());
  let finalProbe = null;
  if (tailBudget > 0) {
    finalProbe = await evaluate(cdp, PROBE_JS, Math.min(2000, tailBudget)).catch(() => null);
    observeIdentity(finalProbe?.url);
  }

  const stillStreaming = Boolean(finalProbe?.stopButton && finalProbe.stopButton.found);
  let partialText = '';

  tailBudget = Math.max(0, deadlineMs - Date.now());
  if (tailBudget > 0 && finalProbe?.assistant?.len > 0 && finalProbe.assistant.count >= minRequiredTurns) {
    partialText = await evaluate(cdp, GET_LAST_TEXT_JS, Math.min(3000, tailBudget)).catch(() => '');
  }

  if (safeTimeout) {
    return buildInProgressResult({
      text: partialText || '',
      turns: finalProbe?.assistant?.count || beforeTurns,
      expectedTurn: minRequiredTurns,
      url: displayUrl(),
      conversationUrl: durableConversationUrl(),
      targetId,
      isStreaming: stillStreaming,
      message: stillStreaming
        ? 'ChatGPT 正在深度推理与生成长回复中。已安全返回以避免触发 MCP 客户端 3 分钟超时限制。'
        : 'ChatGPT 生成仍在处理中。',
    });
  }

  throw new Error(`等待 ChatGPT 生成超时`);
}

export async function fetchLatestResponse(options = {}) {
  return cdpMutex.runExclusive(() => _fetchLatestResponseInternal(options));
}

async function _fetchLatestResponseInternal({ timeoutS = 150, deadlineMs: externalDeadlineMs, targetId, expectedTurn, conversationUrl, safeTimeout = true } = {}) {
  // 绝对截止时间：优先使用上层（MCP / orchestrator）透传的同一条 deadline
  const deadlineMs = typeof externalDeadlineMs === 'number' ? externalDeadlineMs : (Date.now() + timeoutS * 1000);

  const chromeExe = findChrome();
  if (!chromeExe) throw new Error('未在常用路径找到 Google Chrome 可执行文件');

  await ensureCdpReady(chromeExe, deadlineMs);

  // 提供 conversationUrl 时按规范化会话身份在多标签页中精确定位（绝不"取第一个标签再靠 guard 兜底"）
  const target = await resolveTarget(targetId, Boolean(conversationUrl), { conversationUrl });

  const connectBudget = remainingBudgetMs(deadlineMs, 15000);
  if (connectBudget <= 0) {
    throw new Error('总截止时间预算已耗尽（在连接 CDP 之前），已中止以防突破宿主超时');
  }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect(connectBudget);

  try {
    const enableBudget = remainingBudgetMs(deadlineMs, 10000);
    if (enableBudget > 0) {
      await cdp.send('Runtime.enable', {}, enableBudget).catch(() => {});
      await cdp.send('Page.enable', {}, remainingBudgetMs(deadlineMs, 10000)).catch(() => {});
    }

    // 连接后实时校验 live location.href (彻底消除 TOCTOU 竞态)
    const hrefBudget = remainingBudgetMs(deadlineMs, 5000);
    const liveUrl = hrefBudget > 0
      ? await evaluate(cdp, 'location.href', hrefBudget).catch(() => target.url)
      : target.url;

    // 仅当凭证是"可锁定"的具体会话身份时才做严格校验：
    // 根路径 / 与临时 /c/WEB:<uuid> 不具备可比性（此时依赖标签绑定 + 后续轮询观测）
    if (conversationUrl && typeof conversationUrl === 'string' && isPinnableConversation(conversationUrl)) {
      if (!isSameConversationStrict(liveUrl, conversationUrl)) {
        const currentNorm = canonicalizeConversationUrl(liveUrl);
        const expectedNorm = canonicalizeConversationUrl(conversationUrl);
        throw new Error(`会话身份校验失败: 当前标签页 URL (${currentNorm}) 与请求的会话 (${expectedNorm}) 不匹配`);
      }
    }

    const identityUrl = canonicalizeConversationUrl(liveUrl) || liveUrl;
    // P1：只有 durable `/c/<id>` 才能作为 conversationUrl 凭证；`/` 或临时 WEB: 身份返回 null
    const durableUrl = isPinnableConversation(liveUrl) ? identityUrl : null;

    const probeBudget = remainingBudgetMs(deadlineMs, 5000);
    const p = probeBudget > 0 ? await evaluate(cdp, PROBE_JS, probeBudget).catch(() => null) : null;

    if (!p || !p.assistant || p.assistant.count === 0) {
      return await waitForStreamingCompletion(cdp, {
        deadlineMs,
        beforeTurns: 0,
        expectedTurn: expectedTurn || 1,
        targetUrl: liveUrl,
        expectedConversationUrl: conversationUrl || liveUrl,
        targetId: target.id,
        safeTimeout,
      });
    }

    const minRequiredTurns = typeof expectedTurn === 'number' ? expectedTurn : p.assistant.count;
    const isStreaming = Boolean(p.stopButton && p.stopButton.found);
    if (!isStreaming && p.assistant.count >= minRequiredTurns && p.assistant.len > 0) {
      const textBudget = remainingBudgetMs(deadlineMs, 10000);
      const text = textBudget > 0 ? await evaluate(cdp, GET_LAST_TEXT_JS, textBudget).catch(() => '') : '';
      if (text && text.trim()) {
        return {
          ok: true,
          inProgress: false,
          text: text.trim(),
          url: identityUrl,
          // 恢复凭证必须升级为具体会话身份；不可持久化时为 null（由 targetId 兜底）
          conversationUrl: durableUrl,
          targetId: target.id,
          turns: p.assistant.count,
        };
      }
    }

    // 仍在流式传输或需等待稳定
    return await waitForStreamingCompletion(cdp, {
      deadlineMs,
      beforeTurns: p.assistant.count > 1 ? p.assistant.count - 1 : 0,
      expectedTurn: minRequiredTurns,
      targetUrl: liveUrl,
      expectedConversationUrl: conversationUrl || liveUrl,
      targetId: target.id,
      safeTimeout,
    });
  } finally {
    await cdp.close();
  }
}

export async function sendPromptViaCdp(options) {
  return cdpMutex.runExclusive(() => _sendPromptInternal(options));
}

async function _sendPromptInternal({ prompt, mode = 'reuse', timeoutS = 150, deadlineMs: externalDeadlineMs, targetId, safeTimeout = true } = {}) {
  // 绝对截止时间：优先使用上层（MCP / orchestrator）透传的同一条 deadline，
  // 否则才以本层为锚点创建（保持独立调用时的向后兼容）。
  const deadlineMs = typeof externalDeadlineMs === 'number' ? externalDeadlineMs : (Date.now() + timeoutS * 1000);
  const SAFETY_MARGIN_MS = DEFAULT_SAFETY_MARGIN_MS;
  const stepBudget = (capMs, marginMs = 0) => remainingBudgetMs(deadlineMs, capMs, marginMs);

  const chromeExe = findChrome();
  if (!chromeExe) throw new Error('未在常用路径找到 Google Chrome 可执行文件');

  await ensureCdpReady(chromeExe, deadlineMs);

  // fail-closed: 普通发送严禁静默重绑
  const target = await resolveTarget(targetId, mode === 'new');

  const connectBudget = stepBudget(15000);
  if (connectBudget <= 0) {
    throw new Error('总截止时间预算已耗尽（在连接 CDP 之前），已中止以防突破宿主超时');
  }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect(connectBudget);

  try {
    const enableBudget = stepBudget(10000);
    if (enableBudget > 0) {
      await cdp.send('Runtime.enable', {}, enableBudget).catch(() => {});
      await cdp.send('Page.enable', {}, stepBudget(10000)).catch(() => {});
    }

    const composerWaitDeadline = Math.min(Date.now() + 25000, deadlineMs - SAFETY_MARGIN_MS);
    if (composerWaitDeadline <= Date.now()) {
      throw new Error('总截止时间预算已耗尽（在定位输入框之前），已中止以防突破宿主超时');
    }
    let p = await waitForComposer(cdp, composerWaitDeadline);

    // 新会话导航策略
    if (mode === 'new') {
      const isClean = p.url === DEFAULT_TARGET_URL || (p.url.startsWith(DEFAULT_TARGET_URL) && (!p.assistant?.found || p.assistant.count === 0));
      if (!isClean) {
        log('导航到全新会话页面...');
        // 优先尝试 SPA 内部平滑跳转（避免销毁 WebSocket）
        const clickBudget = stepBudget(3000, SAFETY_MARGIN_MS);
        const clickedNew = clickBudget > 0
          ? await evaluate(cdp, `(() => {
          const btn = document.querySelector('a[href="/"], button[data-testid="create-new-chat-button"], a[aria-label*="New chat" i], a[aria-label*="新聊天"]');
          if (btn) { btn.click(); return true; }
          window.history.pushState({}, '', '/');
          return false;
        })()`, clickBudget).catch(() => false)
          : false;

        if (!clickedNew) {
          await cdp.send('Page.navigate', { url: DEFAULT_TARGET_URL }, stepBudget(20000)).catch(() => {});
        }
        await sleep(1200);

        // 若 WebSocket 在页面跳转中重置，自动重连新页面 WebSocket
        if (cdp.closed || !cdp.ws || cdp.ws.readyState !== WebSocket.OPEN) {
          log('CDP 正在重连新页面 WebSocket...');
          const freshTarget = await resolveTarget(targetId, true);
          cdp.wsUrl = freshTarget.webSocketDebuggerUrl;
          const reconnectBudget = stepBudget(15000);
          if (reconnectBudget <= 0) {
            throw new Error('总截止时间预算已耗尽（在重连 CDP 之前），已中止以防突破宿主超时');
          }
          await cdp.connect(reconnectBudget);
          const reEnableBudget = stepBudget(10000);
          if (reEnableBudget > 0) {
            await cdp.send('Runtime.enable', {}, reEnableBudget).catch(() => {});
            await cdp.send('Page.enable', {}, stepBudget(10000)).catch(() => {});
          }
        }

        const navWaitDeadline = Math.min(Date.now() + 30000, deadlineMs - SAFETY_MARGIN_MS);
        if (navWaitDeadline <= Date.now()) {
          throw new Error('总截止时间预算已耗尽（在等待新会话输入框之前），已中止以防突破宿主超时');
        }
        p = await waitForComposer(cdp, navWaitDeadline);
      }
    }

    // 清理输入框残留
    if (!p.composer.empty) {
      await clearComposer(cdp, { deadlineMs });
      await sleepWithin(150, deadlineMs);
    }

    const beforeTurns = p.assistant.found ? p.assistant.count : 0;

    // 可靠注入与强收据提交（同一条 deadlineMs 预算贯穿到底）
    await insertTextReliable(cdp, prompt, { deadlineMs });
    const submitReceipt = await submitMessageReliable(cdp, { deadlineMs });

    if (submitReceipt.status === SUBMIT_STATUS.NOT_SUBMITTED) {
      throw new Error(`提交消息未执行 (NOT_SUBMITTED): ${submitReceipt.reason || '发送动作未触发'}`);
    }

    if (submitReceipt.status === SUBMIT_STATUS.UNKNOWN) {
      p = await verifyUnknownReceiptOrThrow(cdp, submitReceipt, beforeTurns, { deadlineMs });
    }

    const hrefBudget = stepBudget(3000);
    const liveUrl = hrefBudget > 0
      ? await evaluate(cdp, 'location.href', hrefBudget).catch(() => target.url)
      : target.url;

    // 提交已确认，直接进入流式与稳定等待（由同一条 deadlineMs 严格单调递减统一预算保护）
    return await waitForStreamingCompletion(cdp, {
      deadlineMs,
      beforeTurns,
      targetUrl: liveUrl || target.url,
      expectedConversationUrl: liveUrl || target.url,
      targetId: target.id,
      safeTimeout,
    });
  } finally {
    await cdp.close();
  }
}
