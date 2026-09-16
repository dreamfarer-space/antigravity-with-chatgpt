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
  'div.ProseMirror[contenteditable="true"]',
  'form [contenteditable="true"]',
  '[contenteditable="true"][translate="no"]',
  '[contenteditable="true"][data-lexical-editor="true"]',
  'div[contenteditable="true"][id^="prompt"]',
  'main form textarea',
  'form textarea',
  'textarea#prompt-textarea',
  'main [contenteditable="true"]',
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
    if (!el) return false;
    try {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
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
  const textOfTurn = (el) => {
    if (!el) return '';
    let target = el;
    try {
      const md = el.querySelector('.markdown, .prose, [class*="markdown"]');
      if (md) target = md;
    } catch (e) {}
    return ((target.innerText || target.textContent || '') + '').trim();
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
    const vis = nodes.filter(isVisible);
    if (vis.length) { turn = { el: vis[vis.length - 1], sel: ASSIST[i], count: vis.length }; break; }
  }

  let lastText = '';
  let turnCount = 0;
  if (turn) { lastText = textOfTurn(turn.el); turnCount = turn.count; }

  let loginSignals = [];
  for (let i = 0; i < LOGIN.length; i++) {
    if (pickVisible([LOGIN[i]])) loginSignals.push(LOGIN[i]);
  }

  let composerEmpty = true;
  let composerSel = null;
  if (composer) {
    composerSel = composer.sel;
    const raw = (composer.el.value !== undefined && composer.el.value !== null)
      ? composer.el.value
      : (composer.el.innerText || composer.el.textContent || '');
    composerEmpty = (raw || '').trim().length === 0;
  }

  let userCount = 0;
  try {
    const us = Array.prototype.slice.call(document.querySelectorAll('[data-message-author-role="user"]')).filter(isVisible);
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

async function ensureCdpReady(chromeExe) {
  const status = await checkCdpStatus();
  if (status.running) return;

  log(`专用 Chrome 未运行，正在从 ${chromeExe} 启动...`);
  try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch {}

  const args = [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--remote-debugging-address=${DEBUG_HOST}`,
    '--remote-allow-origins=*',
    process.platform === 'win32' ? `--user-data-dir="${PROFILE_DIR}"` : `--user-data-dir=${PROFILE_DIR}`,
    DEFAULT_TARGET_URL,
  ];

  const child = process.platform === 'win32'
    ? spawn('cmd.exe', ['/c', 'start', '""', `"${chromeExe}"`, ...args], { detached: true, stdio: 'ignore' })
    : spawn(chromeExe, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const deadline = Date.now() + 45000;
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

async function resolveTarget(preferredId = null) {
  const list = await fetch(`${HTTP_BASE}/json/list`).then((r) => r.json());
  const pages = list.filter((t) => t.type === 'page');
  const cg = pages.filter((t) => /(^|\.)chatgpt\.com$/.test((() => { try { return new URL(t.url).hostname; } catch { return ''; } })()));

  // 1. 优先复用当前认领绑定的 targetId，防止多 ChatGPT 标签页时发生串号
  const candidateId = preferredId || boundTargetId;
  if (candidateId) {
    const bound = cg.find((t) => t.id === candidateId && t.webSocketDebuggerUrl);
    if (bound) {
      boundTargetId = bound.id;
      return bound;
    }
  }

  // 2. 若未绑定或原标签页已关闭，认领首个可用的 ChatGPT 标签页
  if (cg.length && cg[0].webSocketDebuggerUrl) {
    boundTargetId = cg[0].id;
    return cg[0];
  }

  // 3. 若无可用标签页，开启新标签页并认领
  log('新建 ChatGPT 标签页...');
  for (const method of ['PUT', 'GET']) {
    try {
      const res = await fetch(`${HTTP_BASE}/json/new?${encodeURIComponent(DEFAULT_TARGET_URL)}`, { method });
      if (res.ok) {
        const created = await res.json();
        if (created.webSocketDebuggerUrl) {
          boundTargetId = created.id;
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

async function clearComposer(cdp) {
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

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, '');
    if ((el.innerText || el.textContent || '').trim().length > 0) {
      el.innerHTML = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return true;
  })()`);
}

async function insertTextFast(cdp, text) {
  const b64 = Buffer.from(text, 'utf8').toString('base64');
  const inserted = await evaluate(cdp, `(() => {
    ${PRELUDE}
    const COMPOSER = ${JSON.stringify(COMPOSER_SELECTORS)};
    const c = pickVisible(COMPOSER);
    if (!c) return false;
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
      return (el.value || '').length > 0;
    }

    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);

    document.execCommand('insertText', false, str);
    const len = (el.innerText || el.textContent || '').length;
    if (len === 0) {
      el.textContent = str;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return (el.innerText || el.textContent || '').length > 0;
  })()`, 25000);

  if (!inserted) {
    // 降级回退
    await cdp.send('Input.insertText', { text }, 20000);
  }
}

async function submitMessage(cdp) {
  let clicked = false;
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    clicked = await evaluate(cdp, `(() => {
      ${PRELUDE}
      const SEND = ${JSON.stringify(SEND_BUTTON_SELECTORS)};
      const b = pickVisible(SEND);
      if (b && !b.el.disabled && b.el.getAttribute('aria-disabled') !== 'true') {
        b.el.click();
        return true;
      }
      return false;
    })()`).catch(() => false);
    if (clicked) break;
    await sleep(200);
  }

  if (!clicked) {
    // 回退到 Enter 键
    const base = { windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, code: 'Enter', key: 'Enter' };
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, text: '\r', unmodifiedText: '\r' }, 10000);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, 10000);
  }
}

async function waitForComposer(cdp, deadlineMs = 30000) {
  const deadline = Date.now() + deadlineMs;
  let hits = 0;
  while (Date.now() < deadline) {
    try {
      const p = await evaluate(cdp, PROBE_JS, 4000);
      if (p && p.composer && p.composer.found) {
        hits++;
        if (hits >= 2) return p;
      } else {
        hits = 0;
      }
    } catch {}
    await sleep(600);
  }
  throw new Error('等待 ChatGPT 输入框加载稳定超时');
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

export async function sendPromptViaCdp(options) {
  return cdpMutex.runExclusive(() => _sendPromptViaCdpInternal(options));
}

async function _sendPromptViaCdpInternal({ prompt, mode = 'reuse', timeoutS = 600, lockUrl, targetId }) {
  const chromeExe = findChrome();
  if (!chromeExe) throw new Error('未在常用路径找到 Google Chrome 可执行文件');

  await ensureCdpReady(chromeExe);

  const target = await resolveTarget(targetId);
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect(15000);

  try {
    await cdp.send('Runtime.enable', {}, 10000).catch(() => {});
    await cdp.send('Page.enable', {}, 10000).catch(() => {});

    let p = await waitForComposer(cdp, 25000);

    // 新会话导航策略
    if (mode === 'new') {
      const isClean = p.url.startsWith(DEFAULT_TARGET_URL) && (!p.assistant.found || p.assistant.count === 0);
      if (!isClean) {
        log('导航到全新会话页面...');
        await cdp.send('Page.navigate', { url: DEFAULT_TARGET_URL }, 20000);
        await sleep(1000);
        p = await waitForComposer(cdp, 30000);
      }
    }

    // 清理输入框残留
    if (!p.composer.empty) {
      await clearComposer(cdp);
      await sleep(150);
    }

    const beforeTurns = p.assistant.found ? p.assistant.count : 0;

    // 极速注入与发送
    await insertTextFast(cdp, prompt);
    await submitMessage(cdp);

    // 等待开始
    const startDeadline = Date.now() + 45000;
    let started = false;
    while (Date.now() < startDeadline) {
      p = await evaluate(cdp, PROBE_JS);
      if ((p.assistant.found && p.assistant.count > beforeTurns) || p.stopButton.found) {
        started = true;
        break;
      }
      await sleep(600);
    }

    if (!started) {
      throw new Error('发送后未检测到新的 ChatGPT 回复回合');
    }

    // 等待生成结束 (低延迟 MutationObserver quiet + stopButton + turns + content stability)
    const deadline = Date.now() + timeoutS * 1000;
    let lastHash = 0;
    let lastLen = 0;
    let stableHits = 0;

    while (Date.now() < deadline) {
      p = await evaluate(cdp, PROBE_JS);
      const isStreaming = p.stopButton.found;

      if (!isStreaming && p.assistant.count > beforeTurns && p.assistant.len > 0) {
        if (p.assistant.hash === lastHash && p.assistant.len === lastLen) {
          stableHits++;
        } else {
          lastHash = p.assistant.hash;
          lastLen = p.assistant.len;
          stableHits = 0;
        }

        if (stableHits >= 2) {
          const quiet = await evaluate(cdp, `new Promise((resolve) => {
            let t = setTimeout(() => resolve(true), 350);
            const obs = new MutationObserver(() => {
              clearTimeout(t);
              t = setTimeout(() => { obs.disconnect(); resolve(true); }, 350);
            });
            obs.observe(document.body, { childList: true, subtree: true, characterData: true });
            setTimeout(() => { obs.disconnect(); resolve(false); }, 1500);
          })`, { timeoutMs: 2500, awaitPromise: true }).catch(() => false);

          if (quiet) {
            const text = await evaluate(cdp, GET_LAST_TEXT_JS, 20000);
            if (text && text.trim()) {
              return {
                ok: true,
                text: text.trim(),
                url: target.url,
                turns: p.assistant.count,
              };
            }
          }
        }
      } else {
        stableHits = 0;
      }
      await sleep(600);
    }

    throw new Error(`等待 ChatGPT 生成超时 (${timeoutS}s)`);
  } finally {
    await cdp.close();
  }
}
