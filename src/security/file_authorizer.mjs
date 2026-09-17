/**
 * file_authorizer.mjs - 单一文件授权入口
 * ---------------------------------------------------------------------------
 * 背景（来自代码审查的 P1）：
 *   此前 readFileSafe() 正确实现了"词法路径 + 真实物理路径"双重校验，但
 *   getUntrackedEvidence() / getGitDiff() 各自又实现（或干脆缺了）一套读取逻辑，
 *   于是出现 `debug.txt -> .env` 这类未跟踪 symlink 别名旁路。
 *
 * 现在所有"要把工作区文件内容送出浏览器边界"的路径都必须经过本函数：
 *   1. 工作区授权（宿主授权根，见 authorized_workspace.mjs）
 *   2. 词法路径包含校验 + 符号链接逃逸校验（resolveSafePath）
 *   3. lexical rel / canonical realpath 双重 sensitive 黑名单校验
 *   4. lexical rel / canonical realpath 双重 .brainignore 校验
 *   5. 普通文件校验与大小上限
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveSafePath, SecurityError } from './path_guard.mjs';
import { isSensitivePath } from './sensitive.mjs';
import { loadBrainIgnore } from './ignore.mjs';
import { assertAuthorizedWorkspace } from './authorized_workspace.mjs';

const DEFAULT_MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024; // 4MB

/**
 * 校验并返回一个可安全读取的文件描述符
 * @param {string} workspaceRoot 工作区根（必须通过宿主授权）
 * @param {string} requestedPath 相对或绝对路径
 * @param {object} [options]
 * @param {number} [options.maxBytes] 单文件大小上限（默认 4MB）
 * @returns {{ root: string, absPath: string, realPath: string, relPath: string, canonicalRelPath: string, size: number }}
 * @throws {SecurityError}
 */
export function authorizeCanonicalFile(workspaceRoot, requestedPath, options = {}) {
  const root = assertAuthorizedWorkspace(workspaceRoot);
  const safePath = resolveSafePath(root, requestedPath);
  const relPath = path.relative(root, safePath).replace(/\\/g, '/');

  // 1. 符号链接与真实物理路径解析（防 in-workspace symlink alias 绕过）
  let canonicalPath;
  let canonicalRelPath;
  try {
    canonicalPath = fs.realpathSync(safePath);
    const realRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
    canonicalRelPath = path.relative(realRoot, canonicalPath).replace(/\\/g, '/');
  } catch (err) {
    throw new SecurityError(`无法解析文件物理路径: "${relPath}" (${err.message})`, 'E_INVALID_PATH');
  }

  // 2. 词法路径与真实物理路径双重检查：敏感文件拦截
  if (isSensitivePath(relPath) || isSensitivePath(canonicalRelPath)) {
    throw new SecurityError(
      `安全拦截: 禁止读取敏感文件 "${relPath}"${canonicalRelPath !== relPath ? ` (指向敏感目标 "${canonicalRelPath}")` : ''}`,
      'E_SENSITIVE_FILE'
    );
  }

  // 3. 词法路径与真实物理路径双重检查：.brainignore 规则拦截
  const ignore = loadBrainIgnore(root);
  if (ignore.ignores(relPath, false) || ignore.ignores(canonicalRelPath, false)) {
    throw new SecurityError(
      `规则拦截: 文件 "${relPath}"${canonicalRelPath !== relPath ? ` (指向忽略目标 "${canonicalRelPath}")` : ''} 匹配 .brainignore`,
      'E_IGNORED_FILE'
    );
  }

  // 4. 普通文件与大小上限
  const stat = fs.statSync(canonicalPath);
  if (!stat.isFile()) {
    throw new SecurityError(`无法读取非普通文件: "${relPath}"`, stat.isDirectory() ? 'E_IS_DIRECTORY' : 'E_NOT_A_FILE');
  }

  const maxBytes = options.maxBytes || DEFAULT_MAX_SOURCE_FILE_BYTES;
  if (stat.size > maxBytes) {
    throw new SecurityError(
      `安全拦截: 源文件大小 (${stat.size} 字节) 超过单文件读取安全上限 (${Math.round(maxBytes / (1024 * 1024) * 100) / 100}MB): "${relPath}"`,
      'E_FILE_TOO_LARGE'
    );
  }

  return { root, absPath: safePath, realPath: canonicalPath, relPath, canonicalRelPath, size: stat.size };
}

/**
 * 判断某个（相对或绝对）路径是否可被安全送往云端模型；不抛错版本
 * @param {string} workspaceRoot
 * @param {string} requestedPath
 * @returns {boolean}
 */
export function isFileAuthorized(workspaceRoot, requestedPath) {
  try {
    authorizeCanonicalFile(workspaceRoot, requestedPath);
    return true;
  } catch {
    return false;
  }
}
