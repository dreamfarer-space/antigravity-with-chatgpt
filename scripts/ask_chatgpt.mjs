#!/usr/bin/env node
/**
 * antigravity-with-chatgpt - ask_chatgpt.mjs
 * ---------------------------------------------------------------------------
 * 极简 CLI 入口，基于四层架构 (src/brain/orchestrator.mjs) 调度：
 *   - 支持 5 大模式：ask / plan / review / derive / diagnose
 *   - 自动路径安全检查与敏感脱敏 (path_guard + sensitive)
 *   - 自动 Git Diff 捕获 (--git-diff / review 模式)
 *   - 保持 100% 向下兼容（--new, --attach, --file, --doctor, --json, --out）
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { runBrainTask, fetchLatestBrainResponse } from '../src/brain/orchestrator.mjs';
import { MODES } from '../src/brain/prompts.mjs';
import { checkCdpStatus, findChrome } from '../src/transport/cdp_transport.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const EXIT = { OK: 0, USAGE: 2, ERROR: 3, FILE: 6 };

function parseArgs(argv) {
  const opts = {
    mode: MODES.ASK,
    session: 'reuse',
    attach: [],
    file: null,
    gitDiff: false,
    timeoutS: 600,
    doctor: false,
    json: false,
    fetch: false,
    out: null,
    workspace: process.cwd(),
    promptParts: [],
  };

  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    switch (a) {
      case '--new': opts.session = 'new'; break;
      case '--continue': opts.session = 'reuse'; break;
      case '--doctor': opts.doctor = true; break;
      case '--json': opts.json = true; break;
      case '--fetch': case '--poll': opts.fetch = true; break;
      case '--git-diff': opts.gitDiff = true; break;
      case '--mode': {
        const m = rest[++i];
        if (m && Object.values(MODES).includes(m.toLowerCase())) {
          opts.mode = m.toLowerCase();
        }
        break;
      }
      case '--plan': opts.mode = MODES.PLAN; break;
      case '--review': opts.mode = MODES.REVIEW; break;
      case '--derive': opts.mode = MODES.DERIVE; break;
      case '--diagnose': opts.mode = MODES.DIAGNOSE; break;
      case '--workspace': opts.workspace = rest[++i]; break;
      case '--file': opts.file = rest[++i]; break;
      case '--out': opts.out = rest[++i]; break;
      case '--timeout': opts.timeoutS = Number(rest[++i]); break;
      case '--help': case '-h': opts.help = true; break;
      case '--attach': {
        i++;
        while (i < rest.length && !rest[i].startsWith('--')) {
          opts.attach.push(rest[i]);
          i++;
        }
        i--;
        break;
      }
      default:
        if (a.startsWith('--')) {
          process.stderr.write(`[warn] 未知参数: ${a}\n`);
        } else {
          opts.promptParts.push(a);
        }
    }
  }

  opts.prompt = opts.promptParts.join(' ');
  return opts;
}

const HELP = `
antigravity-with-chatgpt - Antigravity / Gemini 调用 ChatGPT 智脑桥接

基础调用:
  node ask_chatgpt.mjs "<prompt>"                       # 通用问答 (继续当前会话)
  node ask_chatgpt.mjs --new "<prompt>"                 # 开启全新独立会话
  node ask_chatgpt.mjs --attach a.ts b.py "<prompt>"    # 附带本地源码 (带安全收敛与脱敏)
  node ask_chatgpt.mjs --file prompt.md                 # 从文件读取提示词
  node ask_chatgpt.mjs --fetch                          # 抓取当前页面正在生成或最新的回复 (无需重发 Prompt)

专业工作模式:
  node ask_chatgpt.mjs --plan "<goal>"                  # 架构与任务规划模式
  node ask_chatgpt.mjs --review "<instruction>"         # 闭环审查模式 (自动附带真实 Git Diff 与执行记录)
  node ask_chatgpt.mjs --derive "<math/algorithm>"      # 深度推导模式 (无代码噪音干扰)
  node ask_chatgpt.mjs --diagnose "<error/bug>"         # 故障排查与根因分析

系统命令:
  node ask_chatgpt.mjs --doctor                         # 全面环境与 CDP 状态自检
`;

async function runDoctor() {
  process.stdout.write('antigravity-with-chatgpt - 系统诊断\n' + '='.repeat(50) + '\n');
  const chrome = findChrome();
  process.stdout.write(`Chrome 可执行文件: ${chrome ? `[ OK ] ${chrome}` : '[FAIL] 未找到'}\n`);
  process.stdout.write(`Node.js 版本: ${process.version} (>= 22 原生 WebSocket 满足)\n`);

  const status = await checkCdpStatus();
  if (status.running) {
    process.stdout.write(`[ OK ] CDP 端口 9222 就绪 (${status.browser})\n`);
    process.stdout.write(`       当前标签页总数: ${status.pagesCount}\n`);
    process.stdout.write(`       ChatGPT 标签页: ${status.chatgptPages.length ? status.chatgptPages[0].url : '无'}\n`);
  } else {
    process.stdout.write(`[FAIL] CDP 端口不可访问 (${status.error}) - 需启动专用 Chrome\n`);
  }
  process.exit(status.running ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv);

  if (opts.help) {
    process.stdout.write(HELP);
    process.exit(EXIT.OK);
  }

  if (opts.doctor) {
    return runDoctor();
  }

  if (opts.fetch) {
    try {
      const result = await fetchLatestBrainResponse({
        timeout: opts.timeoutS,
        workspace: opts.workspace,
      });

      if (opts.out && result.text) {
        fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
        fs.writeFileSync(path.resolve(opts.out), result.text, 'utf8');
      }

      if (opts.json) {
        process.stdout.write(JSON.stringify(result) + '\n');
      } else {
        const text = result.text || result.message || '';
        process.stdout.write(text.endsWith('\n') ? text : text + '\n');
      }

      process.exit(EXIT.OK);
    } catch (err) {
      process.stderr.write(`[brain-bridge][ERROR] ${err.message}\n`);
      process.exit(EXIT.ERROR);
    }
  }

  let prompt = opts.prompt || '';
  if (opts.file) {
    try {
      const fileContent = fs.readFileSync(path.resolve(opts.file), 'utf8');
      prompt = prompt ? `${fileContent}\n\n${prompt}` : fileContent;
    } catch (e) {
      process.stderr.write(`读取提示词文件失败: ${e.message}\n`);
      process.exit(EXIT.FILE);
    }
  }

  if (!prompt || !prompt.trim()) {
    process.stderr.write(HELP);
    process.exit(EXIT.USAGE);
  }

  try {
    const result = await runBrainTask({
      prompt,
      mode: opts.mode,
      session: opts.session,
      workspace: opts.workspace,
      files: opts.attach,
      gitDiff: opts.gitDiff,
      timeout: opts.timeoutS,
    });

    if (opts.out && result.text) {
      fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
      fs.writeFileSync(path.resolve(opts.out), result.text, 'utf8');
    }

    if (opts.json) {
      process.stdout.write(JSON.stringify(result) + '\n');
    } else {
      const text = result.text || (result.inProgress ? `[IN_PROGRESS] ${result.message}` : '');
      process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    }

    process.exit(EXIT.OK);
  } catch (err) {
    process.stderr.write(`[brain-bridge][ERROR] ${err.message}\n`);
    process.exit(EXIT.ERROR);
  }
}

main().catch((err) => {
  process.stderr.write(`[FATAL] ${err.stack || err}\n`);
  process.exit(1);
});
