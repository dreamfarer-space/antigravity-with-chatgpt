/**
 * git_helper.mjs - 只读 Git 状态与 Diff 提取器
 * ---------------------------------------------------------------------------
 * 为闭环独立审查 (Closed-Loop Review) 与诊断提供真实版本控制事实：
 *   - 零依赖通过 child_process.spawnSync 读取
 *   - 严格无 shell 参数注入
 *   - 强制字节预算限制 (maxBytes)
 *   - 自动应用敏感内容脱敏
 */

import { spawnSync } from 'node:child_process';
import { sanitizeContent } from '../security/sensitive.mjs';

const DEFAULT_DIFF_MAX_BYTES = 64 * 1024; // 64 KB

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

  if (options.staged) {
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
