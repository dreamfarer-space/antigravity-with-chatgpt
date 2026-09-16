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
import { sendPromptViaCdp } from '../transport/cdp_transport.mjs';

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
            file: typeof parsed.file === 'string' ? parsed.file.trim() : undefined,
          });
        } else if (type === 'read_file' && typeof parsed.path === 'string' && parsed.path.trim()) {
          requests.push({
            type: 'read_file',
            path: parsed.path.trim(),
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
  const workspace = options.workspace ? path.resolve(options.workspace) : process.cwd();
  const session = options.session === 'new' ? 'new' : 'reuse';
  const timeoutS = (typeof options.timeout === 'number' && options.timeout > 0) ? options.timeout : 600;

  let attachmentsBlock = '';
  let gitDiffBlock = '';
  let executionBlock = '';
  let manifestBlock = '';

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
      const evidence = getReviewEvidence(workspace, { offset: diffOff, maxBytes: diffMax, untrackedMaxBytes: 16384 });
      const diffParts = [];

      if (mode === MODES.REVIEW) {
        const manifestLines = [
          '### Evidence Manifest (Bounded Review Context):',
          `- Branch: \`${evidence.branch || 'unknown'}\``,
          `- Staged Files (${evidence.staged?.length ?? 0}): ${evidence.staged?.slice(0, 10).join(', ') || 'none'}`,
          `- Modified Files (${evidence.modified?.length ?? 0}): ${evidence.modified?.slice(0, 10).join(', ') || 'none'}`,
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

  // 4. 调度 CDP 传输层
  let cdpRes = await sendPromptViaCdp({
    prompt: safePrompt,
    mode: session,
    timeoutS,
  });

  // 5. 闭环证据拉取协议 (Closed-Loop Bounded Evidence Protocol)
  let evidenceRounds = 0;
  const maxRounds = typeof options.maxEvidenceRounds === 'number' ? options.maxEvidenceRounds : 3;
  const evidenceAudit = [];
  const autoEvidence = options.autoEvidence !== false && mode === MODES.REVIEW;

  if (autoEvidence) {
    let aggregateBytes = 0;
    const MAX_AGGREGATE_BYTES = 128 * 1024; // 最多追加 128KB 证据，防止无限膨胀

    while (evidenceRounds < maxRounds) {
      const requests = parseEvidenceRequests(cdpRes.text);
      if (!requests || requests.length === 0) {
        break;
      }

      evidenceRounds++;
      const evidenceSnippets = [];

      for (const req of requests) {
        if (aggregateBytes >= MAX_AGGREGATE_BYTES) {
          evidenceSnippets.push(`[NOTICE: Aggregate evidence budget (${MAX_AGGREGATE_BYTES}B) reached. Proceeding with review.]`);
          break;
        }

        if (req.type === 'git_diff') {
          const reqOffset = Math.max(0, Number(req.offset) || 0);
          const reqMax = Math.min(Math.max(1024, Number(req.maxBytes) || 32768), 65536);
          const diffRes = getGitDiff(workspace, {
            offset: reqOffset,
            maxBytes: reqMax,
            head: true,
            file: req.file,
          });

          aggregateBytes += diffRes.returnedBytes;
          evidenceAudit.push({
            round: evidenceRounds,
            type: 'git_diff',
            offset: reqOffset,
            returnedBytes: diffRes.returnedBytes,
            hasMore: diffRes.hasMore,
            nextOffset: diffRes.nextOffset,
          });

          evidenceSnippets.push(`### [EVIDENCE: GIT DIFF PAGE (offset: ${reqOffset}, returned: ${diffRes.returnedBytes}B)]\n${diffRes.diff}`);
        } else if (req.type === 'read_file' && req.path) {
          try {
            const fileRes = readFileSafe(workspace, req.path, { maxBytes: req.maxBytes || 32768 });
            const bytes = Buffer.byteLength(fileRes.content, 'utf8');
            aggregateBytes += bytes;
            evidenceAudit.push({
              round: evidenceRounds,
              type: 'read_file',
              path: req.path,
              bytes,
            });
            evidenceSnippets.push(`### [EVIDENCE: FILE CONTENT \`${req.path}\`]\n\`\`\`\n${fileRes.content}\n\`\`\``);
          } catch (err) {
            evidenceSnippets.push(`### [EVIDENCE: FAILED TO READ \`${req.path}\`]\nError: ${err.message}`);
          }
        }
      }

      if (evidenceSnippets.length === 0) break;

      const followUpPrompt = [
        '[ANTIGRAVITY-BRIDGE/EVIDENCE_RESPONSE]',
        'Here is the requested workspace evidence:',
        '',
        evidenceSnippets.join('\n\n'),
        '',
        'Please incorporate this empirical evidence and finalize your review with an explicit verdict ([APPROVED] or [CHANGES REQUESTED]).',
      ].join('\n');

      const safeFollowUp = sanitizeContent(followUpPrompt);
      cdpRes = await sendPromptViaCdp({
        prompt: safeFollowUp,
        mode: 'reuse',
        timeoutS,
      });
    }
  }

  const elapsedMs = Date.now() - t0;

  return {
    ok: true,
    text: cdpRes.text,
    url: cdpRes.url,
    turns: cdpRes.turns,
    mode,
    elapsedMs,
    evidenceRounds,
    evidenceAudit,
  };
}
