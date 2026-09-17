/**
 * authorized_workspace.mjs - 宿主授权工作区根（单一授权入口）
 * ---------------------------------------------------------------------------
 * 威胁模型：MCP / CLI 的调用者（本地 Agent，可能已被 prompt injection 影响）
 * 不得自行定义"安全沙箱"。否则 `resolveSafePath(workspaceRoot, p)` 只能保证
 * "不逃出调用者自己指定的根"，把 workspace 指成 `C:\` 或用户主目录即可让
 * 全部路径沙箱形同虚设（保护的是"攻击者指定的沙箱"而不是"宿主授权的工作区"）。
 *
 * 因此：
 *   1. 宿主（MCP Server / CLI）启动时用 pinAuthorizedWorkspace() 固化唯一授权根
 *      （默认取 CHATGPT_BRAIN_WORKSPACE 或进程 cwd，并 realpath 归一化）；
 *   2. 任何请求携带的 workspace 必须等于该根或严格位于其下，否则 fail-closed；
 *   3. 无论是否已固化授权根，都拒绝对"文件系统根 / 系统目录 / 用户主目录 / 临时目录根"
 *      这类明显不是项目工作区的目录开权限 —— 这条在库/嵌入模式下也生效，
 *      保证"单一授权逻辑"不会因为宿主忘记 pin 而静默失效。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { SecurityError, isContainedPath } from './path_guard.mjs';

let authorizedRoot = null;

function normalizeDrive(p) {
  if (process.platform === 'win32' && /^[a-zA-Z]:/.test(p)) {
    return p[0].toUpperCase() + p.slice(1);
  }
  return p;
}

function realpathOrSelf(p) {
  const abs = path.resolve(p);
  try {
    return normalizeDrive(fs.realpathSync(abs));
  } catch {
    return normalizeDrive(abs);
  }
}

/**
 * 明显不能作为工作区根的目录集合（精确匹配，不含其子目录）
 * @returns {Set<string>}
 */
function dangerousRoots() {
  const set = new Set();
  const add = (p) => {
    if (!p) return;
    try {
      set.add(realpathOrSelf(p));
    } catch {}
  };

  add(path.parse(process.cwd()).root); // 文件系统根 / 或盘符根
  add(os.homedir());
  add(os.tmpdir());
  add(os.homedir() && path.join(os.homedir(), '..')); // 家目录的父级（/home、C:\Users）

  if (process.platform === 'win32') {
    add(process.env.SystemRoot);
    add(process.env.windir);
    add(process.env.ProgramFiles);
    add(process.env['ProgramFiles(x86)']);
    add(process.env.ProgramData);
    add(process.env.APPDATA);
    add(process.env.LOCALAPPDATA);
    for (const drive of ['C:', 'D:', 'E:', 'F:']) add(drive + '\\');
  } else {
    for (const p of ['/etc', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/boot', '/root', '/var', '/sys', '/proc', '/dev', '/home', '/Users', '/private']) {
      add(p);
    }
  }
  return set;
}

/**
 * 拒绝把危险目录本身作为工作区根
 * @param {string} root 已 realpath 的绝对路径
 */
export function assertNotDangerousWorkspaceRoot(root) {
  if (dangerousRoots().has(root)) {
    throw new SecurityError(
      `拒绝将 "${root}" 作为工作区根目录（文件系统根 / 系统目录 / 用户主目录 / 临时目录根一律禁止）`,
      'E_DANGEROUS_WORKSPACE'
    );
  }
}

/**
 * 固化宿主授权工作区根（幂等：首次固化后重复调用不会改写，防止被调用者劫持）
 * @param {string} root
 * @returns {string} 已固化的授权根（realpath）
 */
export function pinAuthorizedWorkspace(root) {
  if (!root || typeof root !== 'string') {
    throw new SecurityError('授权工作区根必须为非空字符串', 'E_INVALID_WORKSPACE');
  }
  const real = realpathOrSelf(root);
  assertNotDangerousWorkspaceRoot(real);

  if (real !== normalizeDrive(path.resolve(root))) {
    // realpath 与词法路径不一致说明存在 symlink/junction 重定向，需按真实路径重新判定
    assertNotDangerousWorkspaceRoot(real);
  }

  if (!fs.existsSync(real)) {
    throw new SecurityError(`授权工作区根不存在: "${real}"`, 'E_INVALID_WORKSPACE');
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new SecurityError(`授权工作区根不是目录: "${real}"`, 'E_INVALID_WORKSPACE');
  }

  if (authorizedRoot === null) {
    authorizedRoot = real;
  }
  return authorizedRoot;
}

/** @returns {string|null} 已固化的授权根（未固化时为 null） */
export function getAuthorizedWorkspace() {
  return authorizedRoot;
}

/** 仅供测试使用：清除已固化的授权根 */
export function resetAuthorizedWorkspace() {
  authorizedRoot = null;
}

/**
 * 校验并归一化一个工作区路径
 * @param {string} candidate 调用者请求的工作区（绝对或相对路径）
 * @returns {string} realpath 归一化后的绝对路径
 * @throws {SecurityError} 危险根 / 超出宿主授权根 / 非法路径
 */
export function assertAuthorizedWorkspace(candidate) {
  if (!candidate || typeof candidate !== 'string') {
    throw new SecurityError('工作区路径必须为非空字符串', 'E_INVALID_WORKSPACE');
  }

  const real = realpathOrSelf(candidate);
  assertNotDangerousWorkspaceRoot(real);

  if (authorizedRoot === null) {
    // 库/嵌入模式：宿主未声明授权根，仅执行危险根拦截
    return real;
  }

  if (!isContainedPath(authorizedRoot, real)) {
    throw new SecurityError(
      `工作区 "${real}" 超出宿主授权根 "${authorizedRoot}"，已拒绝 (Fail-Closed)`,
      'E_UNAUTHORIZED_WORKSPACE'
    );
  }
  return real;
}

/**
 * 非抛错版本
 * @param {string} candidate
 * @returns {boolean}
 */
export function isAuthorizedWorkspace(candidate) {
  try {
    assertAuthorizedWorkspace(candidate);
    return true;
  } catch {
    return false;
  }
}
