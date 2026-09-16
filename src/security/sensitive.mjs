/**
 * sensitive.mjs - 敏感文件策略与文本内容脱敏
 * ---------------------------------------------------------------------------
 * 防止环境变量、私钥、证书、凭证进入云端模型上下文：
 *   - 文件名/路径黑名单（.env*、密钥、SSH凭据等）
 *   - 文本内容掩码（API Key、Token、私钥证书）
 */

import path from 'node:path';

// 允许放行的环境变量模版
const ALLOWED_ENV_TEMPLATES = new Set([
  '.env.example',
  '.env.template',
  '.env.sample',
  '.env.dist',
]);

// 敏感文件名与扩展名黑名单正则
const SENSITIVE_FILENAME_PATTERNS = [
  /^\.env(\..+)?$/i,
  /\.(pem|key|pkcs12|p12|pfx|kdbx|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^(credentials|secrets|shadow|passwd)(\..+)?$/i,
  /\.(secret|credential)$/i,
];

// 敏感目录正则
const SENSITIVE_DIR_PATTERNS = [
  /(^|[/\\])\.ssh([/\\]|$)/i,
  /(^|[/\\])\.aws([/\\]|$)/i,
  /(^|[/\\])\.kube([/\\]|$)/i,
  /(^|[/\\])\.gnupg([/\\]|$)/i,
  /(^|[/\\])\.config[/\\]gcloud([/\\]|$)/i,
];

/**
 * 判断指定路径是否为敏感文件
 * @param {string} relativeOrFilename 相对路径或文件名
 * @returns {boolean}
 */
export function isSensitivePath(relativeOrFilename) {
  const norm = relativeOrFilename.replace(/\\/g, '/').toLowerCase();
  const basename = path.basename(norm);

  // 1. 检查环境变量白名单
  if (ALLOWED_ENV_TEMPLATES.has(basename)) {
    return false;
  }

  // 2. 检查文件名黑名单
  for (const pat of SENSITIVE_FILENAME_PATTERNS) {
    if (pat.test(basename)) return true;
  }

  // 3. 检查敏感路径层级
  for (const pat of SENSITIVE_DIR_PATTERNS) {
    if (pat.test(norm)) return true;
  }

  return false;
}

// 内容掩码替换规则
const CONTENT_REDACTION_PATTERNS = [
  // 私钥块
  {
    regex: /-----BEGIN[ A-Z0-9_-]+PRIVATE KEY-----[\s\S]*?-----END[ A-Z0-9_-]+PRIVATE KEY-----/gi,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },
  // JWT Token
  {
    regex: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/g,
    replacement: '[REDACTED_JWT_TOKEN]',
  },
  // OpenAI API Key
  {
    regex: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
    replacement: '[REDACTED_OPENAI_KEY]',
  },
  // GitHub Personal Access Token
  {
    regex: /gh[pousr]_[A-Za-z0-9_]{36,255}/g,
    replacement: '[REDACTED_GITHUB_TOKEN]',
  },
  // AWS Access Key ID
  {
    regex: /\b(AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: '[REDACTED_AWS_KEY]',
  },
  // 通用敏感键值对 (e.g. password=..., secret=..., token=...)
  {
    regex: /((?:api_?key|secret|password|passwd|auth_?token|access_?token)\s*[:=]\s*["']?)([^"'\s\r\n]{6,})(["']?)/gi,
    replacement: '$1[REDACTED_SECRET]$3',
  },
  // Bearer Token / Authorization Header
  {
    regex: /(Bearer\s+)[A-Za-z0-9_\-\.]{20,}/gi,
    replacement: '$1[REDACTED_BEARER_TOKEN]',
  },
];

/**
 * 对向云端发送的文本内容进行安全脱敏掩码
 * @param {string} text 原始内容
 * @returns {string} 脱敏后内容
 */
export function sanitizeContent(text) {
  if (!text || typeof text !== 'string') return text;
  let sanitized = text;
  for (const { regex, replacement } of CONTENT_REDACTION_PATTERNS) {
    sanitized = sanitized.replace(regex, replacement);
  }
  return sanitized;
}

export const redactSensitive = sanitizeContent;
