/**
 * git_helper.mjs - 只读 Git 状态与 Diff 提取器
 * ---------------------------------------------------------------------------
 * 为闭环独立审查 (Closed-Loop Review) 与诊断提供真实版本控制事实：
 *   - 零依赖通过 child_process.spawnSync 读取
 *   - 严格无 shell 参数注入
 *   - 强制字节预算限制 (maxBytes)
 *   - 自动应用敏感内容脱敏
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sanitizeContent, isSensitivePath } from '../security/sensitive.mjs';
import { resolveSafePath } from '../security/path_guard.mjs';
import { loadBrainIgnore } from '../security/ignore.mjs';

const DEFAULT_DIFF_MAX_BYTES = 64 * 1024; // 64 KB
const DEFAULT_UNTRACKED_MAX_BYTES = 32 * 1024; // 32 KB

/**
 * 获取 Git 状态摘要
 * @param {string} workspaceRoot
 * @returns {object} { isGitRepo, branch, staged: [], modified: [], untracked: [], summary }
 */
export function getGitStatus(workspaceRoot) {
  try {
    const branchRes = spawnSync('git', ['-C', workspaceRoot, 'branch', '--show-current'], {
      encoding: 'utf8',
      shell: false,
    });
    if (branchRes.status !== 0) {
      return { isGitRepo: false, error: 'Not a git repository' };
    }

    const branch = (branchRes.stdout || '').trim();

    const statusRes = spawnSync('git', ['-C', workspaceRoot, 'status', '--porcelain=v1'], {
      encoding: 'utf8',
      shell: false,
    });

    const lines = (statusRes.stdout || '').split('\n').filter(Boolean);
    const staged = [];
    const modified = [];
    const untracked = [];

    for (const line of lines) {
      const code = line.slice(0, 2);
      const file = line.slice(3).trim();
      if (code.startsWith('?') || code.startsWith('U')) {
        untracked.push(file);
      } else {
        if (code[0] !== ' ' && code[0] !== '?') staged.push(file);
        if (code[1] !== ' ' && code[1] !== '?') modified.push(file);
      }
    }

    return {
      isGitRepo: true,
      branch,
      staged,
      modified,
      untracked,
      summary: `Branch: ${branch} | Staged: ${staged.length}, Modified: ${modified.length}, Untracked: ${untracked.length}`,
    };
  } catch (err) {
    return { isGitRepo: false, error: err.message };
  }
}

/**
 * 提取 Git Diff（带预算控制与安全脱敏）
 * @param {string} workspaceRoot
 * @param {object} options
 * @param {number} [options.maxBytes=65536]
 * @param {boolean} [options.staged=false]
 * @param {string} [options.file]
 * @returns {object} { hasDiff, diff, totalBytes, truncated }
 */
export function getGitDiff(workspaceRoot, options = {}) {
  const maxBytes = options.maxBytes || DEFAULT_DIFF_MAX_BYTES;
  const args = ['-C', workspaceRoot, 'diff'];

  if (options.head) {
    args.push('HEAD');
  } else if (options.staged) {
    args.push('--staged');
  }

  if (options.file) {
    args.push('--', options.file);
  }

  try {
    const res = spawnSync('git', args, {
      encoding: 'utf8',
      shell: false,
      maxBuffer: 4 * 1024 * 1024,
    });

    if (res.status !== 0) {
      if (options.head) {
        // HEAD 对比失败（可能尚无初始提交），降级回退普通 diff
        return getGitDiff(workspaceRoot, { ...options, head: false });
      }
      return { hasDiff: false, error: res.stderr || 'git diff failed' };
    }

    const rawDiff = res.stdout || '';
    const totalBytes = Buffer.byteLength(rawDiff, 'utf8');

    if (!rawDiff.trim()) {
      return { hasDiff: false, diff: '', totalBytes: 0, truncated: false };
    }

    let diffText = rawDiff;
    let truncated = false;

    if (totalBytes > maxBytes) {
      // 优雅按行截断
      const lines = rawDiff.split('\n');
      let accumulated = 0;
      const kept = [];
      for (const line of lines) {
        const lineBytes = Buffer.byteLength(line, 'utf8') + 1;
        if (accumulated + lineBytes > maxBytes) {
          truncated = true;
          break;
        }
        kept.push(line);
        accumulated += lineBytes;
      }
      kept.push(`\n... [DIFF TRUNCATED: ${(totalBytes / 1024).toFixed(1)} KB total, showed ${(accumulated / 1024).toFixed(1)} KB]`);
      diffText = kept.join('\n');
    }

    // 统一敏感信息脱敏
    const sanitized = sanitizeContent(diffText);

    return {
      hasDiff: true,
      diff: sanitized,
      totalBytes,
      truncated,
    };
  } catch (err) {
    return { hasDiff: false, error: err.message };
  }
}

/**
 * 按 UTF-8 字节数安全截断字符串，防止截断多字节字符且在字节维度严格受限
 * @param {string} text
 * @param {number} maxBytes
 * @returns {string}
 */
export function truncateUtf8ByBytes(text, maxBytes) {
  if (typeof text !== 'string') return '';
  if (maxBytes <= 0) return '';
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  let end = maxBytes;
  // UTF-8 续字节特征为 10xxxxxx (0x80 <= b <= 0xBF)
  // 若切在多字节字符的后续字节中，向前回退至该字符的起始引导字节
  while (end > 0 && (buf[end] & 0b11000000) === 0b10000000) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

/**
 * 安全抽取未跟踪文本文件的代码内容（受预算限制与安全沙箱脱敏）
 * @param {string} workspaceRoot
 * @param {Array<string>} untrackedFiles
 * @param {number} [maxBytes=32768]
 * @returns {object} { files: [], content: '', truncated: boolean }
 */
export function getUntrackedEvidence(workspaceRoot, untrackedFiles = [], maxBytes = DEFAULT_UNTRACKED_MAX_BYTES) {
  if (!untrackedFiles || untrackedFiles.length === 0) {
    return { files: [], content: '', truncated: false };
  }

  let ignoreChecker = null;
  try {
    ignoreChecker = loadBrainIgnore(workspaceRoot);
  } catch {}

  let accumulated = 0;
  let truncated = false;
  const blocks = [];
  const included = [];

  for (const rel of untrackedFiles) {
    if (accumulated >= maxBytes) {
      truncated = true;
      break;
    }

    if (isSensitivePath(rel)) continue;
    if (ignoreChecker && ignoreChecker.ignores(rel)) continue;

    try {
      const full = resolveSafePath(workspaceRoot, rel);
      const stat = fs.statSync(full);
      if (!stat.isFile() || stat.size === 0) continue;
      // 忽略过大的单个文件 (> 256 KB)
      if (stat.size > 256 * 1024) continue;

      const raw = fs.readFileSync(full, 'utf8');
      // 简单二元探测（含 NUL 字符通常为二进制）
      if (raw.includes('\0')) continue;

      const fileBytes = Buffer.byteLength(raw, 'utf8');
      let text = raw;
      const remainingBytes = Math.max(0, maxBytes - accumulated);
      if (fileBytes > remainingBytes) {
        text = truncateUtf8ByBytes(raw, remainingBytes) + '\n... [file truncated]';
        accumulated = maxBytes;
        truncated = true;
      } else {
        accumulated += fileBytes;
      }

      const safeText = sanitizeContent(text);
      blocks.push(`#### [NEW UNTRACKED FILE] \`${rel}\`\n\`\`\`\n${safeText}\n\`\`\``);
      included.push(rel);
    } catch {}
  }

  return {
    files: included,
    content: blocks.join('\n\n'),
    truncated,
  };
}

/**
 * 完整提取工作区闭环审查证据（Git 状态、HEAD Diff 与未跟踪文件内容清单）
 * @param {string} workspaceRoot
 * @param {object} options
 * @returns {object}
 */
export function getReviewEvidence(workspaceRoot, options = {}) {
  const status = getGitStatus(workspaceRoot);
  const maxBytes = options.maxBytes || DEFAULT_DIFF_MAX_BYTES;
  const untrackedMaxBytes = options.untrackedMaxBytes || DEFAULT_UNTRACKED_MAX_BYTES;

  if (!status.isGitRepo) {
    return {
      isGitRepo: false,
      summary: 'Not a git repository',
      hasDiff: false,
      diff: '',
      untracked: [],
      untrackedContent: '',
      staged: [],
      modified: [],
    };
  }

  // 优先对比 HEAD（同时覆盖已暂存与未暂存变更）
  let diffRes = getGitDiff(workspaceRoot, { ...options, head: true, maxBytes });
  if (!diffRes.hasDiff && !diffRes.error) {
    const stagedRes = getGitDiff(workspaceRoot, { ...options, staged: true, maxBytes });
    const unstagedRes = getGitDiff(workspaceRoot, { ...options, staged: false, maxBytes });
    if (stagedRes.hasDiff || unstagedRes.hasDiff) {
      diffRes = {
        hasDiff: true,
        diff: [stagedRes.diff, unstagedRes.diff].filter(Boolean).join('\n'),
        truncated: stagedRes.truncated || unstagedRes.truncated,
      };
    }
  }

  const untrackedEvidence = getUntrackedEvidence(workspaceRoot, status.untracked, untrackedMaxBytes);

  return {
    isGitRepo: true,
    branch: status.branch,
    summary: status.summary,
    staged: status.staged,
    modified: status.modified,
    untracked: status.untracked,
    untrackedContent: untrackedEvidence.content,
    hasDiff: Boolean(diffRes.hasDiff) || Boolean(untrackedEvidence.content),
    diff: diffRes.diff || '',
    truncated: diffRes.truncated || untrackedEvidence.truncated,
    error: diffRes.error || null,
  };
}
