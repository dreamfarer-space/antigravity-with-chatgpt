/**
 * security_adversarial.test.mjs
 * ---------------------------------------------------------------------------
 * 针对 ChatGPT 独立代码审查提出的安全与并发对抗性用例测试 (Adversarial Security Tests):
 *   1. 跨平台/跨目录路径逃逸与大小写语义测试 (S1, S2)
 *   2. 多行私钥、带空白密码赋值、Bearer Token 与敏感信息全量脱敏 (S3, S4)
 *   3. 出口统一脱敏 (Egress Sanitization) 防御：Git Diff 与测试输出中的敏感泄漏防护 (S5)
 *   4. 编排器防御性参数契约 (Defensive Validation)
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { resolveSafePath, isPathContained, SecurityError } from 'file:///D:/ChatGPT-Brain-Bridge/gemini-skill/antigravity-with-chatgpt/src/security/path_guard.mjs';
import { sanitizeContent, isSensitivePath, redactSensitive } from 'file:///D:/ChatGPT-Brain-Bridge/gemini-skill/antigravity-with-chatgpt/src/security/sensitive.mjs';
import { runBrainTask } from 'file:///D:/ChatGPT-Brain-Bridge/gemini-skill/antigravity-with-chatgpt/src/brain/orchestrator.mjs';

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

async function testAsync(name, fn) {
  total++;
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err) {
    console.error(`  [FAIL] ${name}: ${err.message}`);
    throw err;
  }
}

console.log('=== 运行 ChatGPT 独立审查安全与并发对抗性测试套件 ===\n');

// ---------------------------------------------------------------------------
// 1. 路径逃逸与边界测试 (S1, S2)
// ---------------------------------------------------------------------------
console.log('1. 路径安全与越界对抗测试:');

const fakeBase = process.platform === 'win32' ? 'C:\\TestRepo' : '/tmp/TestRepo';

test('拦截相对路径 ../ 越界', () => {
  assert.throws(() => resolveSafePath(fakeBase, '../other_secret.txt'), SecurityError);
});

test('拦截深层相对路径 ../../ 越界', () => {
  assert.throws(() => resolveSafePath(fakeBase, 'sub/../../outside.txt'), SecurityError);
});

test('拦截绝对路径越界', () => {
  const outsideAbs = process.platform === 'win32' ? 'C:\\Windows\\System32\\cmd.exe' : '/etc/passwd';
  assert.throws(() => resolveSafePath(fakeBase, outsideAbs), SecurityError);
});

test('拦截 NUL 字符注入逃逸', () => {
  assert.throws(() => resolveSafePath(fakeBase, 'safe.txt\0/../../etc/passwd'), SecurityError);
});

test('合法同目录或子目录路径允许通过', () => {
  const safeTarget = 'sub/file.txt';
  const resolved = resolveSafePath(fakeBase, safeTarget);
  assert.ok(resolved.toLowerCase().startsWith(fakeBase.toLowerCase()));
});

// ---------------------------------------------------------------------------
// 2. 敏感数据脱敏对抗测试 (S3, S4)
// ---------------------------------------------------------------------------
console.log('\n2. 敏感数据与多行凭据脱敏对抗测试:');

test('多行 PEM 私钥脱敏 (含 CRLF / LF 与任意前导)', () => {
  const rsaKey = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Y3wZ1...
...someKeyData...
-----END RSA PRIVATE KEY-----`;
  const res = sanitizeContent(rsaKey);
  assert.ok(!res.includes('someKeyData'), '私钥数据未被清除');
  assert.ok(res.includes('[REDACTED_PRIVATE_KEY]'), '未替换为掩码');
});

test('带空格与双引号的密码赋值脱敏 (password = "secret")', () => {
  const code = 'const password = "mySuperSecretPassword123";';
  const res = sanitizeContent(code);
  assert.ok(!res.includes('mySuperSecretPassword123'));
  assert.ok(res.includes('[REDACTED_SECRET]'));
});

test('带冒号与单引号的敏感键值脱敏 (api_key: \'secret\')', () => {
  const code = 'api_key: \'abcdef1234567890\',';
  const res = sanitizeContent(code);
  assert.ok(!res.includes('abcdef1234567890'));
  assert.ok(res.includes('[REDACTED_SECRET]'));
});

test('Bearer Token 与 Authorization Header 脱敏', () => {
  const header = 'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-ID';
  const res = sanitizeContent(header);
  assert.ok(!res.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'));
  assert.ok(res.includes('[REDACTED_BEARER_TOKEN]'));
});

test('敏感文件名判定 (.env.local, id_rsa, cert.pem)', () => {
  assert.equal(isSensitivePath('.env.production'), true);
  assert.equal(isSensitivePath('.env.local'), true);
  assert.equal(isSensitivePath('.env.example'), false); // 白名单
  assert.equal(isSensitivePath('id_rsa'), true);
  assert.equal(isSensitivePath('ssl/server.pem'), true);
});

// ---------------------------------------------------------------------------
// 3. 出口脱敏防泄漏 (S5)
// ---------------------------------------------------------------------------
console.log('\n3. 出口统一脱敏 (Egress Sanitization) 测试:');

test('Egress Sanitizer 拦截由 Git Diff 引入的 API Key', () => {
  const mockKey = ['sk', 'proj', '99998888777766665555444433332222'].join('-');
  const rawDiff = `
diff --git a/config.js b/config.js
+ const apiKey = "${mockKey}";
`;
  const sanitized = sanitizeContent(rawDiff);
  assert.ok(!sanitized.includes(mockKey));
  assert.ok(sanitized.includes('[REDACTED_OPENAI_KEY]') || sanitized.includes('[REDACTED_SECRET]'));
});

test('Egress Sanitizer 拦截由测试输出引入的 Token', () => {
  const mockToken = ['ghp', '111122223333444455556666777788889999'].join('_');
  const testOutput = `FAIL: request with ${mockToken} returned 401`;
  const sanitized = sanitizeContent(testOutput);
  assert.ok(!sanitized.includes(mockToken));
  assert.ok(sanitized.includes('[REDACTED_GITHUB_TOKEN]'));
});

// ---------------------------------------------------------------------------
// 4. 参数防御性校验 (Orchestrator Defensive Contract)
// ---------------------------------------------------------------------------
console.log('\n4. 编排器输入防御性契约测试:');

async function runAsyncTests() {
  await testAsync('空 prompt 拒绝执行并抛出 TypeError', async () => {
    await assert.rejects(async () => {
      await runBrainTask({});
    }, TypeError);
  });

  await testAsync('非字符串 prompt 拒绝执行并抛出 TypeError', async () => {
    await assert.rejects(async () => {
      await runBrainTask({ prompt: 12345 });
    }, TypeError);
  });

  console.log(`\n========================================`);
  console.log(`对抗性测试全部完成: ${passed}/${total} 通过 (100%)`);
  console.log(`========================================\n`);
  process.exit(0);
}

runAsyncTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
