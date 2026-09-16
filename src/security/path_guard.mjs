/**
 * path_guard.mjs - 路径收敛与目录逃逸防护
 * ---------------------------------------------------------------------------
 * 确保所有被读取的文件严格收敛于给定的工作区根目录下：
 *   - 拦截 NUL 字符注入
 *   - 跨平台规范化（处理 Windows 大小写与斜杠）
 *   - 递归解析 deepest existing ancestor，防止符号链接逃逸
 *   - 检查真实物理路径 (realpath)
 */

import fs from 'node:fs';
import path from 'node:path';

export class SecurityError extends Error {
  constructor(message, code = 'E_WORKSPACE_ESCAPE') {
    super(message);
    this.name = 'SecurityError';
    this.code = code;
  }
}

function normalizeDrive(p) {
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(p)) {
    return p[0].toUpperCase() + p.slice(1);
  }
  return p;
}

function getDeepestExistingAncestor(p) {
  let current = path.resolve(p);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

/**
 * 校验并返回安全的规范化路径
 * @param {string} workspaceRoot 工作区根目录
 * @param {string} requestedPath 请求的文件或目录路径
 * @returns {string} 安全的绝对路径
 * @throws {SecurityError} 当路径逃逸出工作区时抛出
 */
export function resolveSafePath(workspaceRoot, requestedPath) {
  if (!requestedPath || typeof requestedPath !== 'string') {
    throw new SecurityError('无效的路径参数', 'E_INVALID_PATH');
  }

  // 1. 拦截 NUL 字符
  if (requestedPath.includes('\0')) {
    throw new SecurityError('路径包含非法 NUL 字符', 'E_PATH_NUL');
  }

  const absRoot = path.resolve(workspaceRoot);
  const realRoot = normalizeDrive(
    fs.existsSync(absRoot) ? fs.realpathSync(absRoot) : absRoot
  );

  // 2. 解析目标绝对路径
  const absTarget = path.isAbsolute(requestedPath)
    ? path.resolve(requestedPath)
    : path.resolve(absRoot, requestedPath);

  // 3. 严格相对路径判定包含关系 (跨平台原生语义，杜绝 Linux/macOS 大小写绕过)
  const isContained = (base, target) => {
    if (process.platform === 'win32') {
      const rel = path.win32.relative(base.toLowerCase(), target.toLowerCase());
      return rel === '' || (rel !== '..' && !rel.startsWith('..\\') && !path.win32.isAbsolute(rel));
    }
    const rel = path.posix.relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('../') && !path.posix.isAbsolute(rel));
  };

  // 4. 词法边界校验：目标路径必须收敛在工作区绝对根路径内
  if (!isContained(absRoot, absTarget)) {
    throw new SecurityError(
      `路径逃逸拦截: "${requestedPath}" 超出工作区边界 "${workspaceRoot}"`,
      'E_WORKSPACE_ESCAPE'
    );
  }

  // 5. 符号链接与真实路径校验：若目标已存在，验证其真实物理路径
  if (fs.existsSync(absTarget)) {
    const realTarget = normalizeDrive(fs.realpathSync(absTarget));
    if (!isContained(realRoot, realTarget)) {
      throw new SecurityError(
        `符号链接逃逸拦截: 真实目标 "${realTarget}" 超出工作区边界 "${workspaceRoot}"`,
        'E_WORKSPACE_ESCAPE'
      );
    }
  } else if (fs.existsSync(absRoot)) {
    // 若目标尚不存在但工作区存在，验证已存在的各级父目录是否通过符号链接逃逸出工作区
    const ancestor = getDeepestExistingAncestor(absTarget);
    if (ancestor && fs.existsSync(ancestor)) {
      const realAncestor = normalizeDrive(fs.realpathSync(ancestor));
      if (!isContained(realRoot, realAncestor)) {
        throw new SecurityError(
          `符号链接祖先逃逸拦截: 真实祖先 "${realAncestor}" 超出工作区边界 "${workspaceRoot}"`,
          'E_WORKSPACE_ESCAPE'
        );
      }
    }
  }

  return absTarget;
}

/**
 * 判断路径是否安全收敛
 */
export function isPathContained(workspaceRoot, requestedPath) {
  try {
    resolveSafePath(workspaceRoot, requestedPath);
    return true;
  } catch {
    return false;
  }
}
