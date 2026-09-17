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
import { authorizeCanonicalFile } from '../security/file_authorizer.mjs';
import { assertAuthorizedWorkspace } from '../security/authorized_workspace.mjs';
import { getGitStatus, truncateUtf8ByBytes } from '../git/git_helper.mjs';

const DEFAULT_FILE_MAX_BYTES = 128 * 1024; // 128 KB per file
const BINARY_CHECK_BYTES = 4096;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;

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
  const absRoot = assertAuthorizedWorkspace(workspaceRoot);
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
  const maxBytes = options.maxBytes || DEFAULT_FILE_MAX_BYTES;
  // 单一文件授权入口：工作区授权 + 词法/realpath 双重 sensitive 与 .brainignore 校验 + 大小上限
  const authorized = authorizeCanonicalFile(workspaceRoot, filePath, { maxBytes: MAX_SOURCE_FILE_BYTES });
  const relPath = authorized.relPath;

  const buf = fs.readFileSync(authorized.realPath);

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
 * 组装安全的附件 Markdown 代码块（带多文件阶梯预算与截断提示）
 * @param {string} workspaceRoot
 * @param {Array<string>} files
 * @param {number|object} [optionsOrMaxTotalBytes=196608] 默认总上限 192 KB
 * @returns {string}
 */
export function buildAttachmentsBlock(workspaceRoot, files, optionsOrMaxTotalBytes = 192 * 1024) {
  if (!files || files.length === 0) return '';

  const opts = typeof optionsOrMaxTotalBytes === 'number'
    ? { maxTotalBytes: optionsOrMaxTotalBytes }
    : { maxTotalBytes: 192 * 1024, ...optionsOrMaxTotalBytes };

  const maxTotalBytes = opts.maxTotalBytes || 192 * 1024;
  const fileCount = files.length;
  // 多文件时动态调配单文件预算：单文件上限 128KB；多文件时均分并保底 16KB，最高 64KB
  const defaultPerFileBudget = fileCount <= 1
    ? 128 * 1024
    : Math.max(16 * 1024, Math.min(64 * 1024, Math.floor(maxTotalBytes / fileCount)));
  const maxBytesPerFile = opts.maxBytesPerFile || defaultPerFileBudget;

  const blocks = [];
  let accumulatedBytes = 0;

  for (const f of files) {
    try {
      const read = readFileSafe(workspaceRoot, f, { maxBytes: maxBytesPerFile });
      const ext = path.extname(read.path).toLowerCase();
      const lang = LANG_MAP[ext] || '';
      
      let truncationNotice = '';
      if (read.truncated || read.linesRead < read.totalLines) {
        truncationNotice = `\n> [NOTE: File slice bounded (${read.linesRead}/${read.totalLines} lines, ${Buffer.byteLength(read.content, 'utf8')}B). If full content is needed, request via <EVIDENCE_REQUEST> {"type": "read_file", "path": "${read.path}"}]`;
      }

      const block = `## File: ${read.path} (${read.linesRead}/${read.totalLines} lines)\n\`\`\`${lang}\n${read.content}\n\`\`\`${truncationNotice}`;
      const blockBytes = Buffer.byteLength(block, 'utf8');

      if (accumulatedBytes + blockBytes > maxTotalBytes) {
        blocks.push(`> [WARN] 附件总大小超出预算限制 (${maxTotalBytes}B)，部分文件已略过: ${f}`);
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
 * 两条分支（ripgrep / git grep）都必须同时应用 sensitive 黑名单与 .brainignore，
 * 并且只能搜索宿主授权的工作区根。
 * @param {string} workspaceRoot
 * @param {string} query
 * @param {object} [options]
 * @param {number} [options.maxMatches=50]
 * @returns {Array<object>} [{ file, line, text }]
 */
export function searchWorkspace(workspaceRoot, query, options = {}) {
  const maxMatches = options.maxMatches || 50;
  if (!query || typeof query !== 'string') return [];

  const absRoot = assertAuthorizedWorkspace(workspaceRoot);
  const ignore = loadBrainIgnore(absRoot);

  const isSearchableRel = (rel) => {
    if (!rel) return false;
    if (isSensitivePath(rel)) return false;
    if (ignore.ignores(rel, false)) return false;
    return true;
  };

  // 优先尝试 ripgrep（--json 结构化输出，彻底规避 Windows 路径盘符与 ':' 分隔歧义）
  const rgRes = spawnSync('rg', [
    '--json',
    '--max-count', String(maxMatches),
    query,
    absRoot,
  ], { encoding: 'utf8', shell: false });

  if (rgRes.status === 0 && rgRes.stdout) {
    const matches = [];
    for (const line of rgRes.stdout.split('\n')) {
      if (!line.trim()) continue;
      let payload = null;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      if (!payload || payload.type !== 'match' || !payload.data) continue;
      const abs = payload.data.path?.text;
      if (!abs) continue;
      const rel = path.relative(absRoot, abs).replace(/\\/g, '/');
      if (!isSearchableRel(rel)) continue;
      const content = String(payload.data.lines?.text || '').replace(/\r?\n$/, '').trim();
      matches.push({ file: rel, line: payload.data.line_number || 0, text: sanitizeContent(content) });
      if (matches.length >= maxMatches) break;
    }
    return matches;
  }

  // 降级尝试 git grep（输出为仓库相对路径，同样强制应用 brainignore 与敏感规则）
  const gitRes = spawnSync('git', ['-C', absRoot, 'grep', '-n', '-I', '--no-color', query], {
    encoding: 'utf8',
    shell: false,
  });

  if (gitRes.status === 0 && gitRes.stdout) {
    const matches = [];
    const lines = gitRes.stdout.split('\n').filter(Boolean);
    for (const line of lines) {
      const parts = line.split(':');
      if (parts.length >= 3) {
        const rel = parts[0].replace(/\\/g, '/');
        const lineNum = Number(parts[1]);
        const content = parts.slice(2).join(':').trim();
        if (!isSearchableRel(rel)) continue;
        matches.push({ file: rel, line: lineNum, text: sanitizeContent(content) });
        if (matches.length >= maxMatches) break;
      }
    }
    return matches;
  }

  return [];
}
