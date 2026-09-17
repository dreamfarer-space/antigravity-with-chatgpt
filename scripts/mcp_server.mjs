#!/usr/bin/env node
/**
 * antigravity-with-chatgpt - mcp_server.mjs
 * ---------------------------------------------------------------------------
 * Antigravity 2.0 原生 Model Context Protocol (MCP) Server。
 * 遵循 JSON-RPC 2.0 over stdio 标准规范（零 npm 依赖）：
 *   - ask_chatgpt: 调度五大工作模式 (ask/plan/review/derive/diagnose) + 证据收集
 *   - chatgpt_status: 探测专用 Chrome 实例、CDP 9222 端口与会话状态
 *   - record_execution: 记录本地命令与测试运行结果，供闭环审查调用
 *
 * 严格标准：所有调试信息必须写入 stderr，stdout 严格保留给合法 JSON-RPC 消息！
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { runBrainTask, fetchLatestBrainResponse } from '../src/brain/orchestrator.mjs';
import { MODES } from '../src/brain/prompts.mjs';
import { checkCdpStatus } from '../src/transport/cdp_transport.mjs';
import { assertAuthorizedWorkspace, getAuthorizedWorkspace, pinAuthorizedWorkspace } from '../src/security/authorized_workspace.mjs';
import { recordExecution } from '../src/execution/recorder.mjs';
import { getWorkspaceInfo, readFileSafe } from '../src/workspace/context_provider.mjs';
import { getGitDiff } from '../src/git/git_helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
    return pkg.version || '2.1.5';
  } catch {
    return '2.1.5';
  }
})();

function log(...args) {
  process.stderr.write(`[mcp-server] ${args.join(' ')}\n`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

/**
 * 依赖注入接缝（测试用）：MCP handler 对底层编排/传输层的调用必须可被真实拦截，
 * 才能断言参数穿透契约（而不是在测试里自建 dummy wrapper 自证）。
 * 生产运行时保持指向真实实现，行为不变。
 */
export const __deps = {
  runBrainTask,
  fetchLatestBrainResponse,
};

/**
 * 工具调用者（本地 Agent）不得自定义安全沙箱：所有 workspace 参数都必须通过
 * 宿主授权根校验（启动时由 CHATGPT_BRAIN_WORKSPACE 或进程 cwd 固化）。
 * @param {string|undefined} requested
 * @returns {{ ok: true, workspace: string } | { ok: false, error: string }}
 */
export function resolveToolWorkspace(requested) {
  try {
    const candidate = requested
      ? path.resolve(requested)
      : (getAuthorizedWorkspace() || process.cwd());
    return { ok: true, workspace: assertAuthorizedWorkspace(candidate) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Tool Specifications
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'ask_chatgpt',
    description:
      '向 ChatGPT 网页版（通过独立隔离 Chrome 专用 CDP 通道）发送提问并获取完整回复。' +
      '支持 5 大工作模式：ask（通用对话）、plan（任务规划）、review（闭环审查，自动结合真实 Git 状态与测试记录）、derive（算法与数学推导）、diagnose（故障根因排查）。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '提问内容、任务目标或审查指令',
        },
        mode: {
          type: 'string',
          enum: ['ask', 'plan', 'review', 'derive', 'diagnose'],
          description: '工作模式：ask（默认）、plan（规划）、review（审查）、derive（纯推导）、diagnose（故障排查）',
          default: 'ask',
        },
        session: {
          type: 'string',
          enum: ['reuse', 'new'],
          description: "会话模式：'reuse' 在当前页面继续对话（默认）；'new' 开启独立全新会话（绝不删除任何历史）。",
          default: 'reuse',
        },
        workspace: {
          type: 'string',
          description: '当前项目工作区根目录绝对路径（用于路径边界校验与 Git Diff 抽取）',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: '需要作为上下文一起附带的代码或文本文件路径列表（自动进行防逃逸与敏感脱敏过滤）',
        },
        gitDiff: {
          type: 'boolean',
          description: '是否自动附带工作区当前的真实 Git Diff（在 review 与 diagnose 模式下默认自动开启）',
        },
        diffOffset: {
          type: 'number',
          description: 'Git Diff 分页起始偏移量（字节，从 0 开始，用于拉取后续 diff 切片）',
          default: 0,
        },
        diffMaxBytes: {
          type: 'number',
          description: 'Git Diff 单次最大字节预算限制（默认 32768，上限 65536）',
          default: 32768,
        },
        timeout: {
          type: 'number',
          description: '等待 ChatGPT 回复的最长超时时间（秒），默认 150 秒（受 MCP 客户端 3 分钟限制保护，上限 165 秒）',
          default: 150,
        },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'fetch_chatgpt_response',
    description:
      '抓取当前 ChatGPT 标签页中最新生成完毕或正在生成的长回复（带会话与回合身份校验）。' +
      '用于在上一轮提问由于耗时较长（返回 IN_PROGRESS）后拉取结果，或无需重新注入 Prompt 提取最新一轮回答。',
    inputSchema: {
      type: 'object',
      properties: {
        timeout: {
          type: 'number',
          description: '最长等待时间（秒），默认 150 秒（上限 165 秒）',
          default: 150,
        },
        expectedTurn: {
          type: 'number',
          description: '预期的最小回复回合数（可选，防止多会话或前后轮次串线）',
        },
        targetId: {
          type: 'string',
          description:
            'Chrome 标签身份（可选，opaque）。当上一轮 IN_PROGRESS 未返回 durable conversationUrl 时，' +
            '用它精确定位同一标签继续拉取（优先于 conversationUrl）。',
        },
        conversationUrl: {
          type: 'string',
          description: '预期的会话 URL（可选，校验标签页身份，防止串标签）',
        },
        workspace: {
          type: 'string',
          description: '可选的工作区根目录路径',
        },
      },
    },
  },
  {
    name: 'get_git_diff_page',
    description:
      '按需提取工作区真实 Git Diff 的指定分页切片（受字节预算与统一脱敏保护）。' +
      '用于闭环审查中响应 ChatGPT 发起的 <EVIDENCE_REQUEST>，或由外部 Agent 按需翻页。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: '可选的工作区根目录路径（默认当前目录）',
        },
        offset: {
          type: 'number',
          description: '分页起始字节偏移量 (从 0 开始)',
          default: 0,
        },
        maxBytes: {
          type: 'number',
          description: '单次提取的最大字节预算（默认 32768，上限 65536）',
          default: 32768,
        },
        head: {
          type: 'boolean',
          description: '是否对比 HEAD（涵盖暂存与未暂存变更，默认 true）',
          default: true,
        },
        staged: {
          type: 'boolean',
          description: '是否仅对比已暂存变更（默认 false）',
          default: false,
        },
        file: {
          type: 'string',
          description: '可选的特定文件路径过滤',
        },
      },
    },
  },
  {
    name: 'read_review_file',
    description:
      '安全读取工作区内指定代码文件（受防逃逸沙箱、敏感文件过滤与字节预算保护）。' +
      '用于响应闭环审查中对特定文件的全文或片段事实请求。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '待读取的目标文件路径（工作区内相对路径）',
        },
        workspace: {
          type: 'string',
          description: '可选的工作区根目录路径（默认当前目录）',
        },
        maxBytes: {
          type: 'number',
          description: '最大读取字节数（默认 32768）',
          default: 32768,
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'chatgpt_status',
    description: '检查专用 Chrome 实例、CDP 9222 端口连通性及当前工作区状态。',
    inputSchema: {
      type: 'object',
      properties: {
        workspace: {
          type: 'string',
          description: '可选的工作区根目录路径',
        },
      },
    },
  },
  {
    name: 'record_execution',
    description:
      '记录本地命令、构建或单元测试的实际执行结果。' +
      '这些记录会被持久化保存在本地证据库中，在接下来的 ask_chatgpt review 模式中自动呈递给 ChatGPT 进行客观闭环审查。',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '本地运行的命令（例如 "npm test", "cargo test", "pytest"）',
        },
        exitCode: {
          type: 'number',
          description: '命令退出码（0 表示成功，非 0 表示失败）',
        },
        workspace: {
          type: 'string',
          description: '命令所在的工作区路径',
        },
        testSummary: {
          type: 'object',
          properties: {
            passed: { type: 'number' },
            failed: { type: 'number' },
            skipped: { type: 'number' },
          },
          description: '可选的测试结果统计',
        },
        output: {
          type: 'string',
          description: '命令的关键输出或错误信息（会自动限长与脱敏）',
        },
        notes: {
          type: 'string',
          description: '补充说明',
        },
      },
      required: ['command', 'exitCode'],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool Handlers
// ---------------------------------------------------------------------------

export async function handleAskChatGPT(args) {
  const prompt = args.prompt;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
    return {
      content: [{ type: 'text', text: '错误: prompt 不能为空' }],
      isError: true,
    };
  }

  const MAX_INPUT_BYTES = 256 * 1024;
  if (Buffer.byteLength(prompt, 'utf8') > MAX_INPUT_BYTES) {
    return {
      content: [{ type: 'text', text: '错误: prompt 超过最大安全字节限制 (256 KB)' }],
      isError: true,
    };
  }

  // 严格夹逼 MCP 单次调用等待时间（默认 150 秒，上限 165 秒），防止触发 Antigravity 宿主 180s 强杀
  const safeTimeout = Math.min(Math.max(5, Number(args.timeout) || 150), 165);
  // 端到端唯一绝对截止时间：在 MCP 边界锚定，一路透传到 CDP 传输层的每一个等待点
  const deadlineMs = Date.now() + safeTimeout * 1000;

  // 工作区必须通过宿主授权根校验（调用者不得自定义沙箱）
  const wsResolution = resolveToolWorkspace(args.workspace);
  if (!wsResolution.ok) {
    return {
      content: [{ type: 'text', text: `错误: 工作区未获授权 — ${wsResolution.error}` }],
      isError: true,
    };
  }

  try {
    const res = await __deps.runBrainTask({
      prompt,
      mode: args.mode || MODES.ASK,
      session: args.session || (args.mode === 'new' ? 'new' : 'reuse'),
      workspace: wsResolution.workspace,
      files: args.files,
      gitDiff: args.gitDiff,
      diffOffset: args.diffOffset,
      diffMaxBytes: args.diffMaxBytes,
      timeout: safeTimeout,
      deadlineMs,
      safeTimeout: true,
    });

    if (res.inProgress) {
      const targetTurn = res.expectedTurn || (res.turns || 1);
      // P1-5：只有 durable `/c/<id>` 才能当 conversationUrl 凭证；
      // 停留在 `/` 或临时 `/c/WEB:<uuid>` 时凭证为 null，此时以 targetId 兜底恢复身份。
      const durableConvUrl = res.conversationUrl || null;
      const resumeTargetId = res.targetId || null;
      const resumeCredential = {
        ...(resumeTargetId ? { targetId: resumeTargetId } : {}),
        expectedTurn: targetTurn,
        ...(durableConvUrl ? { conversationUrl: durableConvUrl } : {}),
      };

      const waitNotice = [
        `[STATUS: IN_PROGRESS] ChatGPT 正在深度思考与生成长回复中。`,
        `为防止触发 Antigravity / MCP 客户端的 3 分钟硬性超时限制 (timed out after 3m0s)，已在安全窗口 (${Math.round((res.elapsedMs || 0) / 1000)}s) 内安全返回。`,
        ``,
        `【当前生成状态与恢复身份凭证】:`,
        `- 目标期望回复回合 (expectedTurn): ${targetTurn}`,
        durableConvUrl
          ? `- 已锁定会话 (conversationUrl): ${durableConvUrl}`
          : `- 会话身份尚未持久化（仍在根路径或临时 /c/WEB:<uuid>），conversationUrl 故意返回 null，恢复时请仅凭 targetId`,
        resumeTargetId ? `- Chrome 标签身份 (targetId): ${resumeTargetId}` : '',
        `- 是否仍在流式传输: ${res.isStreaming ? '是 (Streaming)' : '等待 DOM 稳定'}`,
        res.text ? `- 已截获部分文本切片 (${res.text.length} 字符):\n\`\`\`\n${res.text.slice(-400)}\n\`\`\`` : `- 尚未产生可见文本切片`,
        ``,
        `【后续操作指引】:`,
        `请勿重新提交完整提问（以防覆盖正在生成的长回复）！请直接调用工具 \`fetch_chatgpt_response\` 携带下列凭据拉取完整回复:`,
        `\`\`\`json`,
        JSON.stringify(resumeCredential, null, 2),
        `\`\`\``,
      ].filter(Boolean).join('\n');

      return {
        content: [{ type: 'text', text: waitNotice }],
        isError: false,
      };
    }

    return {
      content: [{ type: 'text', text: res.text }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `Brain Bridge 执行异常: ${err.message}` }],
      isError: true,
    };
  }
}

export async function handleFetchChatGPTResponse(args = {}) {
  const safeTimeout = Math.min(Math.max(5, Number(args.timeout) || 150), 165);
  const deadlineMs = Date.now() + safeTimeout * 1000;

  const wsResolution = resolveToolWorkspace(args.workspace);
  if (!wsResolution.ok) {
    return {
      content: [{ type: 'text', text: `错误: 工作区未获授权 — ${wsResolution.error}` }],
      isError: true,
    };
  }

  try {
    const res = await __deps.fetchLatestBrainResponse({
      timeout: safeTimeout,
      deadlineMs,
      expectedTurn: args.expectedTurn,
      conversationUrl: args.conversationUrl,
      targetId: args.targetId,
      workspace: wsResolution.workspace,
      safeTimeout: true,
    });

    if (res.inProgress) {
      const targetTurn = args.expectedTurn || res.expectedTurn || res.turns || 1;
      const durableConvUrl = res.conversationUrl || null;
      const resumeTargetId = args.targetId || res.targetId || null;
      const waitNotice = [
        `[STATUS: IN_PROGRESS] ChatGPT 仍在生成长回复中（已等待 ${Math.round((res.elapsedMs || 0) / 1000)}s）。`,
        `- 目标期望回复回合: ${targetTurn}`,
        durableConvUrl ? `- 已锁定会话: ${durableConvUrl}` : '',
        resumeTargetId ? `- Chrome 标签身份 (targetId): ${resumeTargetId}` : '',
        `- 是否仍在流式传输: ${res.isStreaming ? '是' : '否'}`,
        res.text ? `- 已截获最新切片 (${res.text.length} 字符):\n\`\`\`\n${res.text.slice(-400)}\n\`\`\`` : '',
        `可再次调用 \`fetch_chatgpt_response\` (携带 targetId${durableConvUrl ? ' / conversationUrl' : ''} 与 expectedTurn: ${targetTurn}) 继续拉取，直到生成完全结束。`,
      ].filter(Boolean).join('\n');

      return {
        content: [{ type: 'text', text: waitNotice }],
        isError: false,
      };
    }

    if (!res.text || !res.text.trim()) {
      return {
        content: [{ type: 'text', text: res.message || '当前页面暂未获取到有效的回复内容。' }],
        isError: false,
      };
    }

    return {
      content: [{ type: 'text', text: res.text }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `拉取回复失败: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleGetGitDiffPage(args = {}) {
  const wsResolution = resolveToolWorkspace(args.workspace);
  if (!wsResolution.ok) {
    return {
      content: [{ type: 'text', text: `错误: 工作区未获授权 — ${wsResolution.error}` }],
      isError: true,
    };
  }
  const ws = wsResolution.workspace;
  const offset = Math.max(0, Number(args.offset) || 0);
  const maxBytes = Math.min(Math.max(1024, Number(args.maxBytes) || 32768), 65536);
  const head = args.head !== false;
  const staged = Boolean(args.staged);
  const file = typeof args.file === 'string' ? args.file : undefined;

  try {
    const diffRes = getGitDiff(ws, { offset, maxBytes, head, staged, file });
    return {
      content: [{ type: 'text', text: JSON.stringify(diffRes, null, 2) }],
      isError: !diffRes.hasDiff && Boolean(diffRes.error),
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `获取 Git Diff 分页失败: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleReadReviewFile(args = {}) {
  if (!args || typeof args.path !== 'string' || !args.path.trim()) {
    return {
      content: [{ type: 'text', text: '错误: read_review_file 缺少必填参数 path' }],
      isError: true,
    };
  }

  const wsResolution = resolveToolWorkspace(args.workspace);
  if (!wsResolution.ok) {
    return {
      content: [{ type: 'text', text: `错误: 工作区未获授权 — ${wsResolution.error}` }],
      isError: true,
    };
  }
  const ws = wsResolution.workspace;
  const maxBytes = Math.min(Math.max(1024, Number(args.maxBytes) || 32768), 128 * 1024);

  try {
    const fileRes = readFileSafe(ws, args.path.trim(), { maxBytes });
    return {
      content: [{ type: 'text', text: JSON.stringify(fileRes, null, 2) }],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `读取代码文件失败: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleCheckStatus(args) {
  try {
    const cdp = await checkCdpStatus();
    const wsResolution = resolveToolWorkspace(args.workspace);
    if (!wsResolution.ok) {
      return {
        content: [{ type: 'text', text: `错误: 工作区未获授权 — ${wsResolution.error}` }],
        isError: true,
      };
    }
    const wsInfo = getWorkspaceInfo(wsResolution.workspace);

    const data = {
      ready: cdp.running,
      cdp,
      workspace: wsInfo,
    };

    return {
      content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
      isError: !cdp.running,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `状态检测失败: ${err.message}` }],
      isError: true,
    };
  }
}

async function handleRecordExecution(args) {
  if (!args || typeof args.command !== 'string' || !args.command.trim()) {
    return {
      content: [{ type: 'text', text: '错误: recordExecution 缺少必填参数 command' }],
      isError: true,
    };
  }
  if (typeof args.exitCode !== 'number' || !Number.isInteger(args.exitCode)) {
    return {
      content: [{ type: 'text', text: '错误: recordExecution 参数 exitCode 必须为有效整数' }],
      isError: true,
    };
  }

  try {
    const rec = recordExecution(args);
    return {
      content: [
        {
          type: 'text',
          text: `已成功保存执行记录 [${rec.id}]: ${rec.command} -> exitCode ${rec.exitCode} (已加入本地审查证据库)`,
        },
      ],
      isError: false,
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: `记录失败: ${err.message}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC Dispatcher
// ---------------------------------------------------------------------------

async function handleRpcRequest(req) {
  const { id, method, params } = req;

  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') log('Client initialized');
    return;
  }

  if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
    return;
  }

  if (method === 'initialize') {
    // 严格遵循 Antigravity 2.0 经实测验证的 MCP 规范版本 (2024-11-05)
    // 避免对 2026-07-28 产生不符合无握手架构的假兼容声明
    const protocolVersion = '2024-11-05';

    send({
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: 'antigravity-with-chatgpt',
          version: PKG_VERSION,
        },
      },
    });
    return;
  }

  if (method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id,
      result: { tools: TOOLS },
    });
    return;
  }

  if (method === 'tools/call') {
    const { name, arguments: args = {} } = params || {};
    log(`Tool call: ${name}`);

    let res;
    if (name === 'ask_chatgpt') {
      res = await handleAskChatGPT(args);
    } else if (name === 'fetch_chatgpt_response') {
      res = await handleFetchChatGPTResponse(args);
    } else if (name === 'chatgpt_status') {
      res = await handleCheckStatus(args);
    } else if (name === 'record_execution') {
      res = await handleRecordExecution(args);
    } else if (name === 'get_git_diff_page') {
      res = await handleGetGitDiffPage(args);
    } else if (name === 'read_review_file') {
      res = await handleReadReviewFile(args);
    } else {
      send({
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Tool not found: ${name}` },
      });
      return;
    }

    send({ jsonrpc: '2.0', id, result: res });
    return;
  }

  send({
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `Unknown method: ${method}` },
  });
}

// ---------------------------------------------------------------------------
// Main stdio loop
// ---------------------------------------------------------------------------

function startServer() {
  log('Starting antigravity-with-chatgpt MCP server over stdio...');

  let buffer = '';
  let activeRequests = 0;
  let stdinClosed = false;

  const tryExitIfDone = () => {
    if (stdinClosed && activeRequests === 0) {
      log('All requests completed and stdin closed, exiting server.');
      process.exit(0);
    }
  };

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newlineIdx;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (line) {
        try {
          const req = JSON.parse(line);
          activeRequests++;
          handleRpcRequest(req)
            .catch((err) => log('Request error: ' + (err.stack || err.message)))
            .finally(() => {
              activeRequests--;
              tryExitIfDone();
            });
        } catch (e) {
          log('JSON parse error: ' + line);
        }
      }
    }
  });

  process.stdin.on('end', () => {
    log('process.stdin closed');
    stdinClosed = true;
    tryExitIfDone();
  });
}

// 仅在作为可执行入口运行时才启动 stdio 事件循环；
// 被测试 import 时不得占用 stdin、不得自动退出进程。
const isMainModule = (() => {
  try {
    const argvPath = process.argv[1] ? path.resolve(process.argv[1]).toLowerCase() : '';
    if (!argvPath) return false;
    const modulePath = path.resolve(fileURLToPath(import.meta.url)).toLowerCase();
    return argvPath === modulePath || argvPath.endsWith(`${path.sep}mcp_server.mjs`);
  } catch {
    return false;
  }
})();

if (isMainModule) {
  // 宿主授权根必须在启动时固化：此后任何工具调用的 workspace 都只能等于它或位于其下，
  // 调用者（可能已被 prompt injection 影响的本地 Agent）不得自行定义"安全沙箱"。
  try {
    const root = pinAuthorizedWorkspace(process.env.CHATGPT_BRAIN_WORKSPACE || process.cwd());
    log(`Authorized workspace root: ${root}`);
  } catch (err) {
    log(`FATAL: 无法固化授权工作区根 — ${err.message}`);
    process.exit(2);
  }
  startServer();
}
