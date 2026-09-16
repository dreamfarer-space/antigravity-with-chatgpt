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
import { resolveSafePath, isPathContained, canonicalizeManifestPath, SecurityError } from '../src/security/path_guard.mjs';
import { sanitizeContent, isSensitivePath, redactSensitive } from '../src/security/sensitive.mjs';
import { runBrainTask, parseEvidenceRequests, buildEvidenceRoundSnippets, MAX_AGGREGATE_EVIDENCE_BYTES } from '../src/brain/orchestrator.mjs';
import { recordExecution } from '../src/execution/recorder.mjs';
import { getUntrackedEvidence, truncateUtf8ByBytes, getGitDiff, getReviewEvidence, parseGitStatusOutput, unquoteGitPath, parseRenamePathPair } from '../src/git/git_helper.mjs';
import { evaluate, getInjectionTimeout, SUBMIT_STATUS, insertTextReliable, submitMessageReliable, verifyUnknownReceiptOrThrow } from '../src/transport/cdp_transport.mjs';
import { readFileSafe } from '../src/workspace/context_provider.mjs';
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

  // ---------------------------------------------------------------------------
  // 18. readFileSafe 安全加固测试 (!stat.isFile 与 4MB 内存防护)
  // ---------------------------------------------------------------------------
  console.log('\n18. readFileSafe 安全加固测试:');

  test('readFileSafe 拦截目录读取并抛出 E_IS_DIRECTORY', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-readsafe-dir-'));
    try {
      const subDir = path.join(tmpDir, 'subdir');
      fs.mkdirSync(subDir);
      assert.throws(
        () => readFileSafe(tmpDir, 'subdir'),
        (err) => err instanceof SecurityError && err.code === 'E_IS_DIRECTORY'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('readFileSafe 拦截大于 4MB 的超大文件并抛出 E_FILE_TOO_LARGE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-readsafe-large-'));
    try {
      const largeFile = path.join(tmpDir, 'large.txt');
      fs.writeFileSync(largeFile, Buffer.alloc(4 * 1024 * 1024 + 16, 65)); // 4MB + 16B
      assert.throws(
        () => readFileSafe(tmpDir, 'large.txt'),
        (err) => err instanceof SecurityError && err.code === 'E_FILE_TOO_LARGE'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('readFileSafe 拦截指向 .env 的工作区内符号链接别名并抛出 E_SENSITIVE_FILE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-symlink-alias-'));
    try {
      const envPath = path.join(tmpDir, '.env');
      fs.writeFileSync(envPath, 'SECRET_KEY=leak_attempt_via_symlink', 'utf8');
      const aliasPath = path.join(tmpDir, 'harmless_alias.txt');
      fs.symlinkSync(envPath, aliasPath, 'file');
      assert.throws(
        () => readFileSafe(tmpDir, 'harmless_alias.txt'),
        (err) => err instanceof SecurityError && err.code === 'E_SENSITIVE_FILE'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('readFileSafe 拦截指向 .brainignore 忽略文件的符号链接别名并抛出 E_IGNORED_FILE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'test-symlink-ignore-'));
    try {
      fs.writeFileSync(path.join(tmpDir, '.brainignore'), 'ignored_dir/\n', 'utf8');
      fs.mkdirSync(path.join(tmpDir, 'ignored_dir'));
      const secretFile = path.join(tmpDir, 'ignored_dir', 'hidden.txt');
      fs.writeFileSync(secretFile, 'confidential data', 'utf8');
      const aliasPath = path.join(tmpDir, 'innocent_alias.txt');
      fs.symlinkSync(secretFile, aliasPath, 'file');
      assert.throws(
        () => readFileSafe(tmpDir, 'innocent_alias.txt'),
        (err) => err instanceof SecurityError && err.code === 'E_IGNORED_FILE'
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 19. UNKNOWN 提交收据因果性 Fail-Closed 校验测试
  // ---------------------------------------------------------------------------
  console.log('\n19. UNKNOWN 提交收据因果性 Fail-Closed 校验测试:');

  await testAsync('verifyUnknownReceiptOrThrow: baseline_probe_failed 立即抛错中止，严禁二次弱证据放行', async () => {
    const dummyCdp = {
      send: async () => {
        throw new Error('should not probe');
      },
    };
    await assert.rejects(
      async () => {
        await verifyUnknownReceiptOrThrow(dummyCdp, { status: SUBMIT_STATUS.UNKNOWN, reason: 'baseline_probe_failed' }, 0);
      },
      /提交基准获取失败/
    );
  });

  await testAsync('verifyUnknownReceiptOrThrow: receipt_timeout 时即便 stopButton 存在且 assistant 回合增加，但 userTurns 未递增也必须中止 (防因果断裂)', async () => {
    const mockCdpOldStreaming = {
      send: async (method, params) => {
        if (params?.expression) {
          // 旧的流式输出：stopButton 为 true，assistant.count 为 2 (递增)，但 userTurn.count 仍为 1 (未因本次提交递增)
          return {
            result: {
              value: {
                stopButton: { found: true },
                assistant: { count: 2, len: 100, hash: 123 },
                userTurn: { count: 1 },
              },
            },
          };
        }
        return { result: { value: null } };
      },
    };

    await assert.rejects(
      async () => {
        await verifyUnknownReceiptOrThrow(mockCdpOldStreaming, { status: SUBMIT_STATUS.UNKNOWN, reason: 'receipt_timeout', beforeUserTurns: 1 }, 1);
      },
      /提交消息状态未知/
    );
  });

  await testAsync('verifyUnknownReceiptOrThrow: receipt_timeout 时明确探测到 userTurn 递增才允许通过 (因果强收据)', async () => {
    const mockCdpTurnIncrement = {
      send: async (method, params) => {
        if (params?.expression) {
          return {
            result: {
              value: {
                stopButton: { found: true },
                assistant: { count: 2, len: 50, hash: 456 },
                userTurn: { count: 2 },
              },
            },
          };
        }
        return { result: { value: null } };
      },
    };

    const res = await verifyUnknownReceiptOrThrow(mockCdpTurnIncrement, { status: SUBMIT_STATUS.UNKNOWN, reason: 'receipt_timeout', beforeUserTurns: 1 }, 1);
    assert.equal(res.userTurn.count, 2);
  });

  await testAsync('verifyUnknownReceiptOrThrow: 缺少或非法 beforeUserTurns 基准计数时立即抛错 fail-closed (防预存回合假阳性)', async () => {
    const mockCdpPreExisting = {
      send: async (method, params) => {
        if (params?.expression) {
          return {
            result: {
              value: {
                stopButton: { found: true },
                assistant: { count: 5, len: 100, hash: 123 },
                userTurn: { count: 5 },
              },
            },
          };
        }
        return { result: { value: null } };
      },
    };

    // submitReceipt 为 null 或 undefined
    await assert.rejects(
      async () => {
        await verifyUnknownReceiptOrThrow(mockCdpPreExisting, null, 5);
      },
      /submitReceipt 必须为非空对象/
    );

    await assert.rejects(
      async () => {
        await verifyUnknownReceiptOrThrow(mockCdpPreExisting, undefined, 5);
      },
      /submitReceipt 必须为非空对象/
    );

    // beforeUserTurns 缺失
    await assert.rejects(
      async () => {
        await verifyUnknownReceiptOrThrow(mockCdpPreExisting, { status: SUBMIT_STATUS.UNKNOWN, reason: 'receipt_timeout' }, 5);
      },
      /submitReceipt 缺少合法的 user-turn 基准计数/
    );

    // beforeUserTurns 为 null / NaN / 小数 / 字符串 / 负数
    for (const badValue of [null, NaN, 1.5, '5', -1]) {
      await assert.rejects(
        async () => {
          await verifyUnknownReceiptOrThrow(mockCdpPreExisting, { status: SUBMIT_STATUS.UNKNOWN, reason: 'receipt_timeout', beforeUserTurns: badValue }, 5);
        },
        /submitReceipt 缺少合法的 user-turn 基准计数/
      );
    }
  });

  // ---------------------------------------------------------------------------
  // 20. 闭环证据拉取生产实现测试 (128KB 序列化预算记账、截断与 Confused-Deputy)
  // ---------------------------------------------------------------------------
  console.log('\n20. 闭环证据拉取安全性测试 (生产 buildEvidenceRoundSnippets 序列化总上限记账):');

  test('Evidence protocol: 生产 buildEvidenceRoundSnippets 限制单轮上限 (8项) 且拒绝片段全额计入预算', () => {
    const manifestFiles = new Set(['src/index.js']);
    // 构造 100 个清单外的恶意读取请求
    const attackRequests = [];
    for (let i = 1; i <= 100; i++) {
      attackRequests.push({
        type: 'read_file',
        path: `outside-file-${String(i).padStart(4, '0')}.txt`,
      });
    }

    // 单轮处理：必须被截断至最多 8 个请求
    const round1 = buildEvidenceRoundSnippets({
      requests: attackRequests,
      workspace: os.tmpdir(),
      reviewManifestFiles: manifestFiles,
      currentAggregateBytes: 0,
      maxAggregateBytes: MAX_AGGREGATE_EVIDENCE_BYTES,
      round: 1,
    });

    // 应该包含 1 条截断提示 + 8 条拒绝证据
    assert.ok(round1.snippets.length <= 9);
    assert.ok(round1.snippets.some((s) => s.includes('Per-round evidence request cap')));
    assert.ok(round1.snippets.some((s) => s.includes('outside-file-0001.txt')));

    // 核心断言：拒绝片段必须全额增加 aggregateBytes，严禁保持为 0！
    assert.ok(round1.newAggregateBytes > 0, '拒绝片段必须消耗序列化字节预算');

    // 持续多轮累加测试：当累积达到 128KB 预算时，触发 budgetReached 且字节永不超上限
    let rollingBytes = round1.newAggregateBytes;
    let roundNum = 2;
    let finalBudgetReached = false;

    for (let loop = 0; loop < 200; loop++) {
      const res = buildEvidenceRoundSnippets({
        requests: attackRequests,
        workspace: os.tmpdir(),
        reviewManifestFiles: manifestFiles,
        currentAggregateBytes: rollingBytes,
        maxAggregateBytes: MAX_AGGREGATE_EVIDENCE_BYTES,
        round: roundNum++,
      });
      rollingBytes = res.newAggregateBytes;
      if (res.budgetReached) {
        finalBudgetReached = true;
        break;
      }
    }

    assert.equal(finalBudgetReached, true, '多轮攻击后必须触发 budgetReached 截断');
    assert.ok(rollingBytes <= MAX_AGGREGATE_EVIDENCE_BYTES, `总序列化证据字节 (${rollingBytes}) 必须严格 <= ${MAX_AGGREGATE_EVIDENCE_BYTES}`);
  });

  test('Evidence protocol: MAX_PATH_LENGTH 超长请求路径拦截', () => {
    const manifestFiles = new Set(['src/index.js']);
    const longPath = 'a/'.repeat(200) + 'test.js'; // > 400 字符
    const res = buildEvidenceRoundSnippets({
      requests: [{ type: 'read_file', path: longPath }],
      workspace: os.tmpdir(),
      reviewManifestFiles: manifestFiles,
      currentAggregateBytes: 0,
    });
    assert.ok(res.snippets.some((s) => s.includes('exceeds maximum allowed length')));
  });

  test('Evidence protocol: 脱敏展开 (Sanitizer-Expanding) 路径在预算天花板边缘严格受控', () => {
    const manifestFiles = new Set(['src/index.js']);
    // 构造带敏感关键字的请求路径，脱敏后将展开变长：password="abc" -> [REDACTED_SECRET]
    const expandingRequests = [
      { type: 'read_file', path: 'outside/password="123456"/test.txt' },
      { type: 'read_file', path: 'outside/api_key="sk-123456789012345678901234567890"/test.txt' },
    ];
    const res = buildEvidenceRoundSnippets({
      requests: expandingRequests,
      workspace: os.tmpdir(),
      reviewManifestFiles: manifestFiles,
      currentAggregateBytes: MAX_AGGREGATE_EVIDENCE_BYTES - 300, // 距离天花板仅 300 字节
      maxAggregateBytes: MAX_AGGREGATE_EVIDENCE_BYTES,
    });

    // 必须经过 post-sanitization 测算，总字节必须严格受限于 MAX_AGGREGATE_EVIDENCE_BYTES
    assert.ok(res.newAggregateBytes <= MAX_AGGREGATE_EVIDENCE_BYTES);
    assert.ok(res.snippets.some((s) => s.includes('REDACTED') || s.includes('ceiling')));
  });

  test('Evidence protocol: canonicalizeManifestPath 保持精确字符身份，彻底防范 Confused-Deputy 碰撞', () => {
    const tmp = os.tmpdir();

    // 1. 空白字符身份隔离测试：' secret.txt ' 绝不与 'secret.txt' 碰撞
    const spaced = canonicalizeManifestPath(tmp, ' secret.txt ');
    const normal = canonicalizeManifestPath(tmp, 'secret.txt');
    assert.notEqual(spaced, normal, '首尾空格路径绝不能通过 trim() 碰撞到同名无空格文件');
    assert.equal(spaced, ' secret.txt ');

    // 2. 跨平台反斜杠字符身份测试
    if (process.platform !== 'win32') {
      const posixBackslash = canonicalizeManifestPath(tmp, 'foo\\bar.txt');
      const posixSlash = canonicalizeManifestPath(tmp, 'foo/bar.txt');
      assert.notEqual(posixBackslash, posixSlash, 'POSIX 系统下文件名中的真实反斜杠绝不能被无条件替换为正斜杠');
    }

    // 3. 段敏感逃逸与合法 .. 开头文件名测试
    assert.equal(canonicalizeManifestPath(tmp, '..foo'), '..foo', '合法文件名 ..foo 必须允许保留');
    assert.equal(canonicalizeManifestPath(tmp, '..config'), '..config', '合法文件名 ..config 必须允许保留');
    if (process.platform !== 'win32') {
      assert.equal(canonicalizeManifestPath(tmp, '..\\foo'), '..\\foo', 'POSIX 下合法文件名 ..\\foo 必须允许保留');
    } else {
      assert.equal(canonicalizeManifestPath(tmp, '..\\foo'), null, 'Windows 下 ..\\foo 必须视为父级逃逸');
    }
    assert.equal(canonicalizeManifestPath(tmp, '../foo'), null, '父级目录逃逸 ../foo 必须严格返回 null');
    assert.equal(canonicalizeManifestPath(tmp, '..'), null, '父级目录 .. 必须严格返回 null');

    // 4. 证据协议清单 Confused-Deputy 防护验证
    const safeSpacedName = ' sensitive_space.txt ';
    const manifestFiles = new Set([safeSpacedName]);

    // 请求不带空格的同名文件，必须严格被拒绝
    const res = buildEvidenceRoundSnippets({
      requests: [{ type: 'read_file', path: 'sensitive_space.txt' }],
      workspace: tmp,
      reviewManifestFiles: manifestFiles,
      currentAggregateBytes: 0,
    });
    assert.ok(res.snippets.some((s) => s.includes('Security policy prevents automated reading')));
  });

  test('Evidence protocol: parseEvidenceRequests -> buildEvidenceRoundSnippets 端到端完整闭环保留首尾空格字符身份', () => {
    // 构造真实工作区，同时存在 " secret.txt " 与 "secret.txt" 两个物理文件
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'space-identity-test-'));
    try {
      const spacedName = ' secret.txt ';
      const unspacedName = 'secret.txt';
      fs.writeFileSync(path.join(testDir, spacedName), 'SPACED_FILE_CONTENT', 'utf8');
      fs.writeFileSync(path.join(testDir, unspacedName), 'UNSPACED_FILE_CONTENT', 'utf8');

      // 仅将带空格的文件放入审查允许清单
      const manifestFiles = new Set([canonicalizeManifestPath(testDir, spacedName)]);
      assert.ok(manifestFiles.has(' secret.txt '));
      assert.equal(manifestFiles.has('secret.txt'), false);

      // 1. 通过真实 parseEvidenceRequests 解析包含首尾空格的标签
      const rawAiResponse = '<EVIDENCE_REQUEST>{"type":"read_file","path":" secret.txt "}</EVIDENCE_REQUEST>';
      const parsedRequests = parseEvidenceRequests(rawAiResponse);
      assert.equal(parsedRequests[0].path, ' secret.txt ', 'parseEvidenceRequests 严禁损毁首尾空格字符身份');

      // 2. 流入 buildEvidenceRoundSnippets 并执行 readFileSafe 读取
      const roundRes = buildEvidenceRoundSnippets({
        requests: parsedRequests,
        workspace: testDir,
        reviewManifestFiles: manifestFiles,
        currentAggregateBytes: 0,
      });

      // 必须精确读取带空格的文件内容，严禁碰撞到普通文件
      assert.ok(roundRes.snippets.some((s) => s.includes('SPACED_FILE_CONTENT')));
      assert.equal(roundRes.snippets.some((s) => s.includes('UNSPACED_FILE_CONTENT')), false);

      // 3. 反向测试：AI 请求未授权的无空格文件 "secret.txt"，必须被清单拦截
      const rawRejectResponse = '<EVIDENCE_REQUEST>{"type":"read_file","path":"secret.txt"}</EVIDENCE_REQUEST>';
      const rejectRequests = parseEvidenceRequests(rawRejectResponse);
      const rejectRoundRes = buildEvidenceRoundSnippets({
        requests: rejectRequests,
        workspace: testDir,
        reviewManifestFiles: manifestFiles,
        currentAggregateBytes: 0,
      });
      assert.ok(rejectRoundRes.snippets.some((s) => s.includes('Security policy prevents automated reading')));
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  if (process.platform !== 'win32') {
    test('Evidence protocol: POSIX 物理文件 "..\\\\foo" 闭环保留字符身份并成功读取', () => {
      const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'posix-backslash-test-'));
      try {
        const backslashName = '..\\foo';
        fs.writeFileSync(path.join(testDir, backslashName), 'POSIX_BACKSLASH_CONTENT', 'utf8');

        const manifestFiles = new Set([canonicalizeManifestPath(testDir, backslashName)]);
        assert.ok(manifestFiles.has('..\\foo'));

        const rawAiResponse = '<EVIDENCE_REQUEST>{"type":"read_file","path":"..\\\\foo"}</EVIDENCE_REQUEST>';
        const parsedRequests = parseEvidenceRequests(rawAiResponse);
        assert.equal(parsedRequests[0].path, '..\\foo');

        const roundRes = buildEvidenceRoundSnippets({
          requests: parsedRequests,
          workspace: testDir,
          reviewManifestFiles: manifestFiles,
          currentAggregateBytes: 0,
        });

        assert.ok(roundRes.snippets.some((s) => s.includes('POSIX_BACKSLASH_CONTENT')));
      } finally {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });
  }

  test('Evidence protocol: 审查清单完整端到端接纳 Unmerged 冲突文件读取', () => {
    // 验证 unmerged 冲突文件能被合法纳入 reviewManifestFiles 并被正常请求
    const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'unmerged-test-'));
    try {
      const conflictFile = 'conflict_file.txt';
      const conflictPath = path.join(testDir, conflictFile);
      fs.writeFileSync(conflictPath, '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n', 'utf8');

      const manifestFiles = new Set([canonicalizeManifestPath(testDir, conflictFile)]);
      const res = buildEvidenceRoundSnippets({
        requests: [{ type: 'read_file', path: conflictFile }],
        workspace: testDir,
        reviewManifestFiles: manifestFiles,
        currentAggregateBytes: 0,
      });

      assert.ok(res.snippets.some((s) => s.includes('ours') && s.includes('theirs')), 'Unmerged 冲突文件内容应成功提取');
      assert.equal(res.audit[0].type, 'read_file');
    } finally {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------------
  // 21. Git Status porcelain -z 与重命名/特殊字符健壮性测试
  // ---------------------------------------------------------------------------
  console.log('\n21. Git Status porcelain -z 与重命名/特殊字符健壮性测试:');

  test('parseGitStatusOutput: 正确解析 porcelain -z 重命名、空格路径与未跟踪文件', () => {
    // 构造标准的 porcelain -z NUL 分隔流：
    // R  new name.js\0old name.js\0 M normal with space.js\0?? untracked unicode 中文.txt\0
    const zPayload = 'R  new name.js\0old name.js\0 M normal with space.js\0?? untracked unicode 中文.txt\0';
    const parsed = parseGitStatusOutput(zPayload);

    assert.deepEqual(parsed.staged.sort(), ['new name.js', 'old name.js'].sort(), '重命名文件新旧路径均应纳入 manifest');
    assert.deepEqual(parsed.modified, ['normal with space.js'], '带空格文件名正确提取');
    assert.deepEqual(parsed.untracked, ['untracked unicode 中文.txt'], '多字节 Unicode 文件名正确提取');
  });

  test('parseGitStatusOutput: 正确解析 Y 位工作区重命名 ( R new\\0old\\0) 并维持流同步不产生虚假记录', () => {
    // 关键测试用例：worktree rename ' R new-name.js\0AB secret.txt\0 M next.js\0'
    // 必须将 'AB secret.txt' 正确作为 rename 的 oldFile 消费，绝不能当作新记录解析出 'secret.txt'！
    const yRenamePayload = ' R new-name.js\0AB secret.txt\0 M next.js\0';
    const parsed = parseGitStatusOutput(yRenamePayload);

    assert.deepEqual(parsed.modified.sort(), ['new-name.js', 'AB secret.txt', 'next.js'].sort());
    assert.deepEqual(parsed.staged, []);
    assert.deepEqual(parsed.untracked, []);
    // 确保没有产生虚假记录 'secret.txt'
    assert.equal(parsed.modified.includes('secret.txt'), false);
  });

  test('parseGitStatusOutput: 正确解析工作区拷贝 ( C) 与暂存+工作区复合重命名 (RC)', () => {
    const copyPayload = ' C new-copy.js\0old-copy.js\0RC new-both.js\0old-both.js\0';
    const parsed = parseGitStatusOutput(copyPayload);

    assert.ok(parsed.modified.includes('new-copy.js'));
    assert.ok(parsed.modified.includes('old-copy.js'));
    assert.ok(parsed.staged.includes('new-both.js'));
    assert.ok(parsed.staged.includes('old-both.js'));
    assert.ok(parsed.modified.includes('new-both.js'));
    assert.ok(parsed.modified.includes('old-both.js'));
  });

  test('parseGitStatusOutput: 正确独立处理暂存重命名与工作区修改/删除复合状态 (RM 与 RD)', () => {
    // 真实 Git 产生状态：git mv a.txt b.txt 后修改 b.txt => "RM b.txt\0a.txt\0"
    const rmPayload = 'RM b.txt\0a.txt\0';
    const parsedRM = parseGitStatusOutput(rmPayload);
    assert.deepEqual(parsedRM.staged.sort(), ['a.txt', 'b.txt'].sort(), 'staged 必须包含新旧路径');
    assert.deepEqual(parsedRM.modified, ['b.txt'], 'modified 必须包含工作区修改的新路径 b.txt，绝不丢失 Y 轴状态');

    // 暂存重命名后工作区删除 => "RD b.txt\0a.txt\0"
    const rdPayload = 'RD b.txt\0a.txt\0';
    const parsedRD = parseGitStatusOutput(rdPayload);
    assert.deepEqual(parsedRD.staged.sort(), ['a.txt', 'b.txt'].sort(), 'staged 必须包含新旧路径');
    assert.deepEqual(parsedRD.modified, ['b.txt'], 'modified 必须包含工作区删除的新路径 b.txt');
  });

  test('parseGitStatusOutput: 正确独立处理暂存拷贝与工作区修改/删除复合状态 (CM 与 CD)', () => {
    const cmPayload = 'CM copy.txt\0src.txt\0';
    const parsedCM = parseGitStatusOutput(cmPayload);
    assert.deepEqual(parsedCM.staged.sort(), ['copy.txt', 'src.txt'].sort(), 'staged 必须包含拷贝新旧路径');
    assert.deepEqual(parsedCM.modified, ['copy.txt'], 'modified 必须包含工作区修改的新路径');

    const cdPayload = 'CD copy.txt\0src.txt\0';
    const parsedCD = parseGitStatusOutput(cdPayload);
    assert.deepEqual(parsedCD.staged.sort(), ['copy.txt', 'src.txt'].sort(), 'staged 必须包含拷贝新旧路径');
    assert.deepEqual(parsedCD.modified, ['copy.txt'], 'modified 必须包含工作区删除的新路径');
  });

  test('parseGitStatusOutput: 正确兼容换行分隔 porcelain 回退输出 (含 "old -> new" 与 RM/RD)', () => {
    const v1Payload = 'R  "old file with space.js" -> "new file with space.js"\nRM "old2.js" -> "new2.js"\n M "another file.js"\n?? untracked.txt\n';
    const parsed = parseGitStatusOutput(v1Payload);

    assert.ok(parsed.staged.includes('old file with space.js'));
    assert.ok(parsed.staged.includes('new file with space.js'));
    assert.ok(parsed.staged.includes('old2.js'));
    assert.ok(parsed.staged.includes('new2.js'));
    assert.ok(parsed.modified.includes('new2.js'), '回退模式下 RM 的 Y 轴工作区修改亦不得丢失');
    assert.ok(parsed.modified.includes('another file.js'));
    assert.ok(parsed.untracked.includes('untracked.txt'));
  });

  test('parseGitStatusOutput: 换行回退模式下包含合法 " -> " 字符的文件名不误判为重命名', () => {
    // 真实 Git 输入：修改名为 "foo -> bar.txt" 的已跟踪文件，状态为 " M"
    const literalArrowPayload = ' M "foo -> bar.txt"\n';
    const parsed = parseGitStatusOutput(literalArrowPayload);

    assert.deepEqual(parsed.modified, ['foo -> bar.txt'], '文件名中的 " -> " 绝不能被拆分为虚假重命名');
    assert.deepEqual(parsed.staged, []);
    assert.deepEqual(parsed.unmerged, []);
    assert.deepEqual(parsed.untracked, []);
  });

  test('parseGitStatusOutput: 换行回退模式下包含合法 " -> " 字符的真实重命名解析 (含 C-style 引号边界识别)', () => {
    // 真实 Git 输出：R  "foo -> bar.txt" -> baz.txt
    const renameWithArrow = 'R  "foo -> bar.txt" -> baz.txt\n';
    const parsed = parseGitStatusOutput(renameWithArrow);

    assert.deepEqual(parsed.staged.sort(), ['baz.txt', 'foo -> bar.txt'].sort(), '引号内的 " -> " 绝不能作为重命名分割符截断');
    assert.deepEqual(parsed.modified, []);
    assert.deepEqual(parsed.unmerged, []);
    assert.deepEqual(parsed.untracked, []);

    // 两侧均带引号且含 " -> "
    const doubleArrow = 'RM "old -> file.txt" -> "new -> file.txt"\n';
    const parsedDouble = parseGitStatusOutput(doubleArrow);
    assert.deepEqual(parsedDouble.staged.sort(), ['new -> file.txt', 'old -> file.txt'].sort());
    assert.deepEqual(parsedDouble.modified, ['new -> file.txt']);
  });

  test('unquoteGitPath: C-style 转义字符与八进制 UTF-8 解码测试', () => {
    assert.equal(unquoteGitPath('"plain.txt"'), 'plain.txt');
    assert.equal(unquoteGitPath('"tab\\ttest.txt"'), 'tab\ttest.txt');
    assert.equal(unquoteGitPath('"newline\\ntest.txt"'), 'newline\ntest.txt');
    assert.equal(unquoteGitPath('"quote\\"test.txt"'), 'quote"test.txt');
    assert.equal(unquoteGitPath('"slash\\\\test.txt"'), 'slash\\test.txt');
    // Git core.quotepath 对中文 "中文.txt" 的八进制输出："\344\270\255\346\226\207.txt"
    assert.equal(unquoteGitPath('"\\344\\270\\255\\346\\226\\207.txt"'), '中文.txt');
  });

  test('parseGitStatusOutput: 表驱动测试 Git 全部 7 种合并冲突状态 (DD, AU, UD, UA, DU, AA, UU)', () => {
    const conflictCodes = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
    for (const code of conflictCodes) {
      const payload = `${code} conflict_${code}.txt\0`;
      const parsed = parseGitStatusOutput(payload);
      assert.deepEqual(parsed.unmerged, [`conflict_${code}.txt`], `冲突状态 ${code} 必须正确归入 unmerged`);
      assert.deepEqual(parsed.untracked, [], `冲突状态 ${code} 严禁误归入 untracked`);
      assert.deepEqual(parsed.staged, [], `冲突状态 ${code} 严禁误归入 staged`);
      assert.deepEqual(parsed.modified, [], `冲突状态 ${code} 严禁误归入 modified`);
    }
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
