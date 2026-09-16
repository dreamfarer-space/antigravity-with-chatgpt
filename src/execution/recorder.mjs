/**
 * recorder.mjs - 本地执行证据记录器
 * ---------------------------------------------------------------------------
 * 记录构建、测试、终端命令的实际执行结果（exit code, test count, output），
 * 为 ChatGPT 的闭环独立审查 (Closed-Loop Review) 提供本地代理上报的执行证据 (Agent-Reported Evidence)。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { sanitizeContent } from '../security/sensitive.mjs';

const GLOBAL_STORE_DIR = path.join(os.homedir(), '.antigravity-with-chatgpt');
const RECORD_FILE = path.join(GLOBAL_STORE_DIR, 'executions.jsonl');

function ensureStoreDir() {
  if (!fs.existsSync(GLOBAL_STORE_DIR)) {
    try { fs.mkdirSync(GLOBAL_STORE_DIR, { recursive: true }); } catch {}
  }
}

/**
 * 记录一次本地执行事实
 * @param {object} entry
 * @param {string} [entry.taskId] 任务 ID
 * @param {string} entry.command 运行的命令
 * @param {number} entry.exitCode 退出码
 * @param {string} [entry.workspace] 工作区路径
 * @param {object} [entry.testSummary] 测试摘要 { passed, failed, skipped, total }
 * @param {string} [entry.output] 命令关键输出/错误信息（自动脱敏并限长）
 * @param {string} [entry.notes] 补充说明
 */
export function recordExecution(entry) {
  if (!entry || typeof entry !== 'object') {
    throw new TypeError('recordExecution: entry 必须为有效对象');
  }
  if (typeof entry.command !== 'string' || !entry.command.trim()) {
    throw new TypeError('recordExecution: command 必须是非空有效字符串');
  }
  if (typeof entry.exitCode !== 'number' || !Number.isInteger(entry.exitCode)) {
    throw new TypeError('recordExecution: exitCode 必须是有效整数');
  }

  ensureStoreDir();

  const record = {
    id: 'exec_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    timestamp: new Date().toISOString(),
    taskId: entry.taskId || null,
    workspace: entry.workspace ? path.resolve(entry.workspace) : process.cwd(),
    command: entry.command.trim(),
    exitCode: entry.exitCode,
    testSummary: entry.testSummary || null,
    notes: entry.notes || null,
  };

  if (entry.output) {
    // P1: Canonical sanitization first!
    // Sanitize before truncation to prevent boundary-split secrets
    const sanitized = sanitizeContent(String(entry.output));
    record.output = sanitized.length > 16 * 1024 ? sanitized.slice(0, 16 * 1024) : sanitized;
  }

  const line = JSON.stringify(record) + '\n';
  try {
    fs.appendFileSync(RECORD_FILE, line, 'utf8');
  } catch (err) {
    process.stderr.write(`[recorder] 写入执行记录失败: ${err.message}\n`);
  }

  return record;
}

/**
 * 获取指定工作区最近的执行记录
 * @param {string} workspace
 * @param {number} [limit=5]
 * @returns {Array<object>}
 */
export function getRecentExecutions(workspace, limit = 5) {
  if (!fs.existsSync(RECORD_FILE)) return [];

  const targetWs = workspace ? path.resolve(workspace).toLowerCase() : null;
  const records = [];

  try {
    const lines = fs.readFileSync(RECORD_FILE, 'utf8').trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && records.length < limit; i--) {
      try {
        const item = JSON.parse(lines[i]);
        if (!targetWs || (item.workspace && item.workspace.toLowerCase() === targetWs)) {
          records.push(item);
        }
      } catch {}
    }
  } catch {}

  return records;
}

/**
 * 将执行记录格式化为清晰的 Markdown 块
 * @param {Array<object>} records
 * @returns {string}
 */
export function formatExecutionSummary(records) {
  if (!records || records.length === 0) return '';

  const lines = ['### Local Execution Evidence (Agent-Reported Records):'];
  for (const r of records) {
    const isSuccess = r.exitCode === 0 && (!r.testSummary || (r.testSummary.failed ?? 0) === 0);
    const statusText = isSuccess ? '✓ SUCCESS (code 0)' : `✗ FAILED (code ${r.exitCode})`;
    lines.push(`- **${r.timestamp.slice(11, 19)}** | \`${r.command}\` -> ${statusText}`);
    if (r.testSummary) {
      lines.push(`  - Tests: passed=${r.testSummary.passed ?? '?'}, failed=${r.testSummary.failed ?? 0}`);
    }
    if (r.notes) {
      lines.push(`  - Note: ${r.notes}`);
    }
    // 仅在执行失败时附加输出片段与报错信息，防止大量成功日志膨胀 Prompt
    if (!isSuccess && r.output) {
      const snippet = r.output.length > 4096 ? r.output.slice(0, 4096) + '\n... [output truncated]' : r.output;
      lines.push('  - Output / Error snippet:');
      lines.push('```text');
      lines.push(snippet.trim());
      lines.push('```');
    }
  }
  return lines.join('\n');
}
