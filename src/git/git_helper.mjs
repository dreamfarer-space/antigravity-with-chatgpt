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
import { sanitizeContent } from '../security/sensitive.mjs';
import { authorizeCanonicalFile, createPolicyChecker } from '../security/file_authorizer.mjs';
import { assertAuthorizedWorkspace } from '../security/authorized_workspace.mjs';

const DEFAULT_DIFF_MAX_BYTES = 64 * 1024; // 64 KB
const DEFAULT_UNTRACKED_MAX_BYTES = 32 * 1024; // 32 KB
const PATHSPEC_CHUNK_SIZE = 200;

/**
 * 解析 `git diff --name-status -z` 的 NUL 分隔输出
 * 输出形如：`M\0path\0`、`R100\0old\0new\0`、`C75\0old\0new\0`
 * @param {string} stdout
 * @returns {Array<{ status: string, code: string, paths: string[] }>}
 */
export function parseNameStatusZ(stdout) {
  const entries = [];
  if (typeof stdout !== 'string' || !stdout) return entries;

  const tokens = stdout.split('\0');
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i++];
    if (!status) continue;
    const code = status[0];

    if (code === 'R' || code === 'C') {
      const from = tokens[i++] || '';
      const to = tokens[i++] || '';
      const paths = [from, to].filter(Boolean);
      if (paths.length) entries.push({ status, code, paths });
    } else {
      const p = tokens[i++] || '';
      if (p) entries.push({ status, code, paths: [p] });
    }
  }
  return entries;
}

/**
 * 逐文件应用安全策略：敏感文件（sensitive 黑名单）与 .brainignore 一律不进 diff。
 *
 * 策略边界锚定在**宿主授权根（policy root）**而不是调用方选择的子 workspace，
 * 规则从 policyRoot 逐层累加（父子取并集，只增不减）——
 * 否则 Agent 只要把 workspace 指向 `project/secrets`，父级 `secrets/**` 就会失效。
 *
 * rename/copy 需要同时校验 old 与 new 两端（任一端命中即整体排除）。
 * @param {string} workspaceRoot
 * @param {Array<{ paths: string[] }>} entries
 * @returns {{ allowed: string[], excluded: string[] }}
 */
export function filterDiffEntriesByPolicy(workspaceRoot, entries) {
  const checker = createPolicyChecker(workspaceRoot);
  const allowed = [];
  const excluded = [];

  for (const entry of entries || []) {
    const paths = entry.paths || [];
    const offending = paths.length === 0 || paths.some((p) => {
      const abs = path.resolve(checker.workspace, String(p));
      return !checker.check(abs).ok;
    });

    if (offending) excluded.push(...paths);
    else allowed.push(...paths);
  }

  return { allowed, excluded };
}

/**
 * 解码 Git C-style 引号包围与转义的 pathname
 * @param {string} raw
 * @returns {string}
 */
export function unquoteGitPath(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s.startsWith('"') || !s.endsWith('"') || s.length < 2) {
    return s;
  }
  const inner = s.slice(1, -1);
  const bytes = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === '\\' && i + 1 < inner.length) {
      i++;
      const ch = inner[i];
      if (ch === 't') {
        bytes.push(0x09);
        i++;
      } else if (ch === 'n') {
        bytes.push(0x0a);
        i++;
      } else if (ch === 'r') {
        bytes.push(0x0d);
        i++;
      } else if (ch === 'b') {
        bytes.push(0x08);
        i++;
      } else if (ch === 'f') {
        bytes.push(0x0c);
        i++;
      } else if (ch === 'v') {
        bytes.push(0x0b);
        i++;
      } else if (ch === 'a') {
        bytes.push(0x07);
        i++;
      } else if (ch === '"' || ch === '\\') {
        bytes.push(ch.charCodeAt(0));
        i++;
      } else if (ch >= '0' && ch <= '7') {
        let octalStr = ch;
        i++;
        while (i < inner.length && octalStr.length < 3 && inner[i] >= '0' && inner[i] <= '7') {
          octalStr += inner[i];
          i++;
        }
        bytes.push(parseInt(octalStr, 8));
      } else {
        bytes.push(ch.charCodeAt(0));
        i++;
      }
    } else {
      const codePoint = inner.codePointAt(i);
      const charBuf = Buffer.from(String.fromCodePoint(codePoint), 'utf8');
      for (const b of charBuf) {
        bytes.push(b);
      }
      i += String.fromCodePoint(codePoint).length;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 解析非 -z porcelain 回退模式下的重命名路径对 <orig-path> -> <new-path>
 * 严谨识别 C-style 引号边界，防范文件名自身包含 " -> " 导致的拆分错误
 * @param {string} str
 * @returns {[string, string]|null}
 */
export function parseRenamePathPair(str) {
  if (typeof str !== 'string') return null;
  const raw = str.trim();

  let origRaw = '';
  let rest = '';

  if (raw.startsWith('"')) {
    // 首个路径是 C-style 引号包围，寻找未转义的闭合双引号
    let i = 1;
    let escaped = false;
    let quoteEnd = -1;
    while (i < raw.length) {
      if (escaped) {
        escaped = false;
      } else if (raw[i] === '\\') {
        escaped = true;
      } else if (raw[i] === '"') {
        quoteEnd = i;
        break;
      }
      i++;
    }

    if (quoteEnd !== -1) {
      origRaw = raw.slice(0, quoteEnd + 1);
      rest = raw.slice(quoteEnd + 1).trim();
    }
  } else {
    // 首个路径无引号，寻找第一个 ' -> '
    const arrowIdx = raw.indexOf(' -> ');
    if (arrowIdx !== -1) {
      origRaw = raw.slice(0, arrowIdx).trim();
      rest = '-> ' + raw.slice(arrowIdx + 4).trim();
    }
  }

  if (rest.startsWith('-> ')) {
    const targetRaw = rest.slice(3).trim();
    return [unquoteGitPath(origRaw), unquoteGitPath(targetRaw)];
  }

  return null;
}

/**
 * 解析 Git porcelain 输出（全面兼容 -z NUL 分隔、重命名 old -> new、引号与特殊字符）
 * @param {string} stdout
 * @returns {{ staged: string[], modified: string[], unmerged: string[], untracked: string[] }}
 */
export function parseGitStatusOutput(stdout) {
  const staged = [];
  const modified = [];
  const unmerged = [];
  const untracked = [];

  if (typeof stdout !== 'string' || !stdout) {
    return { staged, modified, unmerged, untracked };
  }

  if (stdout.includes('\0')) {
    const rawTokens = stdout.split('\0');
    let i = 0;
    while (i < rawTokens.length) {
      const token = rawTokens[i];
      if (!token) {
        i++;
        continue;
      }
      const code = token.slice(0, 2);
      const file = token.slice(3);
      i++;

      if (code.startsWith('!')) {
        continue;
      }

      const isUntracked = code.startsWith('?');
      const isUnmerged = code[0] === 'U' || code[1] === 'U' || code === 'AA' || code === 'DD';
      const hasExtraPath = code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C';
      const otherFile = hasExtraPath ? (rawTokens[i++] || '') : '';

      if (isUntracked) {
        if (file) untracked.push(file);
      } else if (isUnmerged) {
        if (file) unmerged.push(file);
      } else {
        // X 轴 (Index / Staged)
        if (code[0] === 'R' || code[0] === 'C') {
          if (file) staged.push(file);
          if (otherFile) staged.push(otherFile);
        } else if (code[0] !== ' ' && code[0] !== '?') {
          if (file) staged.push(file);
        }

        // Y 轴 (Worktree / Unstaged)
        if (code[1] === 'R' || code[1] === 'C') {
          if (file) modified.push(file);
          if (otherFile) modified.push(otherFile);
        } else if (code[1] !== ' ' && code[1] !== '?') {
          if (file) modified.push(file);
        }
      }
    }
  } else {
    // 换行分隔 porcelain 回退兼容
    for (const line of stdout.split('\n').filter(Boolean)) {
      const code = line.slice(0, 2);
      let file = line.slice(3).trim();

      if (code.startsWith('!')) {
        continue;
      }

      const isUntracked = code.startsWith('?');
      const isUnmerged = code[0] === 'U' || code[1] === 'U' || code === 'AA' || code === 'DD';
      const hasRenameOrCopy = code[0] === 'R' || code[0] === 'C' || code[1] === 'R' || code[1] === 'C';

      if (isUntracked) {
        const cleanFile = unquoteGitPath(file);
        if (cleanFile) untracked.push(cleanFile);
      } else if (isUnmerged) {
        const cleanFile = unquoteGitPath(file);
        if (cleanFile) unmerged.push(cleanFile);
      } else if (hasRenameOrCopy) {
        const renamePair = parseRenamePathPair(file);
        if (renamePair) {
          const [origPath, targetPath] = renamePair;
          // X 轴 (Index / Staged)
          if (code[0] === 'R' || code[0] === 'C') {
            staged.push(targetPath, origPath);
          } else if (code[0] !== ' ' && code[0] !== '?') {
            staged.push(targetPath);
          }

          // Y 轴 (Worktree / Unstaged)
          if (code[1] === 'R' || code[1] === 'C') {
            modified.push(targetPath, origPath);
          } else if (code[1] !== ' ' && code[1] !== '?') {
            modified.push(targetPath);
          }
        } else {
          const cleanFile = unquoteGitPath(file);
          if (cleanFile) {
            if (code[0] !== ' ' && code[0] !== '?') staged.push(cleanFile);
            if (code[1] !== ' ' && code[1] !== '?') modified.push(cleanFile);
          }
        }
      } else {
        const cleanFile = unquoteGitPath(file);
        if (cleanFile) {
          if (code[0] !== ' ' && code[0] !== '?') staged.push(cleanFile);
          if (code[1] !== ' ' && code[1] !== '?') modified.push(cleanFile);
        }
      }
    }
  }

  return {
    staged: Array.from(new Set(staged)),
    modified: Array.from(new Set(modified)),
    unmerged: Array.from(new Set(unmerged)),
    untracked: Array.from(new Set(untracked)),
  };
}

/**
 * 获取 Git 状态摘要
 * @param {string} workspaceRoot
 * @returns {object} { isGitRepo, branch, staged: [], modified: [], unmerged: [], untracked: [], summary }
 */
export function getGitStatus(workspaceRoot) {
  const root = assertAuthorizedWorkspace(workspaceRoot);
  try {
    const branchRes = spawnSync('git', ['-C', root, 'branch', '--show-current'], {
      encoding: 'utf8',
      shell: false,
    });
    if (branchRes.status !== 0) {
      return { isGitRepo: false, error: 'Not a git repository' };
    }

    const branch = (branchRes.stdout || '').trim();

    const statusRes = spawnSync('git', ['-C', root, 'status', '--porcelain=v1', '-z'], {
      encoding: 'utf8',
      shell: false,
    });

    const parsed = parseGitStatusOutput(statusRes.stdout || '');

    return {
      isGitRepo: true,
      branch,
      staged: parsed.staged,
      modified: parsed.modified,
      unmerged: parsed.unmerged,
      untracked: parsed.untracked,
      summary: `Branch: ${branch} | Staged: ${parsed.staged.length}, Modified: ${parsed.modified.length}, Unmerged: ${parsed.unmerged.length}, Untracked: ${parsed.untracked.length}`,
    };
  } catch (err) {
    return { isGitRepo: false, error: err.message };
  }
}

/**
 * 提取 Git Diff（带预算控制、分页支持与安全脱敏）
 * @param {string} workspaceRoot
 * @param {object} options
 * @param {number} [options.offset=0]
 * @param {number} [options.maxBytes=65536]
 * @param {boolean} [options.head=false]
 * @param {boolean} [options.staged=false]
 * @param {string} [options.file]
 * @returns {object} { hasDiff, diff, totalBytes, returnedBytes, offset, hasMore, nextOffset, truncated }
 */
export function getGitDiff(workspaceRoot, options = {}) {
  const root = assertAuthorizedWorkspace(workspaceRoot);
  const maxBytes = options.maxBytes || DEFAULT_DIFF_MAX_BYTES;
  const offset = Math.max(0, Number(options.offset) || 0);

  // 统一使用 --relative：让 name-status 的路径与随后 pathspec 的解析基准一致
  // （否则子目录工作区下 repo-root 相对路径会被当作 cwd 相对路径而匹配不到任何文件）
  const listArgs = ['-C', root, 'diff', '--relative', '--name-status', '-z'];
  if (options.head) listArgs.push('HEAD');
  else if (options.staged) listArgs.push('--staged');
  if (options.file) listArgs.push('--', options.file);

  // P1-4：先取文件清单 -> 逐文件安全授权 -> 只对通过授权的文件生成 patch。
  // 绝不能只依赖 sanitizeContent() 的正则（它无法替代文件级 deny policy）。
  const listRes = spawnSync('git', listArgs, { encoding: 'utf8', shell: false, maxBuffer: 8 * 1024 * 1024 });
  if (listRes.status !== 0) {
    if (options.head) {
      return getGitDiff(root, { ...options, head: false });
    }
    return {
      hasDiff: false,
      diff: '',
      totalBytes: 0,
      rawTotalBytes: 0,
      returnedBytes: 0,
      offset,
      hasMore: false,
      nextOffset: null,
      truncated: false,
      error: listRes.stderr || 'git diff --name-status failed',
    };
  }

  const entries = parseNameStatusZ(listRes.stdout || '');
  if (entries.length === 0) {
    return {
      hasDiff: false,
      diff: '',
      totalBytes: 0,
      rawTotalBytes: 0,
      returnedBytes: 0,
      offset,
      hasMore: false,
      nextOffset: null,
      truncated: false,
    };
  }

  const { allowed, excluded } = filterDiffEntriesByPolicy(root, entries);
  const filteredNotice = excluded.length
    ? `[DIFF FILTERED: ${excluded.length} path(s) excluded by security policy (.brainignore / sensitive-file rules): ${excluded.slice(0, 10).join(', ')}${excluded.length > 10 ? ' …' : ''}]\n`
    : '';

  if (allowed.length === 0) {
    // 变更全部被安全策略排除：只回传过滤说明，绝不回传任何被排除文件的内容
    const noticeBytes = Buffer.byteLength(filteredNotice, 'utf8');
    const diffText = offset >= noticeBytes ? '' : filteredNotice.slice(offset);
    return {
      hasDiff: Boolean(diffText),
      diff: diffText,
      totalBytes: noticeBytes,
      rawTotalBytes: noticeBytes,
      returnedBytes: Buffer.byteLength(diffText, 'utf8'),
      offset,
      hasMore: false,
      nextOffset: null,
      truncated: false,
      filtered: true,
      excludedPaths: excluded,
    };
  }

  const args = ['-C', root, 'diff', '--relative'];
  if (options.head) args.push('HEAD');
  else if (options.staged) args.push('--staged');

  try {
    let rawDiff = filteredNotice;
    for (let i = 0; i < allowed.length; i += PATHSPEC_CHUNK_SIZE) {
      const chunk = allowed.slice(i, i + PATHSPEC_CHUNK_SIZE);
      const res = spawnSync('git', [...args, '--', ...chunk], {
        encoding: 'utf8',
        shell: false,
        maxBuffer: 4 * 1024 * 1024,
      });
      if (res.status !== 0) {
        return {
          hasDiff: false,
          diff: '',
          totalBytes: 0,
          rawTotalBytes: 0,
          returnedBytes: 0,
          offset,
          hasMore: false,
          nextOffset: null,
          truncated: false,
          error: res.stderr || 'git diff failed',
        };
      }
      rawDiff += res.stdout || '';
    }

    if (!rawDiff.trim()) {
      return {
        hasDiff: false,
        diff: '',
        totalBytes: 0,
        rawTotalBytes: 0,
        returnedBytes: 0,
        offset,
        hasMore: false,
        nextOffset: null,
        truncated: false,
      };
    }

    // P1: Canonical sanitization first!
    // Sanitize the full canonical diff stream before any slicing or offset calculations
    // to prevent boundary-split secrets (e.g. API keys crossing chunk boundary) from bypassing redaction regex.
    const sanitizedFull = sanitizeContent(rawDiff);
    const rawTotalBytes = Buffer.byteLength(rawDiff, 'utf8');
    const totalBytes = Buffer.byteLength(sanitizedFull, 'utf8');

    if (offset >= totalBytes) {
      return {
        hasDiff: false,
        diff: '',
        totalBytes,
        rawTotalBytes,
        returnedBytes: 0,
        offset,
        hasMore: false,
        nextOffset: null,
        truncated: false,
      };
    }

    const safeBuf = Buffer.from(sanitizedFull, 'utf8');
    // 对齐 offset 到 UTF-8 起始字节
    let sliceStart = offset;
    while (sliceStart > 0 && (safeBuf[sliceStart] & 0b11000000) === 0b10000000) {
      sliceStart--;
    }

    const remainingBytes = totalBytes - sliceStart;
    let diffText = '';
    let hasMore = false;
    let nextOffset = null;
    let truncated = false;

    if (remainingBytes <= maxBytes) {
      // 剩余内容完全在预算内
      diffText = safeBuf.subarray(sliceStart).toString('utf8');
      hasMore = false;
      nextOffset = null;
      truncated = sliceStart > 0;
    } else {
      // 超出 maxBytes 预算，执行分页截断，且分页提示自身全额计入预算
      truncated = true;
      hasMore = true;

      // 预估标牌大小
      const markerTemplate = `\n... [DIFF PAGINATED: total ${totalBytes}B, slice [${sliceStart}..${sliceStart + maxBytes}], remaining ${remainingBytes}B. Next offset: ${sliceStart + maxBytes}]`;
      const reservedMarkerBytes = Buffer.byteLength(markerTemplate, 'utf8') + 30;
      const contentBudget = Math.max(0, maxBytes - reservedMarkerBytes);

      let sliceEnd = sliceStart + contentBudget;
      while (sliceEnd > sliceStart && (safeBuf[sliceEnd] & 0b11000000) === 0b10000000) {
        sliceEnd--;
      }

      const chunkBuf = safeBuf.subarray(sliceStart, sliceEnd);
      const chunkText = chunkBuf.toString('utf8');
      const lastNewline = chunkText.lastIndexOf('\n');

      let sliceText = chunkText;
      if (lastNewline > 0 && lastNewline > chunkText.length * 0.7) {
        sliceText = chunkText.slice(0, lastNewline);
      }

      const actualSliceBytes = Buffer.byteLength(sliceText, 'utf8');
      nextOffset = sliceStart + actualSliceBytes;
      if (nextOffset >= totalBytes) {
        hasMore = false;
        nextOffset = null;
      }

      const marker = hasMore
        ? `\n... [DIFF PAGINATED: ${(totalBytes / 1024).toFixed(1)} KB total; showing bytes ${sliceStart}..${nextOffset}; remaining ${(totalBytes - nextOffset)}B. Next offset: ${nextOffset}]`
        : '';

      diffText = sliceText + marker;
    }

    // 二次防御确保绝对满足 <= maxBytes
    if (Buffer.byteLength(diffText, 'utf8') > maxBytes) {
      diffText = truncateUtf8ByBytes(diffText, maxBytes);
    }

    const returnedBytes = Buffer.byteLength(diffText, 'utf8');

    return {
      hasDiff: true,
      diff: diffText,
      totalBytes,
      rawTotalBytes,
      returnedBytes,
      offset: sliceStart,
      hasMore,
      nextOffset,
      truncated,
      filtered: excluded.length > 0,
      excludedPaths: excluded,
    };
  } catch (err) {
    return {
      hasDiff: false,
      diff: '',
      totalBytes: 0,
      rawTotalBytes: 0,
      returnedBytes: 0,
      offset,
      hasMore: false,
      nextOffset: null,
      truncated: false,
      error: err.message,
    };
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
 * 预算核算严格包含 Markdown 围栏、Header 与截断标注自身，确保输出 UTF-8 字节 <= maxBytes
 * @param {string} workspaceRoot
 * @param {Array<string>} untrackedFiles
 * @param {number} [maxBytes=32768]
 * @returns {object} { files: [], content: '', truncated: boolean }
 */
export function getUntrackedEvidence(workspaceRoot, untrackedFiles = [], maxBytes = DEFAULT_UNTRACKED_MAX_BYTES) {
  if (!untrackedFiles || untrackedFiles.length === 0 || maxBytes <= 0) {
    return { files: [], content: '', truncated: false };
  }

  let accumulated = 0;
  let truncated = false;
  const blocks = [];
  const included = [];

  for (const rel of untrackedFiles) {
    if (accumulated >= maxBytes) {
      truncated = true;
      break;
    }

    try {
      // 单一文件授权入口：工作区授权 + 词法/realpath 双重 sensitive 与 .brainignore 校验。
      // 曾经这里只在 lexical 名称上做 isSensitivePath/ignore 判断，随后 statSync/readFileSync
      // 会跟随 symlink，导致 `debug.txt -> .env` 这类别名旁路（见 P1-3）。
      const authorized = authorizeCanonicalFile(workspaceRoot, rel, { maxBytes: 256 * 1024 });
      if (authorized.size === 0) continue;

      const raw = fs.readFileSync(authorized.realPath, 'utf8');
      // 简单二元探测（含 NUL 字符通常为二进制）
      if (raw.includes('\0')) continue;

      // P1: Canonical sanitization first!
      // Sanitize before computing fileBytes and applying budget truncation
      const sanitizedFile = sanitizeContent(raw);

      const header = `#### [NEW UNTRACKED FILE] \`${rel}\`\n\`\`\`\n`;
      const footer = `\n\`\`\``;
      const sep = blocks.length > 0 ? '\n\n' : '';
      const sepBytes = Buffer.byteLength(sep, 'utf8');
      const headerBytes = Buffer.byteLength(header, 'utf8');
      const footerBytes = Buffer.byteLength(footer, 'utf8');
      const overheadBytes = sepBytes + headerBytes + footerBytes;

      const remainingBytes = maxBytes - accumulated;
      if (remainingBytes <= overheadBytes) {
        // 预算连 header + footer 都放不下
        truncated = true;
        break;
      }

      const contentBudget = remainingBytes - overheadBytes;
      const fileBytes = Buffer.byteLength(sanitizedFile, 'utf8');
      let text = sanitizedFile;

      if (fileBytes > contentBudget) {
        truncated = true;
        const truncMarker = '\n... [file truncated]';
        const markerBytes = Buffer.byteLength(truncMarker, 'utf8');
        if (contentBudget <= markerBytes) {
          text = truncateUtf8ByBytes(sanitizedFile, contentBudget);
        } else {
          text = truncateUtf8ByBytes(sanitizedFile, contentBudget - markerBytes) + truncMarker;
        }
      }

      const block = `${header}${text}${footer}`;
      const blockTotalBytes = sepBytes + Buffer.byteLength(block, 'utf8');

      if (accumulated + blockTotalBytes > maxBytes) {
        const allowedBlockBytes = maxBytes - accumulated - sepBytes;
        if (allowedBlockBytes > 0) {
          const cutBlock = truncateUtf8ByBytes(block, allowedBlockBytes);
          blocks.push(cutBlock);
          included.push(rel);
        }
        truncated = true;
        break;
      }

      blocks.push(block);
      included.push(rel);
      accumulated += blockTotalBytes;

      if (truncated) {
        break;
      }
    } catch {}
  }

  let finalContent = blocks.join('\n\n');
  if (Buffer.byteLength(finalContent, 'utf8') > maxBytes) {
    finalContent = truncateUtf8ByBytes(finalContent, maxBytes);
    truncated = true;
  }

  return {
    files: included,
    content: finalContent,
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
      totalDiffBytes: 0,
      returnedDiffBytes: 0,
      hasMoreDiff: false,
      nextDiffOffset: null,
      untracked: [],
      unmerged: [],
      untrackedContent: '',
      staged: [],
      modified: [],
      truncated: false,
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
        totalBytes: (stagedRes.totalBytes || 0) + (unstagedRes.totalBytes || 0),
        returnedBytes: Buffer.byteLength([stagedRes.diff, unstagedRes.diff].filter(Boolean).join('\n'), 'utf8'),
        hasMore: stagedRes.hasMore || unstagedRes.hasMore,
        nextOffset: stagedRes.nextOffset || unstagedRes.nextOffset || null,
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
    unmerged: status.unmerged,
    untracked: status.untracked,
    untrackedContent: untrackedEvidence.content,
    hasDiff: Boolean(diffRes.hasDiff) || Boolean(untrackedEvidence.content),
    diff: diffRes.diff || '',
    totalDiffBytes: diffRes.totalBytes || 0,
    rawTotalDiffBytes: diffRes.rawTotalBytes || 0,
    returnedDiffBytes: diffRes.returnedBytes || Buffer.byteLength(diffRes.diff || '', 'utf8'),
    hasMoreDiff: Boolean(diffRes.hasMore),
    nextDiffOffset: diffRes.nextOffset ?? null,
    truncated: diffRes.truncated || untrackedEvidence.truncated,
    error: diffRes.error || null,
  };
}
