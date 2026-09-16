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
import { resolveSafePath, isPathContained, SecurityError } from '../src/security/path_guard.mjs';
import { sanitizeContent, isSensitivePath, redactSensitive } from '../src/security/sensitive.mjs';
import { runBrainTask } from '../src/brain/orchestrator.mjs';
import { recordExecution } from '../src/execution/recorder.mjs';
import { getUntrackedEvidence, truncateUtf8ByBytes } from '../src/git/git_helper.mjs';
import { evaluate } from '../src/transport/cdp_transport.mjs';

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

  // ---------------------------------------------------------------------------
  // 5. 执行证据记录器严格输入契约校验 (recordExecution Input Validation)
  // ---------------------------------------------------------------------------
  console.log('\n5. 执行证据记录器输入契约校验:');

  test('recordExecution 拦截非对象或空参数', () => {
    assert.throws(() => recordExecution(null), TypeError);
    assert.throws(() => recordExecution(undefined), TypeError);
    assert.throws(() => recordExecution('invalid'), TypeError);
  });

  test('recordExecution 拦截缺失或空 command', () => {
    assert.throws(() => recordExecution({ command: '' }), TypeError);
    assert.throws(() => recordExecution({ command: '   ' }), TypeError);
    assert.throws(() => recordExecution({ command: null }), TypeError);
  });

  test('recordExecution 拦截缺失或非整数 exitCode (防隐式类型转换)', () => {
    assert.throws(() => recordExecution({ command: 'npm test' }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: 'abc' }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: 1.5 }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: false }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: true }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: '' }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: '0' }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: [] }), TypeError);
    assert.throws(() => recordExecution({ command: 'npm test', exitCode: NaN }), TypeError);
  });

  test('recordExecution 合法参数成功记录', () => {
    const rec = recordExecution({ command: 'npm test', exitCode: 0 });
    assert.equal(rec.command, 'npm test');
    assert.equal(rec.exitCode, 0);
  });

  // ---------------------------------------------------------------------------
  // 6. CDP evaluate 与 awaitPromise 回归测试 (awaitPromise Regression Tests)
  // ---------------------------------------------------------------------------
  console.log('\n6. CDP evaluate 与 awaitPromise 调度回归测试:');

  await testAsync('evaluate 默认设置 awaitPromise: false', async () => {
    const calls = [];
    const mockCdp = {
      send: async (method, params, timeout) => {
        calls.push({ method, params, timeout });
        return { result: { value: 42 } };
      },
    };
    const res = await evaluate(mockCdp, '1 + 1');
    assert.equal(res, 42);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'Runtime.evaluate');
    assert.equal(calls[0].params.awaitPromise, false);
  });

  await testAsync('evaluate 显式传递 awaitPromise: true 时正确透传', async () => {
    const calls = [];
    const mockCdp = {
      send: async (method, params, timeout) => {
        calls.push({ method, params, timeout });
        return { result: { value: true } };
      },
    };
    const res = await evaluate(mockCdp, 'new Promise(...)', { timeoutMs: 2500, awaitPromise: true });
    assert.equal(res, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.awaitPromise, true);
    assert.equal(calls[0].timeout, 2500);
  });

  // ---------------------------------------------------------------------------
  // 7. 未跟踪文件内容证据提取与脱敏测试 (Untracked Files Content Evidence)
  // ---------------------------------------------------------------------------
  console.log('\n7. 未跟踪文件内容证据提取与脱敏测试:');

  test('getUntrackedEvidence 自动跳过敏感文件并提取普通文本', () => {
    const evidence = getUntrackedEvidence(process.cwd(), ['.env', 'package.json', 'nonexistent.txt']);
    assert.ok(!evidence.files.includes('.env'));
    assert.ok(evidence.files.includes('package.json'));
    assert.ok(evidence.content.includes('[NEW UNTRACKED FILE]'));
    assert.ok(evidence.content.includes('antigravity-with-chatgpt'));
  });

  // ---------------------------------------------------------------------------
  // 8. UTF-8 字节边界安全截断测试 (truncateUtf8ByBytes)
  // ---------------------------------------------------------------------------
  console.log('\n8. UTF-8 字节边界安全截断测试:');

  test('truncateUtf8ByBytes 不拆散多字节 UTF-8 字符且字节数严格受限', () => {
    const mixed = 'Hello 世界! 🚀';
    // 'Hello ' = 6 bytes
    // '世' = 3 bytes (E4 B8 96)
    // '界' = 3 bytes (E7 95 8C)
    // '!' = 1 byte
    // ' ' = 1 byte
    // '🚀' = 4 bytes (F0 9F 9A 80)
    // 切在 '世' 字符中间 (7 bytes) -> 必须回退到 'Hello ' (6 bytes)
    const t1 = truncateUtf8ByBytes(mixed, 7);
    assert.equal(t1, 'Hello ');
    assert.ok(Buffer.byteLength(t1, 'utf8') <= 7);

    // 刚好完整容纳 '世' (9 bytes) -> 'Hello 世'
    const t2 = truncateUtf8ByBytes(mixed, 9);
    assert.equal(t2, 'Hello 世');
    assert.equal(Buffer.byteLength(t2, 'utf8'), 9);

    // 切在 '界' 中间 (10 bytes) -> 必须回退到 'Hello 世' (9 bytes)
    const t3 = truncateUtf8ByBytes(mixed, 10);
    assert.equal(t3, 'Hello 世');
    assert.ok(Buffer.byteLength(t3, 'utf8') <= 10);

    // 超过长度时返回原串
    assert.equal(truncateUtf8ByBytes(mixed, 100), mixed);

    // 空串与 0 边界
    assert.equal(truncateUtf8ByBytes(mixed, 0), '');
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
