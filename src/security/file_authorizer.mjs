/**
 * file_authorizer.mjs - 单一文件授权入口
 * ---------------------------------------------------------------------------
 * 背景（来自两轮代码审查的 P1）：
 *   1) 此前 readFileSafe() 正确实现了"词法路径 + 真实物理路径"双重校验，但
 *      getUntrackedEvidence() / getGitDiff() 各自又实现（或干脆缺了）一套读取逻辑，
 *      于是出现 `debug.txt -> .env` 这类未跟踪 symlink 别名旁路；
 *   2) 进一步地，"安全策略根"与"当前操作根"必须分开：如果 .brainignore 从调用方
 *      选择的子 workspace 加载，Agent 只要把 workspace 指向 `project/secrets`，
 *      父级 `secrets/**` 规则就整体失效（固定了 filesystem trust root，却没固定
 *      policy root）。
 *
 * 现在所有"要把工作区文件内容送出浏览器边界"的路径都必须经过本模块：
 *   1. 工作区授权（workspace 必须落在宿主授权根内）
 *   2. 词法路径包含校验 + 符号链接逃逸校验（resolveSafePath）
 *   3. 敏感文件黑名单校验：workspace 相对路径与 policy 相对路径、词法与 realpath **四个变体**全覆盖
 *   4. .brainignore 校验：从 policyRoot 逐层累加（父子规则取并集，只增不减）后同样覆盖四个变体
 *   5. 普通文件校验与大小上限
 */

import fs from 'node:fs';
import path from 'node:path';
import { resolveSafePath, SecurityError } from './path_guard.mjs';
import { isSensitivePath } from './sensitive.mjs';
import { loadBrainIgnoreChain } from './ignore.mjs';
import { assertAuthorizedWorkspace, getPolicyRoot } from './authorized_workspace.mjs';

const DEFAULT_MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024; // 4MB

function toPosix(rel) {
  return process.platform === 'win32' ? rel.replace(/\\/g, '/') : rel;
}

/**
 * 计算 target 相对 base 的路径；越界时返回 null
 * @returns {string|null}
 */
function safeRelative(base, target) {
  const rel = path.relative(base, target);
  if (!rel || rel === '.') return '';
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return toPosix(rel);
}

/**
 * 创建"安全策略检查器"：把 workspace root（操作根）与 policy root（策略根）分离后，
 * 统一回答"这个绝对路径是否允许被送往云端模型"。
 *
 * @param {string} workspaceRoot 当前操作根（必须位于宿主授权根之内）
 * @returns {{
 *   workspace: string,
 *   policyRoot: string,
 *   check: (absPath: string, opts?: { requireExisting?: boolean }) => { ok: true, relPath: string, canonicalRelPath: string, policyRelPath: string, realPath: string } | { ok: false, code: string, message: string }
 * }}
 */
export function createPolicyChecker(workspaceRoot) {
  const workspace = assertAuthorizedWorkspace(workspaceRoot);
  const policyRoot = getPolicyRoot(workspace) || workspace;
  const realWorkspace = fs.existsSync(workspace) ? fs.realpathSync(workspace) : workspace;
  const realPolicyRoot = fs.existsSync(policyRoot) ? fs.realpathSync(policyRoot) : policyRoot;

  const check = (absPath, opts = {}) => {
    const lexicalAbs = path.resolve(absPath);

    let realPath = lexicalAbs;
    let exists = true;
    try {
      realPath = fs.realpathSync(lexicalAbs);
    } catch {
      exists = false;
      if (opts.requireExisting) {
        return { ok: false, code: 'E_INVALID_PATH', message: `无法解析文件物理路径: "${lexicalAbs}"` };
      }
    }

    const variants = [];
    const pushVariant = (label, rel) => {
      if (rel === null || rel === undefined) return false;
      if (!variants.some((v) => v.label === label)) variants.push({ label, rel });
      return true;
    };

    const wsLex = pushVariant('workspace', safeRelative(workspace, lexicalAbs));
    const wsReal = pushVariant('workspace-real', safeRelative(realWorkspace, realPath));
    // policy 变体一旦越界即为硬违规（策略根是最终边界）
    const policyLexRel = safeRelative(policyRoot, lexicalAbs);
    const policyRealRel = safeRelative(realPolicyRoot, realPath);
    if (policyLexRel === null || policyRealRel === null) {
      return {
        ok: false,
        code: 'E_WORKSPACE_ESCAPE',
        message: `路径 "${lexicalAbs}" 超出安全策略根 "${policyRoot}"`,
      };
    }
    pushVariant('policy', policyLexRel);
    pushVariant('policy-real', policyRealRel);

    if (wsLex === null || wsReal === null) {
      return {
        ok: false,
        code: 'E_WORKSPACE_ESCAPE',
        message: `路径 "${lexicalAbs}" 超出操作根 "${workspace}"`,
      };
    }

    // 1. 敏感文件：四个变体全覆盖
    for (const v of variants) {
      if (v.rel && isSensitivePath(v.rel)) {
        return {
          ok: false,
          code: 'E_SENSITIVE_FILE',
          message: `安全拦截: 禁止读取敏感文件 "${variants[0].rel}"${v.label === 'workspace' ? '' : ` (${v.label} 变体 "${v.rel}")`}`,
        };
      }
    }

    // 2. .brainignore：从 policyRoot 向下累加的规则链，四个变体全覆盖（只增不减）。
    //    必须在"路径尚不存在"时也能判定（词法目录同样能定位规则链），否则批量清单条目会被放行。
    const chainDir = exists ? path.dirname(realPath) : path.dirname(lexicalAbs);
    const chain = loadBrainIgnoreChain(policyRoot, chainDir);
    for (const v of variants) {
      if (v.rel && chain.ignores(v.rel, false)) {
        return {
          ok: false,
          code: 'E_IGNORED_FILE',
          message: `规则拦截: 文件 "${variants[0].rel}" (${v.label} 变体 "${v.rel}") 匹配 .brainignore 规则链`,
        };
      }
    }

    const byLabel = (label) => (variants.find((v) => v.label === label) || { rel: '' }).rel;
    return {
      ok: true,
      realPath,
      relPath: byLabel('workspace'),
      canonicalRelPath: byLabel('workspace-real'),
      policyRelPath: byLabel('policy'),
      canonicalPolicyRelPath: byLabel('policy-real'),
    };
  };

  return { workspace, policyRoot, check };
}

/**
 * 校验并返回一个可安全读取的文件描述符
 * @param {string} workspaceRoot 当前操作根（必须通过宿主授权）
 * @param {string} requestedPath 相对或绝对路径
 * @param {object} [options]
 * @param {number} [options.maxBytes] 单文件大小上限（默认 4MB）
 * @returns {{ root: string, policyRoot: string, absPath: string, realPath: string, relPath: string, canonicalRelPath: string, policyRelPath: string, size: number }}
 * @throws {SecurityError}
 */
export function authorizeCanonicalFile(workspaceRoot, requestedPath, options = {}) {
  const checker = createPolicyChecker(workspaceRoot);
  const safePath = resolveSafePath(checker.workspace, requestedPath);

  const verdict = checker.check(safePath, { requireExisting: true });
  if (!verdict.ok) {
    throw new SecurityError(verdict.message, verdict.code);
  }

  const stat = fs.statSync(verdict.realPath);
  if (!stat.isFile()) {
    throw new SecurityError(
      `无法读取非普通文件: "${verdict.relPath}"`,
      stat.isDirectory() ? 'E_IS_DIRECTORY' : 'E_NOT_A_FILE'
    );
  }

  const maxBytes = options.maxBytes || DEFAULT_MAX_SOURCE_FILE_BYTES;
  if (stat.size > maxBytes) {
    throw new SecurityError(
      `安全拦截: 源文件大小 (${stat.size} 字节) 超过单文件读取安全上限 (${Math.round(maxBytes / (1024 * 1024) * 100) / 100}MB): "${verdict.relPath}"`,
      'E_FILE_TOO_LARGE'
    );
  }

  return {
    root: checker.workspace,
    policyRoot: checker.policyRoot,
    absPath: safePath,
    realPath: verdict.realPath,
    relPath: verdict.relPath,
    canonicalRelPath: verdict.canonicalRelPath,
    policyRelPath: verdict.policyRelPath,
    size: stat.size,
  };
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

/**
 * 单点策略判定（用于 Git diff 文件清单、搜索结果等"批量条目"场景）：
 * 以宿主授权根为策略边界，判定给定绝对路径是否允许外发。
 * @param {string} workspaceRoot
 * @param {string} absPath
 * @returns {boolean}
 */
export function isPathAllowedByPolicy(workspaceRoot, absPath) {
  try {
    return createPolicyChecker(workspaceRoot).check(absPath).ok;
  } catch {
    return false;
  }
}
