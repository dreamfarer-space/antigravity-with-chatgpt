/**
 * ignore.mjs - .brainignore 规则解析与匹配器
 * ---------------------------------------------------------------------------
 * 零依赖支持基于规则的目录/文件忽略：
 *   - 支持通配符 *、**、?
 *   - 支持目录限定后缀 /
 *   - 支持 # 注释与空行过滤
 */

import fs from 'node:fs';
import path from 'node:path';

// 默认内置忽略清单
const DEFAULT_IGNORES = [
  'node_modules/',
  '.git/',
  '.svn/',
  '.hg/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  'coverage/',
  '*.pyc',
  '__pycache__/',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * 将简易 glob 模式编译为正则
 * @param {string} pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
  let isDirOnly = false;
  let clean = pattern.trim().replace(/\\/g, '/');

  if (clean.endsWith('/')) {
    isDirOnly = true;
    clean = clean.slice(0, -1);
  }

  let regexStr = '^';
  let i = 0;
  while (i < clean.length) {
    const c = clean[i];
    if (c === '*') {
      if (clean[i + 1] === '*') {
        // ** matches across directory boundaries
        regexStr += '.*';
        i += 2;
        if (clean[i] === '/') i++; // skip trailing slash after **
        continue;
      } else {
        // * matches within a path segment
        regexStr += '[^/]*';
      }
    } else if (c === '?') {
      regexStr += '[^/]';
    } else if (['.', '+', '^', '$', '(', ')', '{', '}', '[', ']', '|'].includes(c)) {
      regexStr += '\\' + c;
    } else {
      regexStr += c;
    }
    i++;
  }

  if (isDirOnly) {
    regexStr += '($|/.*)';
  } else {
    regexStr += '($|/.*)';
  }

  return new RegExp(regexStr, 'i');
}

export class BrainIgnore {
  constructor(patterns = []) {
    this.rules = [];
    for (const pat of [...DEFAULT_IGNORES, ...patterns]) {
      const trimmed = pat.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      this.rules.push({
        raw: trimmed,
        regex: globToRegex(trimmed),
        isDirOnly: trimmed.endsWith('/'),
      });
    }
  }

  /**
   * 检查相对路径是否匹配忽略规则
   * @param {string} relativePath 相对工作区路径
   * @param {boolean} isDirectory 是否为目录
   * @returns {boolean}
   */
  ignores(relativePath, isDirectory = false) {
    const norm = relativePath.replace(/\\/g, '/').replace(/^\//, '');
    for (const rule of this.rules) {
      if (rule.isDirOnly && !isDirectory && !norm.includes('/')) {
        continue;
      }
      if (rule.regex.test(norm)) return true;
      // Also test basename match for rules without slash
      if (!rule.raw.includes('/')) {
        const base = path.basename(norm);
        if (rule.regex.test(base)) return true;
      }
    }
    return false;
  }
}

/**
 * 加载工作区下的 .brainignore 配置
 * @param {string} workspaceRoot
 * @returns {BrainIgnore}
 */
export function loadBrainIgnore(workspaceRoot) {
  const ignoreFile = path.join(workspaceRoot, '.brainignore');
  let userPatterns = [];
  if (fs.existsSync(ignoreFile)) {
    try {
      const content = fs.readFileSync(ignoreFile, 'utf8');
      userPatterns = content.split('\n');
    } catch {}
  }
  return new BrainIgnore(userPatterns);
}

/**
 * 从安全策略根（policyRoot）一路向下累加收集 .brainignore 规则。
 *
 * 背景（P1）：如果只从"调用方选择的子 workspace"加载 .brainignore，那么
 * Agent 只要把 workspace 指向 `project/secrets` 这种子目录，父级的
 * `secrets/**` 规则就会整体失效 —— 固定了 filesystem trust root，
 * 却没固定 policy root。
 *
 * 因此策略必须从宿主授权的根开始累加，且**只允许增加限制**（父子规则取并集）。
 *
 * @param {string} policyRoot 安全策略根（通常为宿主授权根）
 * @param {string} targetDir 目标目录（含 targetDir 自身的 .brainignore）
 * @returns {BrainIgnore} 合并后的规则集
 */
export function loadBrainIgnoreChain(policyRoot, targetDir) {
  const root = path.resolve(policyRoot);
  const target = path.resolve(targetDir);

  const dirs = [root];
  const rel = path.relative(root, target);
  if (rel && rel !== '.' && !rel.startsWith('..')) {
    let current = root;
    for (const seg of rel.split(/[\\/]+/).filter((s) => s && s !== '.')) {
      current = path.join(current, seg);
      dirs.push(current);
    }
  }

  const patterns = [];
  for (const dir of dirs) {
    const ignoreFile = path.join(dir, '.brainignore');
    if (!fs.existsSync(ignoreFile)) continue;
    try {
      for (const line of fs.readFileSync(ignoreFile, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) patterns.push(trimmed);
      }
    } catch {}
  }

  return new BrainIgnore(patterns);
}
