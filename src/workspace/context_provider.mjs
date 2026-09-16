/**
 * context_provider.mjs - 安全的只读工作区上下文提供者
 * ---------------------------------------------------------------------------
 * 严格收敛、脱敏与按需提供本地代码文件与项目信息：
 *   - 路径防逃逸 (path_guard)
 *   - 敏感文件黑名单与正则脱敏 (sensitive)
 *   - .brainignore 规则过滤 (ignore)
 *   - 预算与分页限制
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSafePath, SecurityError } from '../security/path_guard.mjs';
import { isSensitivePath, sanitizeContent } from '../security/sensitive.mjs';
import { loadBrainIgnore } from '../security/ignore.mjs';
import { getGitStatus, truncateUtf8ByBytes } from '../git/git_helper.mjs';

const DEFAULT_FILE_MAX_BYTES = 128 * 1024; // 128 KB per file
const BINARY_CHECK_BYTES = 4096;

const LANG_MAP = {
  '.ts': 'typescript', '.tsx': 'tsx', '.js': 'javascript', '.jsx': 'jsx',
  '.mjs': 'javascript', '.cjs': 'javascript', '.py': 'python', '.rs': 'rust',
  '.go': 'go', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'c',
  '.hpp': 'cpp', '.cs': 'csharp', '.json': 'json', '.md': 'markdown',
  '.yaml': 'yaml', '.yml': 'yaml', '.toml': 'toml', '.xml': 'xml',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.sh': 'bash',
  '.ps1': 'powershell', '.sql': 'sql',
};

function isBinary(buffer) {
  const len = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < len; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * 获取工作区基础信息与目录结构摘要
 * @param {string} workspaceRoot
 * @returns {object}
 */
export function getWorkspaceInfo(workspaceRoot) {
  const absRoot = path.resolve(workspaceRoot);
  const ignore = loadBrainIgnore(absRoot);
  const gitInfo = getGitStatus(absRoot);

  const topLevel = [];
  try {
    const entries = fs.readdirSync(absRoot, { withFileTypes: true });
    for (const ent of entries) {
      if (ignore.ignores(ent.name, ent.isDirectory())) continue;
      if (isSensitivePath(ent.name)) continue;
      topLevel.push(ent.isDirectory() ? ent.name + '/' : ent.name);
    }
  } catch {}

  return {
    root: absRoot,
    name: path.basename(absRoot),
    git: gitInfo,
    topLevelEntries: topLevel.slice(0, 30),
  };
}

/**
 * 安全读取单个代码文件（带按行切片、字节预算与敏感信息拦截）
 * @param {string} workspaceRoot
 * @param {string} filePath
 * @param {object} [options]
 * @param {number} [options.startLine=1] 1-indexed
 * @param {number} [options.maxLines]
 * @param {number} [options.maxBytes=131072]
 * @returns {object} { path, content, linesRead, totalLines, truncated }
 */
export function readFileSafe(workspaceRoot, filePath, options = {}) {
  const safePath = resolveSafePath(workspaceRoot, filePath);
  const relPath = path.relative(workspaceRoot, safePath).replace(/\\/g, '/');

  // 1. 检查是否为敏感文件
  if (isSensitivePath(relPath)) {
    throw new SecurityError(`安全拦截: 禁止读取敏感文件 "${relPath}"`, 'E_SENSITIVE_FILE');
  }

  // 2. 检查 .brainignore
  const ignore = loadBrainIgnore(workspaceRoot);
  if (ignore.ignores(relPath, false)) {
    throw new SecurityError(`规则拦截: 文件 "${relPath}" 匹配 .brainignore`, 'E_IGNORED_FILE');
  }

  const stat = fs.statSync(safePath);
  if (stat.isDirectory()) {
    throw new SecurityError(`无法读取目录作为文件: "${relPath}"`, 'E_IS_DIRECTORY');
  }

  const maxBytes = options.maxBytes || DEFAULT_FILE_MAX_BYTES;
  const buf = fs.readFileSync(safePath);

  if (isBinary(buf)) {
    throw new SecurityError(`安全拦截: 拒绝读取二进制文件 "${relPath}"`, 'E_BINARY_FILE');
  }

  let text = buf.toString('utf8');
  const allLines = text.split('\n');
  const totalLines = allLines.length;

  const startLine = Math.max(1, options.startLine || 1);
  const startIdx = startLine - 1;
  const maxLines = options.maxLines || totalLines;
  const slicedLines = allLines.slice(startIdx, startIdx + maxLines);

  const rawText = slicedLines.join('\n');
  const sanitized = sanitizeContent(rawText);

  let resultText = sanitized;
  let truncated = false;

  if (Buffer.byteLength(resultText, 'utf8') > maxBytes) {
    resultText = truncateUtf8ByBytes(resultText, maxBytes);
    truncated = true;
  }

  return {
    path: relPath,
    content: resultText,
    startLine,
    linesRead: slicedLines.length,
    totalLines,
    truncated,
  };
}

/**
 * 组装安全的附件 Markdown 代码块
 * @param {string} workspaceRoot
 * @param {Array<string>} files
 * @param {number} [maxTotalBytes=524288]
 * @returns {string}
 */
export function buildAttachmentsBlock(workspaceRoot, files, maxTotalBytes = 512 * 1024) {
  if (!files || files.length === 0) return '';

  const blocks = [];
  let accumulatedBytes = 0;

  for (const f of files) {
    try {
      const read = readFileSafe(workspaceRoot, f, { maxBytes: 128 * 1024 });
      const ext = path.extname(read.path).toLowerCase();
      const lang = LANG_MAP[ext] || '';
      const block = `## File: ${read.path} (${read.linesRead}/${read.totalLines} lines)\n\`\`\`${lang}\n${read.content}\n\`\`\``;
      const blockBytes = Buffer.byteLength(block, 'utf8');

      if (accumulatedBytes + blockBytes > maxTotalBytes) {
        blocks.push(`> [WARN] 附件总大小超出限制，部分文件已略过: ${f}`);
        break;
      }

      blocks.push(block);
      accumulatedBytes += blockBytes;
    } catch (err) {
      blocks.push(`> [WARN] 略过文件 "${f}": ${err.message}`);
    }
  }

  return blocks.length ? '\n' + blocks.join('\n\n') + '\n' : '';
}

/**
 * 在工作区内执行受控搜索
 * @param {string} workspaceRoot
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.maxMatches=50]
 * @returns {Array<object>} [{ file, line, text }]
 */
export function searchWorkspace(workspaceRoot, query, options = {}) {
  const maxMatches = options.maxMatches || 50;
  if (!query || typeof query !== 'string') return [];

  const absRoot = path.resolve(workspaceRoot);

  // 优先尝试 ripgrep
  const rgRes = spawnSync('rg', [
    '--no-heading',
    '--line-number',
    '--color=never',
    '--max-count', String(maxMatches),
    query,
    absRoot,
  ], { encoding: 'utf8', shell: false });

  if (rgRes.status === 0 && rgRes.stdout) {
    const matches = [];
    const lines = rgRes.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) {
        const fullPath = parts[0];
        const lineNum = Number(parts[1]);
        const content = parts.slice(2).join(':').trim();
        const rel = path.relative(absRoot, fullPath).replace(/\\/g, '/');
        if (isSensitivePath(rel)) continue;
        matches.push({ file: rel, line: lineNum, text: sanitizeContent(content) });
        if (matches.length >= maxMatches) break;
      }
    }
    return matches;
  }

  // 降级尝试 git grep
  const gitRes = spawnSync('git', ['-C', absRoot, 'grep', '-n', '-I', query], {
    encoding: 'utf8',
    shell: false,
  });

  if (gitRes.status === 0 && gitRes.stdout) {
    const matches = [];
    const lines = gitRes.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) {
        const rel = parts[0];
        const lineNum = Number(parts[1]);
        const content = parts.slice(2).join(':').trim();
        if (isSensitivePath(rel)) continue;
        matches.push({ file: rel, line: lineNum, text: sanitizeContent(content) });
        if (matches.length >= maxMatches) break;
      }
    }
    return matches;
  }

  return [];
}
