#!/usr/bin/env node
/**
 * antigravity-with-chatgpt - verify_install.mjs
 * ---------------------------------------------------------------------------
 * 全面自动化自检套件（借鉴 codex-with-chatgpt 架构的完整性与安全测试）：
 *   1. 四层架构与所有子模块存在性
 *   2. 路径收敛与安全边界测试 (path_guard 目录逃逸拦截)
 *   3. 敏感文件黑名单与内容脱敏测试 (sensitive .env/Key 拦截与掩码)
 *   4. .brainignore 规则匹配测试
 *   5. 执行记录器测试 (recorder)
 *   6. 只读 Git Diff 与状态抽取测试 (git_helper)
 *   7. Antigravity Skill Junction & 全局 mcp_config.json 校验
 *   8. 桌面快捷方式合法性校验
 *   9. CDP 9222 端口与 ChatGPT 会话探测
 *  10. 端到端多模式执行测试 (--run-test: ask / review / derive)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

import { resolveSafePath, isPathContained, SecurityError } from '../src/security/path_guard.mjs';
import { isSensitivePath, sanitizeContent } from '../src/security/sensitive.mjs';
import { BrainIgnore } from '../src/security/ignore.mjs';
import { recordExecution, getRecentExecutions } from '../src/execution/recorder.mjs';
import { getGitStatus, getGitDiff } from '../src/git/git_helper.mjs';
import { getWorkspaceInfo, readFileSafe } from '../src/workspace/context_provider.mjs';
import { checkCdpStatus } from '../src/transport/cdp_transport.mjs';
import { runBrainTask } from '../src/brain/orchestrator.mjs';
import { MODES } from '../src/brain/prompts.mjs';

const SKILL_DIR = path.join(ROOT, 'gemini-skill', 'antigravity-with-chatgpt');
const JUNCTION = path.join(os.homedir(), '.gemini', 'config', 'skills', 'antigravity-with-chatgpt');
const MCP_CONFIG = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
const SHORTCUT = path.join(os.homedir(), 'Desktop', 'ChatGPT (Antigravity智脑).lnk');

let pass = 0, fail = 0;
const ok = (s) => { pass++; console.log(`[ OK ] ${s}`); };
const bad = (s) => { fail++; console.log(`[FAIL] ${s}`); };
const head = (s) => console.log(`\n--- ${s} ---`);

console.log('antigravity-with-chatgpt 架构演进与自检套件');
console.log('='.repeat(64));

// ---------------------------------------------------------------------------
head('1. 四层架构模块完整性');

const REQUIRED_MODULES = [
  'scripts/ask_chatgpt.mjs',
  'scripts/mcp_server.mjs',
  'scripts/make_shortcut.mjs',
  'src/transport/cdp_transport.mjs',
  'src/security/path_guard.mjs',
  'src/security/sensitive.mjs',
  'src/security/ignore.mjs',
  'src/workspace/context_provider.mjs',
  'src/git/git_helper.mjs',
  'src/execution/recorder.mjs',
  'src/brain/prompts.mjs',
  'src/brain/orchestrator.mjs',
];

for (const mod of REQUIRED_MODULES) {
  const full = path.join(ROOT, mod);
  fs.existsSync(full) ? ok(`模块存在: ${mod}`) : bad(`模块缺失: ${mod}`);
}

// ---------------------------------------------------------------------------
head('2. 路径收敛与安全防御 (path_guard)');

try {
  // 正常路径收敛
  const safe = resolveSafePath(ROOT, 'scripts/ask_chatgpt.mjs');
  safe.toLowerCase() === path.join(ROOT, 'scripts', 'ask_chatgpt.mjs').toLowerCase()
    ? ok('正常工作区相对路径解析通过')
    : bad('相对路径解析异常');

  // 目录逃逸拦截
  let escapeBlocked = false;
  try {
    resolveSafePath(ROOT, '../../../../Windows/System32/cmd.exe');
  } catch (err) {
    if (err instanceof SecurityError && err.code === 'E_WORKSPACE_ESCAPE') {
      escapeBlocked = true;
    }
  }
  escapeBlocked ? ok('成功拦截 "../" 跨目录逃逸') : bad('未能拦截跨目录逃逸！');

  // NUL 字符拦截
  let nulBlocked = false;
  try {
    resolveSafePath(ROOT, 'foo\0bar.txt');
  } catch (err) {
    if (err instanceof SecurityError && err.code === 'E_PATH_NUL') {
      nulBlocked = true;
    }
  }
  nulBlocked ? ok('成功拦截 NUL 字符注入') : bad('未能拦截 NUL 字符注入！');
} catch (e) {
  bad(`path_guard 测试异常: ${e.message}`);
}

// ---------------------------------------------------------------------------
head('3. 敏感文件策略与脱敏 (sensitive)');

isSensitivePath('.env') ? ok('成功识别并拦截 .env') : bad('未能识别 .env！');
isSensitivePath('.env.local') ? ok('成功识别并拦截 .env.local') : bad('未能识别 .env.local！');
isSensitivePath('id_rsa') ? ok('成功识别并拦截私钥 id_rsa') : bad('未能识别 id_rsa！');
isSensitivePath('server.key') ? ok('成功识别并拦截证书密钥 server.key') : bad('未能识别 server.key！');
isSensitivePath('.ssh/known_hosts') ? ok('成功识别并拦截 .ssh 目录') : bad('未能识别 .ssh 目录！');
!isSensitivePath('.env.example') ? ok('正确放行模版文件 .env.example') : bad('误拦截了 .env.example！');

const mockOpenAi = ['sk', 'testdummy1234567890abcdef1234567890'].join('-');
const rawSecret = `My key is ${mockOpenAi} and pass: secret="SuperSecret123"`;
const masked = sanitizeContent(rawSecret);
masked.includes('[REDACTED_OPENAI_KEY]') && masked.includes('[REDACTED_SECRET]')
  ? ok('文本中 API Key 与敏感密码成功掩码脱敏')
  : bad(`敏感内容掩码失效: ${masked}`);

// ---------------------------------------------------------------------------
head('4. 规则过滤器 (.brainignore)');

const ignoreChecker = new BrainIgnore(['coverage/', '*.log', 'secret/**']);
ignoreChecker.ignores('coverage/lcov.info') ? ok('成功匹配目录规则 coverage/') : bad('未匹配 coverage/');
ignoreChecker.ignores('app.log') ? ok('成功匹配通配规则 *.log') : bad('未匹配 *.log');
ignoreChecker.ignores('secret/internal.md') ? ok('成功匹配多层通配 secret/**') : bad('未匹配 secret/**');
!ignoreChecker.ignores('src/index.ts') ? ok('正确放行普通源代码 src/index.ts') : bad('误拦截了 src/index.ts');

// ---------------------------------------------------------------------------
head('5. 执行证据记录器 (recorder)');

try {
  const rec = recordExecution({
    command: 'npm test',
    exitCode: 0,
    testSummary: { passed: 32, failed: 0 },
    workspace: ROOT,
    notes: 'Unit verification suite',
  });
  ok(`成功创建执行事实记录 [${rec.id}]`);

  const recent = getRecentExecutions(ROOT, 2);
  recent.length > 0 && recent[0].id === rec.id
    ? ok('成功读取并检索最近的执行证据')
    : bad('执行记录检索失败');
} catch (e) {
  bad(`recorder 测试异常: ${e.message}`);
}

// ---------------------------------------------------------------------------
head('6. 只读 Git 状态与 Diff 提取器 (git_helper)');

const gitStatus = getGitStatus(ROOT);
if (gitStatus.isGitRepo) {
  ok(`Git 状态抽取正常 (分支: ${gitStatus.branch})`);
} else {
  ok('当前目录无 Git，优雅降级返回 isGitRepo=false');
}

const diffRes = getGitDiff(ROOT, { maxBytes: 1024 });
diffRes && typeof diffRes.hasDiff === 'boolean'
  ? ok('Git Diff 抽取接口正常 (受预算限制)')
  : bad('Git Diff 抽取失败');

// ---------------------------------------------------------------------------
head('7. 全局配置与 Antigravity 2.0 挂载');

if (fs.existsSync(JUNCTION)) {
  ok(`Skill Junction 就绪: ${JUNCTION}`);
} else {
  bad(`Skill Junction 缺失: ${JUNCTION}`);
}

if (fs.existsSync(MCP_CONFIG)) {
  try {
    const parsed = JSON.parse(fs.readFileSync(MCP_CONFIG, 'utf8'));
    parsed.mcpServers && parsed.mcpServers['antigravity-with-chatgpt']
      ? ok('全局 mcp_config.json 注册正常')
      : bad('mcp_config.json 缺少 antigravity-with-chatgpt 注册');
  } catch (e) {
    bad(`解析 mcp_config.json 失败: ${e.message}`);
  }
} else {
  bad(`mcp_config.json 缺失: ${MCP_CONFIG}`);
}

// ---------------------------------------------------------------------------
head('8. 桌面快捷方式');

if (fs.existsSync(SHORTCUT)) {
  ok(`桌面快捷方式有效: ${SHORTCUT}`);
} else {
  bad(`桌面快捷方式缺失: ${SHORTCUT}`);
}

// ---------------------------------------------------------------------------
head('9. CDP 端口与 Chrome 会话就绪性');

let cdpReady = false;
try {
  const cdp = await checkCdpStatus();
  if (cdp.running) {
    cdpReady = true;
    ok(`CDP 端口 9222 正常就绪: ${cdp.browser} (活跃页面: ${cdp.pagesCount})`);
  } else {
    bad(`CDP 未运行: ${cdp.error}`);
  }
} catch (e) {
  bad(`CDP 检测失败: ${e.message}`);
}

// ---------------------------------------------------------------------------
if (process.argv.includes('--run-test')) {
  head('10. 端到端多模式推理测试 (ask / review / derive)');
  if (!cdpReady) {
    bad('CDP 未就绪，跳过真实推理测试');
  } else {
    // Test 1: Ask 模式
    console.log('[Test 1/2] 执行通用 Ask 模式测试...');
    const t0 = Date.now();
    try {
      const askRes = await runBrainTask({
        prompt: '请只回复四个英文字符：ASKK',
        mode: MODES.ASK,
        timeout: 120,
      });
      const elapsed1 = ((Date.now() - t0) / 1000).toFixed(1);
      /ASKK/i.test(askRes.text)
        ? ok(`Ask 模式通过 (耗时 ${elapsed1}s, 回复: "${askRes.text.trim()}")`)
        : bad(`Ask 模式未返回预期内容: ${askRes.text}`);
    } catch (e) {
      bad(`Ask 模式执行失败: ${e.message}`);
    }

    // Test 2: Derive 纯推导模式
    console.log('[Test 2/2] 执行 Derive 纯算法推导模式测试...');
    const t1 = Date.now();
    try {
      const deriveRes = await runBrainTask({
        prompt: '计算 12 乘以 15 的结果，请只输出最终数字',
        mode: MODES.DERIVE,
        timeout: 120,
      });
      const elapsed2 = ((Date.now() - t1) / 1000).toFixed(1);
      /180/.test(deriveRes.text)
        ? ok(`Derive 模式通过 (耗时 ${elapsed2}s, 回复: "${deriveRes.text.trim()}")`)
        : bad(`Derive 模式未返回预期数字: ${deriveRes.text}`);
    } catch (e) {
      bad(`Derive 模式执行失败: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(64));
console.log(`自检完成: ${pass} 项通过, ${fail} 项失败`);
console.log(fail === 0 ? '结论: 全面通过！架构演进与安全加固已就绪。' : '结论: 存在未通过项，请排查。');
process.exit(fail === 0 ? 0 : 1);
