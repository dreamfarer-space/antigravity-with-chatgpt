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

import process from 'node:process';
import { runBrainTask } from '../src/brain/orchestrator.mjs';
import { MODES } from '../src/brain/prompts.mjs';
import { checkCdpStatus } from '../src/transport/cdp_transport.mjs';
import { recordExecution } from '../src/execution/recorder.mjs';
import { getWorkspaceInfo } from '../src/workspace/context_provider.mjs';

function log(...args) {
  process.stderr.write(`[mcp-server] ${args.join(' ')}\n`);
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
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
        timeout: {
          type: 'number',
          description: '等待 ChatGPT 回复的最长超时时间（秒），默认 600',
          default: 600,
        },
      },
      required: ['prompt'],
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

async function handleAskChatGPT(args) {
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

  try {
    const res = await runBrainTask({
      prompt,
      mode: args.mode || MODES.ASK,
      session: args.session || (args.mode === 'new' ? 'new' : 'reuse'),
      workspace: args.workspace,
      files: args.files,
      gitDiff: args.gitDiff,
      timeout: args.timeout,
    });

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

async function handleCheckStatus(args) {
  try {
    const cdp = await checkCdpStatus();
    const wsInfo = args.workspace ? getWorkspaceInfo(args.workspace) : null;

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
  if (args.exitCode === undefined || args.exitCode === null || !Number.isInteger(Number(args.exitCode))) {
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
          version: '2.1.2',
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
    } else if (name === 'chatgpt_status') {
      res = await handleCheckStatus(args);
    } else if (name === 'record_execution') {
      res = await handleRecordExecution(args);
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

startServer();
