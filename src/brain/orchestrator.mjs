/**
 * orchestrator.mjs - 核心大脑编排器
 * ---------------------------------------------------------------------------
 * 作为 Antigravity Agent 与 ChatGPT 之间的可信上下文代理 (Context Broker)：
 *   - 规范模式流转 (ask / plan / review / derive / diagnose)
 *   - 安全收集并脱敏代码文件、Git Diff 与执行证据
 *   - 调度 CDP 传输层完成高效云端推理
 */

import path from 'node:path';
import { MODES, buildPromptEnvelope } from './prompts.mjs';
import { buildAttachmentsBlock, getWorkspaceInfo, readFileSafe } from '../workspace/context_provider.mjs';
import { getGitDiff, getReviewEvidence } from '../git/git_helper.mjs';
import { getRecentExecutions, formatExecutionSummary } from '../execution/recorder.mjs';
import { sanitizeContent } from '../security/sensitive.mjs';
import { canonicalizeManifestPath } from '../security/path_guard.mjs';
import { assertAuthorizedWorkspace, getAuthorizedWorkspace } from '../security/authorized_workspace.mjs';
import { sendPromptViaCdp, fetchLatestResponse } from '../transport/cdp_transport.mjs';

/**
 * 解析 ChatGPT 回复中的 <EVIDENCE_REQUEST> 证据拉取标签
 * @param {string} text
 * @returns {Array<object>} [{ type: 'git_diff'|'read_file', offset?: number, maxBytes?: number, path?: string, file?: string }]
 */
export function parseEvidenceRequests(text) {
  if (typeof text !== 'string' || !text.includes('<EVIDENCE_REQUEST>')) {
    return [];
  }

  const regex = /<EVIDENCE_REQUEST>([\s\S]*?)<\/EVIDENCE_REQUEST>/gi;
  const requests = [];
  let match;

  while ((match = regex.exec(text)) !== null) {
    let rawJson = match[1].trim();
    // 移除潜在的 Markdown ```json 围栏
    rawJson = rawJson.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === 'object') {
        const type = String(parsed.type || '').toLowerCase();
        if (type === 'git_diff') {
          requests.push({
            type: 'git_diff',
            offset: Math.max(0, Number(parsed.offset) || 0),
            maxBytes: Math.min(Math.max(1024, Number(parsed.maxBytes) || 32768), 65536),
            file: (typeof parsed.file === 'string' && parsed.file.length > 0) ? parsed.file : undefined,
          });
        } else if (type === 'read_file' && typeof parsed.path === 'string' && parsed.path.length > 0) {
          requests.push({
            type: 'read_file',
            path: parsed.path,
            maxBytes: Math.min(Math.max(1024, Number(parsed.maxBytes) || 32768), 128 * 1024),
          });
        }
      }
    } catch {
      // 忽略无法解析的格式
    }
  }

  return requests;
}

export const MAX_AGGREGATE_EVIDENCE_BYTES = 128 * 1024; // 128 KB 证据总开销上限
export const MAX_REQUESTS_PER_ROUND = 8;
export const MAX_PATH_LENGTH = 256;

/**
 * 处理单轮证据请求，生成严格受控且有界的序列化证据内容
 * @param {object} params
 * @param {Array<object>} params.requests
 * @param {string} params.workspace
 * @param {Set<string>} params.reviewManifestFiles
 * @param {number} [params.currentAggregateBytes=0]
 * @param {number} [params.maxAggregateBytes=131072]
 * @param {number} [params.round=1]
 * @returns {{ snippets: string[], newAggregateBytes: number, audit: object[], budgetReached: boolean }}
 */
export function buildEvidenceRoundSnippets({
  requests,
  workspace,
  reviewManifestFiles,
  currentAggregateBytes = 0,
  maxAggregateBytes = MAX_AGGREGATE_EVIDENCE_BYTES,
  round = 1,
}) {
  let aggregateBytes = currentAggregateBytes;
  const snippets = [];
  const audit = [];
  let budgetReached = false;

  const boundedRequests = (requests || []).slice(0, MAX_REQUESTS_PER_ROUND);
  if ((requests || []).length > MAX_REQUESTS_PER_ROUND) {
    const notice = `[NOTICE: Per-round evidence request cap (${MAX_REQUESTS_PER_ROUND}) applied; remaining requests deferred.]`;
    const noticeBytes = Buffer.byteLength(notice, 'utf8') + 2;
    if (aggregateBytes + noticeBytes <= maxAggregateBytes) {
      snippets.push(notice);
      aggregateBytes += noticeBytes;
    }
  }

  function tryAppendSnippet(rawSnippet) {
    const safeSnippet = sanitizeContent(rawSnippet);
    const snippetBytes = Buffer.byteLength(safeSnippet, 'utf8') + 2; // 含换行符开销
    if (aggregateBytes + snippetBytes > maxAggregateBytes) {
      if (!budgetReached) {
        budgetReached = true;
        const ceilingNotice = sanitizeContent(`[NOTICE: Aggregate evidence budget ceiling (${maxAggregateBytes}B) reached. Truncating further evidence.]`);
        const ceilingBytes = Buffer.byteLength(ceilingNotice, 'utf8') + 2;
        if (aggregateBytes + ceilingBytes <= maxAggregateBytes) {
          snippets.push(ceilingNotice);
          aggregateBytes += ceilingBytes;
        }
      }
      return false;
    }
    snippets.push(safeSnippet);
    aggregateBytes += snippetBytes;
    return true;
  }

  for (const req of boundedRequests) {
    if (budgetReached || aggregateBytes >= maxAggregateBytes) {
      budgetReached = true;
      break;
    }

    if (req.type === 'git_diff') {
      const remaining = maxAggregateBytes - aggregateBytes;
      if (remaining <= 256) {
        budgetReached = true;
        break;
      }
      const reqOffset = Math.max(0, Number(req.offset) || 0);
      const requestedMax = Math.min(Math.max(1024, Number(req.maxBytes) || 32768), 65536);
      // 为 Markdown 标题与分隔符预留 256 字节裕量
      const allowedPayload = Math.max(512, Math.min(requestedMax, remaining - 256));

      const diffRes = getGitDiff(workspace, {
        offset: reqOffset,
        maxBytes: allowedPayload,
        head: true,
        file: req.file,
      });

      const snippet = `### [EVIDENCE: GIT DIFF PAGE (offset: ${reqOffset}, returned: ${diffRes.returnedBytes}B)]\n${diffRes.diff}`;
      if (!tryAppendSnippet(snippet)) break;

      audit.push({
        round,
        type: 'git_diff',
        offset: reqOffset,
        returnedBytes: diffRes.returnedBytes,
        hasMore: diffRes.hasMore,
        nextOffset: diffRes.nextOffset,
      });
    } else if (req.type === 'read_file' && req.path) {
      const rawPathStr = String(req.path);
      if (rawPathStr.length > MAX_PATH_LENGTH) {
        const snippet = `### [EVIDENCE: REJECTED \`${rawPathStr.slice(0, 32)}...\`]\nError: Requested path exceeds maximum allowed length (${MAX_PATH_LENGTH} chars).`;
        tryAppendSnippet(snippet);
        continue;
      }

      const normPath = canonicalizeManifestPath(workspace, rawPathStr);
      if (!normPath || (reviewManifestFiles && !reviewManifestFiles.has(normPath))) {
        const safeDisplay = normPath || rawPathStr.replace(/[\0\r\n]/g, '');
        const snippet = `### [EVIDENCE: REJECTED \`${safeDisplay}\`]\nError: Security policy prevents automated reading of files outside the active change/attachment manifest.`;
        tryAppendSnippet(snippet);
        continue;
      }

      const remaining = maxAggregateBytes - aggregateBytes;
      if (remaining <= 256) {
        budgetReached = true;
        break;
      }
      const requestedMax = Math.min(Math.max(512, Number(req.maxBytes) || 32768), 65536);
      const allowedPayload = Math.max(256, Math.min(requestedMax, remaining - 256));

      try {
        const fileRes = readFileSafe(workspace, normPath, { maxBytes: allowedPayload });
        const snippet = `### [EVIDENCE: FILE CONTENT \`${normPath}\`]\n\`\`\`\n${fileRes.content}\n\`\`\``;
        if (!tryAppendSnippet(snippet)) break;

        audit.push({
          round,
          type: 'read_file',
          path: normPath,
          bytes: Buffer.byteLength(fileRes.content, 'utf8'),
        });
      } catch (err) {
        const snippet = `### [EVIDENCE: FAILED TO READ \`${normPath}\`]\nError: ${err.message}`;
        tryAppendSnippet(snippet);
      }
    }
  }

  // 严格硬性不变式断言 (Hard Invariant)
  if (aggregateBytes > maxAggregateBytes) {
    throw new Error(`Aggregate evidence bytes (${aggregateBytes}) strictly exceeded ceiling (${maxAggregateBytes})`);
  }

  return {
    snippets,
    newAggregateBytes: aggregateBytes,
    audit,
    budgetReached,
  };
}

/**
 * 运行一次完整的大脑推理任务
 * @param {object} options
 * @param {string} options.prompt 提示词或问题
 * @param {string} [options.mode='ask'] 模式：ask | plan | review | derive | diagnose
 * @param {string} [options.workspace] 工作区根目录，默认当前目录
 * @param {Array<string>} [options.files=[]] 显式附带的代码文件路径
 * @param {boolean} [options.gitDiff=false] 是否注入真实 Git Diff
 * @param {number} [options.diffOffset=0] Git Diff 分页起始偏移量
 * @param {number} [options.diffMaxBytes=32768] Git Diff 字节预算限制
 * @param {boolean} [options.executionEvidence=false] 是否注入最近的执行证据
 * @param {boolean} [options.autoEvidence=true] review 模式下是否自动拉取 <EVIDENCE_REQUEST> 证据
 * @param {number} [options.maxEvidenceRounds=3] 自动拉取证据的最大迭代轮数
 * @param {string} [options.session='reuse'] 'reuse' | 'new'
 * @param {number} [options.timeout=600] 超时时间（秒）
 * @returns {Promise<object>} { ok, text, elapsedMs, mode, turns, evidenceRounds, evidenceAudit }
 */
export async function runBrainTask(options = {}) {
  const t0 = Date.now();
  if (!options || typeof options.prompt !== 'string' || !options.prompt.trim()) {
    throw new TypeError('提示词 (prompt) 必须为非空有效字符串');
  }
  const prompt = options.prompt.trim();

  const mode = (options.mode && Object.values(MODES).includes(String(options.mode).toLowerCase()))
    ? String(options.mode).toLowerCase()
    : MODES.ASK;
  const workspace = assertAuthorizedWorkspace(
    options.workspace
      ? path.resolve(options.workspace)
      : (getAuthorizedWorkspace() || process.cwd())
  );
  const session = options.session === 'new' ? 'new' : 'reuse';
  const timeoutS = (typeof options.timeout === 'number' && options.timeout > 0) ? options.timeout : 600;
  // 端到端唯一绝对截止时间：优先使用调用方（MCP / CLI）锚定的 deadlineMs，
  // 否则以本层 t0 为锚点。下游所有等待都必须消费同一条预算。
  const deadlineMs = (typeof options.deadlineMs === 'number' && Number.isFinite(options.deadlineMs))
    ? options.deadlineMs
    : (t0 + timeoutS * 1000);

  let attachmentsBlock = '';
  let gitDiffBlock = '';
  let executionBlock = '';
  let manifestBlock = '';
  let reviewEvidence = null;

  // 1. 根据模式与参数决定是否拉取工作区证据
  if (mode !== MODES.DERIVE) {
    // 处理文件附件
    if (Array.isArray(options.files) && options.files.length > 0) {
      attachmentsBlock = buildAttachmentsBlock(workspace, options.files);
    }

    // 处理 Git 变更与审查证据 (review 与 diagnose 模式下默认自动附带，或显式要求)
    const needDiff = options.gitDiff === true || mode === MODES.REVIEW || (mode === MODES.DIAGNOSE && options.gitDiff !== false);
    if (needDiff) {
      const diffMax = typeof options.diffMaxBytes === 'number' ? options.diffMaxBytes : 32768;
      const diffOff = typeof options.diffOffset === 'number' ? options.diffOffset : 0;
      reviewEvidence = getReviewEvidence(workspace, { offset: diffOff, maxBytes: diffMax, untrackedMaxBytes: 16384 });
      const evidence = reviewEvidence;
      const diffParts = [];

      if (mode === MODES.REVIEW) {
        const manifestLines = [
          '### Evidence Manifest (Bounded Review Context):',
          `- Branch: \`${evidence.branch || 'unknown'}\``,
          `- Staged Files (${evidence.staged?.length ?? 0}): ${evidence.staged?.slice(0, 10).join(', ') || 'none'}`,
          `- Modified Files (${evidence.modified?.length ?? 0}): ${evidence.modified?.slice(0, 10).join(', ') || 'none'}`,
          ...(evidence.unmerged && evidence.unmerged.length > 0 ? [`- Unmerged Conflicts (${evidence.unmerged.length}): ${evidence.unmerged.slice(0, 10).join(', ')}`] : []),
          `- Untracked Files (${evidence.untracked?.length ?? 0}): ${evidence.untracked?.slice(0, 10).join(', ') || 'none'}`,
          `- Diff Total Bytes: ${evidence.totalDiffBytes ?? 0}`,
          `- Diff Returned Bytes: ${evidence.returnedDiffBytes ?? 0}`,
          `- Has More Diff: ${evidence.hasMoreDiff ? `yes (nextOffset: ${evidence.nextDiffOffset})` : 'no'}`,
        ];
        manifestBlock = manifestLines.join('\n');
      }

      if (evidence.summary) {
        diffParts.push(`Git Status: ${evidence.summary}`);
      }
      if (evidence.untracked && evidence.untracked.length > 0) {
        diffParts.push(`Untracked files (${evidence.untracked.length}):\n${evidence.untracked.slice(0, 20).map((f) => `  - ${f}`).join('\n')}${evidence.untracked.length > 20 ? '\n  ... and more' : ''}`);
      }
      if (evidence.hasDiff && evidence.diff) {
        diffParts.push(evidence.diff);
      }
      if (evidence.untrackedContent) {
        diffParts.push(`### Untracked Files Content Evidence:\n${evidence.untrackedContent}`);
      }
      if (diffParts.length > 0) {
        gitDiffBlock = diffParts.join('\n\n');
      }
    }

    // 处理执行记录证据 (review 模式下默认提取)
    const needExec = options.executionEvidence === true || mode === MODES.REVIEW;
    if (needExec) {
      const recs = getRecentExecutions(workspace, 3);
      if (recs.length > 0) {
        executionBlock = formatExecutionSummary(recs);
      }
    }
  }

  // 2. 组装符合安全封套规范的 Prompt
  const finalPrompt = buildPromptEnvelope({
    mode,
    prompt,
    workspace: mode !== MODES.DERIVE ? workspace : null,
    manifestBlock,
    attachmentsBlock,
    gitDiffBlock,
    executionBlock,
  });

  // 3. 统一出口脱敏 (Egress Sanitization): 确保越过浏览器边界的所有内容均经过脱敏
  const safePrompt = sanitizeContent(finalPrompt);

  const MAX_PROMPT_BYTES = 256 * 1024;
  if (Buffer.byteLength(safePrompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error(`组装后的提示词超出安全传输大小限制 (${Buffer.byteLength(safePrompt, 'utf8')} 字节 > ${MAX_PROMPT_BYTES} 字节)`);
  }

  // 4. 调度 CDP 传输层（透传同一条绝对 deadline，禁止下游重新锚定相对超时）
  const safeTimeout = options.safeTimeout !== false;
  let cdpRes = await sendPromptViaCdp({
    prompt: safePrompt,
    mode: session,
    timeoutS,
    deadlineMs,
    safeTimeout,
  });

  if (cdpRes.inProgress) {
    const elapsedMs = Date.now() - t0;
    return {
      ok: true,
      inProgress: true,
      isStreaming: cdpRes.isStreaming,
      text: cdpRes.text || '',
      url: cdpRes.url,
      turns: cdpRes.turns,
      expectedTurn: cdpRes.expectedTurn,
      conversationUrl: cdpRes.conversationUrl || null,
      targetId: cdpRes.targetId || null,
      mode,
      elapsedMs,
      message: cdpRes.message || 'ChatGPT 正在深度推理与生成长回复中。',
    };
  }

  // 5. 闭环证据拉取协议 (Closed-Loop Bounded Evidence Protocol)
  let evidenceRounds = 0;
  const maxRounds = typeof options.maxEvidenceRounds === 'number' ? options.maxEvidenceRounds : 3;
  const evidenceAudit = [];
  const autoEvidence = options.autoEvidence !== false && mode === MODES.REVIEW;

  if (autoEvidence) {
    let aggregateBytes = 0;
    const MAX_AGGREGATE_BYTES = 128 * 1024; // 最多追加 128KB 证据，防止无限膨胀

    // Confused-deputy 防护：严格仅允许读取当前变更清单 (staged, modified, unmerged, untracked) 或显式附带的文件
    // 使用精确 canonicalizeManifestPath，严禁模糊 trim() 与跨平台无条件反斜杠替换
    const rawFileList = [
      ...(reviewEvidence?.staged || []),
      ...(reviewEvidence?.modified || []),
      ...(reviewEvidence?.unmerged || []),
      ...(reviewEvidence?.untracked || []),
      ...(Array.isArray(options.files) ? options.files : []),
    ];
    const reviewManifestFiles = new Set(
      rawFileList
        .map((p) => canonicalizeManifestPath(workspace, String(p)))
        .filter(Boolean)
    );

    // 为完整的序列化 followUpPrompt 预留封套开销 (Header, Separators, Instructions)
    const ENVELOPE_RESERVE_BYTES = 512;
    const maxEvidencePayload = MAX_AGGREGATE_EVIDENCE_BYTES - ENVELOPE_RESERVE_BYTES;

    while (evidenceRounds < maxRounds) {
      const requests = parseEvidenceRequests(cdpRes.text);
      if (!requests || requests.length === 0) {
        break;
      }

      evidenceRounds++;
      const roundRes = buildEvidenceRoundSnippets({
        requests,
        workspace,
        reviewManifestFiles,
        currentAggregateBytes: aggregateBytes,
        maxAggregateBytes: maxEvidencePayload,
        round: evidenceRounds,
      });

      aggregateBytes = roundRes.newAggregateBytes;
      evidenceAudit.push(...roundRes.audit);

      if (roundRes.snippets.length === 0) break;

      const followUpPrompt = [
        '[ANTIGRAVITY-BRIDGE/EVIDENCE_RESPONSE]',
        'Here is the requested workspace evidence:',
        '',
        roundRes.snippets.join('\n\n'),
        '',
        'Please incorporate this empirical evidence and finalize your review with an explicit verdict ([APPROVED] or [CHANGES REQUESTED]).',
      ].join('\n');

      const safeFollowUp = sanitizeContent(followUpPrompt);
      const followUpBytes = Buffer.byteLength(safeFollowUp, 'utf8');

      // 严格硬性不变式断言 (Hard Post-Serialization Invariant)
      // 包含外层封套、Markdown 标记、拒绝片段与实体数据在内的完整提示词，绝不允许超出 128KB 预算天花板
      if (followUpBytes > MAX_AGGREGATE_EVIDENCE_BYTES) {
        throw new Error(`Follow-up evidence prompt (${followUpBytes}B) strictly exceeded aggregate evidence ceiling (${MAX_AGGREGATE_EVIDENCE_BYTES}B)`);
      }

      // 与主轮次共用同一条绝对 deadline（绝不重新锚定相对超时）
      const remainingMs = deadlineMs - Date.now();
      const SAFETY_MARGIN_MS = 5000;

      if (remainingMs <= SAFETY_MARGIN_MS) {
        // 总 deadline 预算已耗尽，严禁启动新的等待窗口，立即优雅返回 inProgress
        const elapsedMs = Date.now() - t0;
        return {
          ok: true,
          inProgress: true,
          isStreaming: Boolean(cdpRes?.isStreaming),
          text: cdpRes?.text || '',
          url: cdpRes?.url,
          turns: cdpRes?.turns,
          expectedTurn: cdpRes?.expectedTurn,
          conversationUrl: cdpRes?.conversationUrl || null,
          targetId: cdpRes?.targetId || null,
          mode,
          elapsedMs,
          evidenceRounds,
          evidenceAudit,
          message: '总截止时间预算已用尽，安全返回以防 MCP 宿主 180s 强杀。可通过 fetch_chatgpt_response 获取后续回复。',
        };
      }

      const remainingTimeoutS = Math.max(1, Math.floor(remainingMs / 1000));

      cdpRes = await sendPromptViaCdp({
        prompt: safeFollowUp,
        mode: 'reuse',
        timeoutS: remainingTimeoutS,
        deadlineMs,
        safeTimeout,
      });

      if (cdpRes.inProgress) {
        const elapsedMs = Date.now() - t0;
        return {
          ok: true,
          inProgress: true,
          isStreaming: cdpRes.isStreaming,
          text: cdpRes.text || '',
          url: cdpRes.url,
          turns: cdpRes.turns,
          expectedTurn: cdpRes.expectedTurn,
          conversationUrl: cdpRes.conversationUrl || null,
          targetId: cdpRes.targetId || null,
          mode,
          elapsedMs,
          evidenceRounds,
          evidenceAudit,
          message: cdpRes.message || 'ChatGPT 在证据审阅中仍在生成。',
        };
      }

      if (roundRes.budgetReached) break;
    }
  }

  const elapsedMs = Date.now() - t0;

  return {
    ok: true,
    inProgress: false,
    text: cdpRes.text,
    url: cdpRes.url,
    conversationUrl: cdpRes.conversationUrl || null,
    targetId: cdpRes.targetId || null,
    turns: cdpRes.turns,
    mode,
    elapsedMs,
    evidenceRounds,
    evidenceAudit,
  };
}

/**
 * 抓取当前 ChatGPT 会话中最新生成完毕或正在生成的回复（无需注入 Prompt，带身份与回合校验）
 * @param {object} [options]
 * @param {number} [options.timeout=150]
 * @param {number} [options.expectedTurn] 预期的最小回复回合数 (防串线)
 * @param {string} [options.conversationUrl] 预期的会话 URL (防串标签)
 * @param {boolean} [options.safeTimeout=true]
 * @returns {Promise<object>}
 */
export async function fetchLatestBrainResponse(options = {}) {
  const t0 = Date.now();
  const timeoutS = (typeof options.timeout === 'number' && options.timeout > 0) ? options.timeout : 150;
  const safeTimeout = options.safeTimeout !== false;
  const deadlineMs = (typeof options.deadlineMs === 'number' && Number.isFinite(options.deadlineMs))
    ? options.deadlineMs
    : (t0 + timeoutS * 1000);

  const cdpRes = await fetchLatestResponse({
    timeoutS,
    deadlineMs,
    expectedTurn: options.expectedTurn,
    conversationUrl: options.conversationUrl,
    targetId: options.targetId,
    safeTimeout,
  });

  const elapsedMs = Date.now() - t0;
  return {
    ok: cdpRes.ok,
    inProgress: Boolean(cdpRes.inProgress),
    isStreaming: Boolean(cdpRes.isStreaming),
    text: cdpRes.text || '',
    url: cdpRes.url,
    // 仅在拿到 durable `/c/<id>` 时为字符串；否则为 null（由 targetId 兜底恢复）
    conversationUrl: cdpRes.conversationUrl || null,
    targetId: cdpRes.targetId || options.targetId || null,
    turns: cdpRes.turns,
    expectedTurn: cdpRes.expectedTurn,
    elapsedMs,
    message: cdpRes.message,
  };
}
