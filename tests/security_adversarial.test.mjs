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
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolveSafePath, isPathContained, SecurityError } from '../src/security/path_guard.mjs';
import { sanitizeContent, isSensitivePath, redactSensitive } from '../src/security/sensitive.mjs';
import { runBrainTask, parseEvidenceRequests } from '../src/brain/orchestrator.mjs';
import { recordExecution } from '../src/execution/recorder.mjs';
import { getUntrackedEvidence, truncateUtf8ByBytes, getGitDiff, getReviewEvidence } from '../src/git/git_helper.mjs';
import { evaluate, getInjectionTimeout, SUBMIT_STATUS, insertTextReliable, submitMessageReliable } from '../src/transport/cdp_transport.mjs';
import { computeFingerprint, BROWSER_FINGERPRINT_SNIPPET } from '../src/transport/fingerprint.mjs';
import { selectTargetPage, filterChatGptPages } from '../src/transport/target_selector.mjs';

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

  // ---------------------------------------------------------------------------
  // 9. FNV-1a 指纹同构性与顺序敏感性测试
  // ---------------------------------------------------------------------------
  console.log('\n9. FNV-1a 指纹同构性与顺序敏感性测试:');

  test('computeFingerprint 顺序敏感性 ("abc" 与 "cba" 产生不同哈希)', () => {
    const fp1 = computeFingerprint('abc');
    const fp2 = computeFingerprint('cba');
    assert.equal(fp1.length, 3);
    assert.equal(fp2.length, 3);
    assert.notEqual(fp1.hash, fp2.hash);
  });

  test('computeFingerprint 与浏览器内联实现 100% 同构对齐', () => {
    const browserFn = new Function(BROWSER_FINGERPRINT_SNIPPET + '; return computeFingerprint;')();
    const testSamples = [
      '',
      'a',
      'hello world',
      'const x = 123;\nconst y = 456;',
      '中文字符测试：🚀 零依赖双脑架构！',
      'x'.repeat(25000),
    ];
    for (const sample of testSamples) {
      const nodeRes = computeFingerprint(sample);
      const browserRes = browserFn(sample);
      assert.deepEqual(nodeRes, browserRes, `Sample "${sample.slice(0, 20)}" 同构校验失败`);
    }
  });

  // ---------------------------------------------------------------------------
  // 10. 传输层自适应注入超时动态阶梯测试
  // ---------------------------------------------------------------------------
  console.log('\n10. 传输层自适应注入超时动态阶梯测试:');

  test('getInjectionTimeout 阶梯阈值计算验证 (20s ~ 180s)', () => {
    assert.equal(getInjectionTimeout(''), 20_000);
    assert.equal(getInjectionTimeout('x'.repeat(8192)), 20_000);
    assert.equal(getInjectionTimeout('x'.repeat(8193)), 60_000);
    assert.equal(getInjectionTimeout('x'.repeat(32768)), 60_000);
    assert.equal(getInjectionTimeout('x'.repeat(32769)), 90_000);
    assert.equal(getInjectionTimeout('x'.repeat(65536)), 90_000);
    assert.equal(getInjectionTimeout('x'.repeat(65537)), 120_000);
    assert.equal(getInjectionTimeout('x'.repeat(131072)), 120_000);
    assert.equal(getInjectionTimeout('x'.repeat(131073)), 180_000);
  });

  // ---------------------------------------------------------------------------
  // 11. 目标选择纯函数与 Fail-Closed 状态机测试
  // ---------------------------------------------------------------------------
  console.log('\n11. 目标选择纯函数与 Fail-Closed 状态机测试:');

  test('selectTargetPage 过滤非 ChatGPT 页面与初次绑定', () => {
    const pages = [
      { id: 'g1', type: 'page', url: 'https://www.google.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/g1' },
      { id: 'c1', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/c1' },
      { id: 'c2', type: 'page', url: 'https://chatgpt.com/c/6aaa-test', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/c2' },
    ];
    const r1 = selectTargetPage(pages, null);
    assert.equal(r1.target?.id, 'c1');
    assert.equal(r1.isNewBinding, true);

    const rPreferred = selectTargetPage(pages, null, { preferredId: 'c2' });
    assert.equal(rPreferred.target?.id, 'c2');
    assert.equal(rPreferred.isNewBinding, true);
  });

  test('selectTargetPage 粘性绑定维持 (Sticky Binding)', () => {
    const pages = [
      { id: 'c1', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/c1' },
      { id: 'c2', type: 'page', url: 'https://chatgpt.com/c/6aaa-test', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/c2' },
    ];
    const rSticky = selectTargetPage(pages, 'c2');
    assert.equal(rSticky.target?.id, 'c2');
    assert.equal(rSticky.isNewBinding, false);
  });

  test('selectTargetPage 已绑定目标丢失时抛错 (Fail-Closed 严禁静默漂移)', () => {
    const pages = [
      { id: 'c1', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/c1' },
    ];
    assert.throws(
      () => selectTargetPage(pages, 'c2_closed', { allowRebind: false }),
      /已绑定的 ChatGPT 目标标签页已关闭或丢失/
    );
  });

  test('selectTargetPage 显式允许重绑时平滑认领新标签页', () => {
    const pages = [
      { id: 'c1', type: 'page', url: 'https://chatgpt.com/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/c1' },
    ];
    const rRebind = selectTargetPage(pages, 'c2_closed', { allowRebind: true });
    assert.equal(rRebind.target?.id, 'c1');
    assert.equal(rRebind.isNewBinding, true);
  });

  // ---------------------------------------------------------------------------
  // 12. Git Diff 分页接口与真实跨边界凭据脱敏测试
  // ---------------------------------------------------------------------------
  console.log('\n12. Git Diff 分页接口与真实跨边界凭据脱敏测试:');

  test('getGitDiff 真实临时 Git 仓库跨分页边界凭据脱敏与分页切片验证', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'git-boundary-test-'));
    try {
      // 1. 初始化临时 Git 仓库并设置用户身份
      spawnSync('git', ['init', '-b', 'main'], { cwd: tempDir, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.name', 'TestUser'], { cwd: tempDir, encoding: 'utf8' });
      spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir, encoding: 'utf8' });

      // 2. 创建初始提交
      const testFile = path.join(tempDir, 'credentials.js');
      fs.writeFileSync(testFile, '// Initial empty line\n', 'utf8');
      spawnSync('git', ['add', '.'], { cwd: tempDir, encoding: 'utf8' });
      spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: tempDir, encoding: 'utf8' });

      // 3. 构造跨边界 payload：
      // 多字节中文字符 + 敏感 OpenAI API Key + 多行数据
      const mockKey = ['sk', 'proj', 'ABCD1234EFGH5678IJKL9012MNOP34567890QRSTUV'].join('-');
      const filler1 = 'console.log("中文填充行：世界你好！测试边界对齐与UTF-8多字节");\n';
      const secretLine = `const secretKey = "${mockKey}";\n`;
      const filler2 = 'console.log("后续测试代码行...");\n'.repeat(10);
      fs.writeFileSync(testFile, filler1 + secretLine + filler2, 'utf8');

      // 4. 读取第 1 页，预算设为 250 字节
      const page1 = getGitDiff(tempDir, { maxBytes: 250, offset: 0, head: true });
      assert.equal(page1.hasDiff, true);
      assert.equal(page1.hasMore, true);
      assert.ok(page1.nextOffset > 0);
      assert.ok(page1.returnedBytes <= 250);
      // 绝对不能包含未脱敏的 key 及其任何片段
      assert.ok(!page1.diff.includes(mockKey), 'Page 1 泄露了未脱敏密钥！');
      assert.ok(!page1.diff.includes('ABCD1234EFGH'), 'Page 1 泄露了部分未脱敏密钥片段！');

      // 5. 读取第 2 页（从 page1.nextOffset 开始）
      const page2 = getGitDiff(tempDir, { maxBytes: 400, offset: page1.nextOffset, head: true });
      assert.equal(page2.hasDiff, true);
      assert.ok(page2.returnedBytes <= 400);
      // 验证第 2 页成功匹配脱敏掩码，且绝不包含未脱敏的残余片段
      assert.ok(!page2.diff.includes(mockKey), 'Page 2 泄露了未脱敏密钥！');
      assert.ok(!page2.diff.includes('ABCD1234EFGH'), 'Page 2 泄露了跨界密钥残留！');
      assert.ok(!page2.diff.includes('MNOP34567890'), 'Page 2 泄露了跨界密钥尾部！');
      assert.ok(page2.diff.includes('[REDACTED_OPENAI_KEY]') || page2.diff.includes('[REDACTED_SECRET]'), 'Page 2 未能匹配脱敏掩码！');
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    }
  });

  test('getGitDiff 越界 offset 优雅返回空 diff', () => {
    const diffEmpty = getGitDiff(process.cwd(), { offset: 99999999 });
    assert.equal(diffEmpty.hasDiff, false);
    assert.equal(diffEmpty.diff, '');
    assert.equal(diffEmpty.hasMore, false);
    assert.equal(diffEmpty.nextOffset, null);
  });

  // ---------------------------------------------------------------------------
  // 13. 未跟踪文件证据绝对严格 Byte Budget 测试
  // ---------------------------------------------------------------------------
  console.log('\n13. 未跟踪文件证据绝对严格 Byte Budget 测试:');

  test('getUntrackedEvidence 严格全额预算测试 (含 Header、Fences、Truncation Marker)', () => {
    const tmpPath = path.join(process.cwd(), 'tests', 'fixtures_temp_budget_test.txt');
    fs.writeFileSync(tmpPath, 'A'.repeat(500), 'utf8');
    try {
      const res = getUntrackedEvidence(process.cwd(), ['tests/fixtures_temp_budget_test.txt'], 100);
      assert.ok(res.content.length > 0);
      const contentBytes = Buffer.byteLength(res.content, 'utf8');
      assert.ok(contentBytes <= 100, `contentBytes (${contentBytes}) 超出预算 100 字节`);
      assert.equal(res.truncated, true);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });

  // ---------------------------------------------------------------------------
  // 14. 真实软链接/Junction 根目录防逃逸测试
  // ---------------------------------------------------------------------------
  console.log('\n14. 真实软链接/Junction 根目录防逃逸测试:');

  test('resolveSafePath 真实临时软链接/Junction 根目录正常解析与跨界拦截', () => {
    const realRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'symlink-real-root-'));
    const linkRoot = path.join(os.tmpdir(), 'symlink-link-root-' + Date.now().toString(36));
    try {
      // 在真实目录下创建测试文件
      fs.writeFileSync(path.join(realRoot, 'index.js'), 'console.log("hello");', 'utf8');
      fs.mkdirSync(path.join(realRoot, 'sub'), { recursive: true });
      fs.writeFileSync(path.join(realRoot, 'sub', 'nested.txt'), 'nested content', 'utf8');

      // 创建软链接或 Junction 根目录
      const symlinkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(realRoot, linkRoot, symlinkType);

      // 测试 1: 软链接根目录下的正常文件解析成功，不报 E_WORKSPACE_ESCAPE
      const resolvedFile = resolveSafePath(linkRoot, 'index.js');
      assert.ok(resolvedFile.toLowerCase().includes('index.js'));

      // 测试 2: 软链接根目录下的子目录文件解析成功
      const resolvedNested = resolveSafePath(linkRoot, 'sub/nested.txt');
      assert.ok(resolvedNested.toLowerCase().includes('nested.txt'));

      // 测试 3: 尝试从软链接根目录向上逃逸跨界，必须严格拦截并抛出 SecurityError
      assert.throws(() => resolveSafePath(linkRoot, '../outside.txt'), (err) => {
        return err instanceof SecurityError && err.code === 'E_WORKSPACE_ESCAPE';
      });
    } finally {
      try {
        if (process.platform === 'win32') {
          fs.rmdirSync(linkRoot);
        } else {
          fs.unlinkSync(linkRoot);
        }
      } catch {}
      try { fs.rmSync(realRoot, { recursive: true, force: true }); } catch {}
    }
  });

  // ---------------------------------------------------------------------------
  // 15. 注入超时恢复与指纹校验状态机测试 (insertTextReliable)
  // ---------------------------------------------------------------------------
  console.log('\n15. 注入超时恢复与指纹校验状态机测试:');

  await testAsync('insertTextReliable: evaluate 超时但探针发现指纹匹配视为成功，坚决不重试', async () => {
    const testText = 'Hello reliable world';
    const expectedFp = computeFingerprint(testText);
    let callCount = 0;
    const mockCdp = {
      send: async (method, params) => {
        callCount++;
        if (params.expression.includes('pickVisible(COMPOSER)') && params.expression.includes('execCommand')) {
          // 模拟首次 evaluate 发生超时
          throw new Error('CDP 调用超时 (60000ms): Runtime.evaluate');
        }
        if (params.expression.includes('computeFingerprint(content)')) {
          // 模拟探针回读：指纹与长度已完全一致落入 DOM
          return {
            result: {
              value: {
                found: true,
                empty: false,
                length: expectedFp.length,
                hash: expectedFp.hash,
                isTextarea: false,
              },
            },
          };
        }
        return { result: { value: null } };
      },
    };
    const injectRes = await insertTextReliable(mockCdp, testText);
    assert.equal(injectRes.status, 'inserted');
    assert.equal(injectRes.timedOut, true);
    assert.equal(injectRes.verifiedAfterTimeout, true);
    assert.equal(injectRes.retryCount, 0); // 坚决不执行第二次注入！
  });

  await testAsync('insertTextReliable: evaluate 超时且指纹残缺时清空输入框并执行且仅执行 1 次受控重试', async () => {
    const testText = 'Retry test payload';
    const expectedFp = computeFingerprint(testText);
    let injectAttempts = 0;
    let clearCalled = false;
    const mockCdp = {
      send: async (method, params) => {
        if (params.expression.includes('execCommand(\'insertText\', false, str)')) {
          injectAttempts++;
          if (injectAttempts === 1) {
            throw new Error('CDP 调用超时 (60000ms): Runtime.evaluate');
          }
          return { result: { value: { ok: true } } };
        }
        if (params.expression.includes('el.innerHTML = \'\'') || params.expression.includes('el.value = \'\'')) {
          clearCalled = true;
          return { result: { value: true } };
        }
        if (params.expression.includes('computeFingerprint(content)')) {
          if (clearCalled && injectAttempts === 1) {
            // 清空后的空状态探针：验证已清空
            return {
              result: {
                value: {
                  found: true,
                  empty: true,
                  length: 0,
                  hash: '811c9dc5',
                  isTextarea: false,
                },
              },
            };
          }
          if (injectAttempts === 1) {
            // 首次探针：发现内容残缺或为空
            return {
              result: {
                value: {
                  found: true,
                  empty: false,
                  length: 3,
                  hash: 'badhash0',
                  isTextarea: false,
                },
              },
            };
          }
          // 重试注入后的探针：成功匹配
          return {
            result: {
              value: {
                found: true,
                empty: false,
                length: expectedFp.length,
                hash: expectedFp.hash,
                isTextarea: false,
              },
            },
          };
        }
        return { result: { value: null } };
      },
    };
    const retryRes = await insertTextReliable(mockCdp, testText);
    assert.equal(retryRes.status, 'inserted');
    assert.equal(retryRes.retryCount, 1);
    assert.equal(clearCalled, true);
    assert.equal(injectAttempts, 2);
  });

  // ---------------------------------------------------------------------------
  // 16. 提交强收据状态机测试 (submitMessageReliable)
  // ---------------------------------------------------------------------------
  console.log('\n16. 提交强收据状态机测试:');

  await testAsync('submitMessageReliable: User Turn 计数增加判定 SUBMITTED', async () => {
    let callCount = 0;
    const mockCdp = {
      send: async (method, params) => {
        if (method === 'Input.dispatchKeyEvent') return {};
        if (params.expression && params.expression.includes('isStreaming')) {
          callCount++;
          // 第 1 次调用为发送前基准 (turns = 1)，后续调用为收据探测 (turns = 2)
          const turns = callCount === 1 ? 1 : 2;
          return { result: { value: { userTurns: turns, isStreaming: false } } };
        }
        if (params.expression && params.expression.includes('pickVisible(SEND)')) {
          return { result: { value: { action: 'CLICKED' } } };
        }
        return { result: { value: true } };
      },
    };
    const submitRes = await submitMessageReliable(mockCdp);
    assert.equal(submitRes.status, SUBMIT_STATUS.SUBMITTED);
    assert.equal(submitRes.beforeUserTurns, 1);
    assert.equal(submitRes.afterUserTurns, 2);
  });

  await testAsync('submitMessageReliable: 超时未获得 User Turn 递增或 Stop 强收据判定 UNKNOWN (禁止重试)', async () => {
    const mockCdpUnknown = {
      send: async (method, params) => {
        if (method === 'Input.dispatchKeyEvent') return {};
        if (params.expression && params.expression.includes('isStreaming')) {
          // 模拟无增量、无流式响应
          return { result: { value: { userTurns: 1, isStreaming: false } } };
        }
        if (params.expression && params.expression.includes('pickVisible(SEND)')) {
          return { result: { value: { action: 'CLICKED' } } };
        }
        return { result: { value: true } };
      },
    };
    // 快速等待超时
    const submitRes = await submitMessageReliable(mockCdpUnknown, { checkTimeoutMs: 500 });
    assert.equal(submitRes.status, SUBMIT_STATUS.UNKNOWN);
    assert.equal(submitRes.beforeUserTurns, 1);
  });

  await testAsync('submitMessageReliable: 基准探测失败严禁假定为 0，直接进入 UNKNOWN', async () => {
    const mockCdpBaselineFail = {
      send: async (method, params) => {
        if (params?.expression?.includes('data-message-author-role="user"')) {
          throw new Error('CDP Evaluate Error: target context destroyed');
        }
        return { result: { value: null } };
      },
    };
    const res = await submitMessageReliable(mockCdpBaselineFail);
    assert.equal(res.status, SUBMIT_STATUS.UNKNOWN);
    assert.equal(res.reason, 'baseline_probe_failed');
  });

  await testAsync('submitMessageReliable: 预先存在流式输出时不误判为新提交收据 (防假阳性)', async () => {
    const mockCdpPreStreaming = {
      send: async (method, params) => {
        if (method === 'Input.dispatchKeyEvent') return {};
        if (params.expression && params.expression.includes('isStreaming')) {
          // 发送前已在流式输出，发送后仍是 1 轮且在流式输出
          return { result: { value: { userTurns: 1, isStreaming: true } } };
        }
        return { result: { value: true } };
      },
    };
    const submitRes = await submitMessageReliable(mockCdpPreStreaming, { checkTimeoutMs: 500 });
    assert.equal(submitRes.status, SUBMIT_STATUS.UNKNOWN);
    assert.equal(submitRes.beforeUserTurns, 1);
  });

  await testAsync('submitMessageReliable: 流式状态由 false 跃迁至 true 触发边沿收据判定 SUBMITTED', async () => {
    let probeCount = 0;
    const mockCdpEdgeTrigger = {
      send: async (method, params) => {
        if (method === 'Input.dispatchKeyEvent') return {};
        if (params.expression && params.expression.includes('isStreaming')) {
          probeCount++;
          // 第 1 次调用是基准：isStreaming 为 false
          // 后续轮询：isStreaming 变为 true
          return { result: { value: { userTurns: 1, isStreaming: probeCount > 1 } } };
        }
        return { result: { value: true } };
      },
    };
    const submitRes = await submitMessageReliable(mockCdpEdgeTrigger);
    assert.equal(submitRes.status, SUBMIT_STATUS.SUBMITTED);
    assert.equal(submitRes.streamingTransition, true);
  });

  await testAsync('submitMessageReliable: 发送按钮禁用时严禁回车且明确返回 NOT_SUBMITTED', async () => {
    let enterDispatched = false;
    const mockCdpDisabled = {
      send: async (method, params) => {
        if (method === 'Input.dispatchKeyEvent') {
          enterDispatched = true;
          return {};
        }
        if (params.expression && params.expression.includes('isStreaming')) {
          return { result: { value: { userTurns: 1, isStreaming: false } } };
        }
        if (params.expression && params.expression.includes('pickVisible(SEND)')) {
          return { result: { value: { action: 'DISABLED' } } };
        }
        return { result: { value: true } };
      },
    };
    const submitRes = await submitMessageReliable(mockCdpDisabled);
    assert.equal(submitRes.status, SUBMIT_STATUS.NOT_SUBMITTED);
    assert.equal(submitRes.reason, 'send_button_disabled');
    assert.equal(enterDispatched, false, '按钮禁用时不应触发 Enter 按键派发');
  });

  // ---------------------------------------------------------------------------
  // 17. 闭环证据拉取协议标签解析测试 (parseEvidenceRequests)
  // ---------------------------------------------------------------------------
  console.log('\n17. 闭环证据拉取协议标签解析测试:');

  test('parseEvidenceRequests 正确解析 git_diff 与 read_file 证据标签', () => {
    const rawModelOutput = `
I need more context before issuing my verdict.
<EVIDENCE_REQUEST>
{ "type": "git_diff", "offset": 32768, "maxBytes": 16384 }
</EVIDENCE_REQUEST>

Also need to check another file:
<EVIDENCE_REQUEST>
\`\`\`json
{ "type": "read_file", "path": "src/security/path_guard.mjs" }
\`\`\`
</EVIDENCE_REQUEST>
`;
    const reqs = parseEvidenceRequests(rawModelOutput);
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].type, 'git_diff');
    assert.equal(reqs[0].offset, 32768);
    assert.equal(reqs[0].maxBytes, 16384);
    assert.equal(reqs[1].type, 'read_file');
    assert.equal(reqs[1].path, 'src/security/path_guard.mjs');
  });

  test('parseEvidenceRequests 优雅处理无标签或畸变内容', () => {
    assert.deepEqual(parseEvidenceRequests('Normal text without request'), []);
    assert.deepEqual(parseEvidenceRequests('<EVIDENCE_REQUEST>invalid json{</EVIDENCE_REQUEST>'), []);
    assert.deepEqual(parseEvidenceRequests(null), []);
  });

  console.log(`\n========================================`);
  console.log(`对抗性与可靠性测试全部完成: ${passed}/${total} 通过 (100%)`);
  console.log(`========================================\n`);
  process.exit(0);
}

runAsyncTests().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
