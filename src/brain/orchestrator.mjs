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
import { buildAttachmentsBlock, getWorkspaceInfo } from '../workspace/context_provider.mjs';
import { getGitDiff, getReviewEvidence } from '../git/git_helper.mjs';
import { getRecentExecutions, formatExecutionSummary } from '../execution/recorder.mjs';
import { sanitizeContent } from '../security/sensitive.mjs';
import { sendPromptViaCdp } from '../transport/cdp_transport.mjs';

/**
 * 运行一次完整的大脑推理任务
 * @param {object} options
 * @param {string} options.prompt 提示词或问题
 * @param {string} [options.mode='ask'] 模式：ask | plan | review | derive | diagnose
 * @param {string} [options.workspace] 工作区根目录，默认当前目录
 * @param {Array<string>} [options.files=[]] 显式附带的代码文件路径
 * @param {boolean} [options.gitDiff=false] 是否注入真实 Git Diff
 * @param {boolean} [options.executionEvidence=false] 是否注入最近的执行证据
 * @param {string} [options.session='reuse'] 'reuse' | 'new'
 * @param {number} [options.timeout=600] 超时时间（秒）
 * @returns {Promise<object>} { ok, text, elapsedMs, mode, turns }
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

  // 1. 根据模式与参数决定是否拉取工作区证据
  if (mode !== MODES.DERIVE) {
    // 处理文件附件
    if (Array.isArray(options.files) && options.files.length > 0) {
      attachmentsBlock = buildAttachmentsBlock(workspace, options.files);
    }

    // 处理 Git 变更与审查证据 (review 与 diagnose 模式下默认自动附带，或显式要求)
    const needDiff = options.gitDiff === true || mode === MODES.REVIEW || (mode === MODES.DIAGNOSE && options.gitDiff !== false);
    if (needDiff) {
      const evidence = getReviewEvidence(workspace);
      const diffParts = [];
      if (evidence.summary) {
        diffParts.push(`Git Status: ${evidence.summary}`);
      }
      if (evidence.untracked && evidence.untracked.length > 0) {
        diffParts.push(`Untracked files (${evidence.untracked.length}):\n${evidence.untracked.slice(0, 20).map((f) => `  - ${f}`).join('\n')}${evidence.untracked.length > 20 ? '\n  ... and more' : ''}`);
      }
      if (evidence.hasDiff && evidence.diff) {
        diffParts.push(evidence.diff);
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
  const cdpRes = await sendPromptViaCdp({
    prompt: safePrompt,
    mode: session,
    timeoutS,
  });

  const elapsedMs = Date.now() - t0;

  return {
    ok: true,
    text: cdpRes.text,
    url: cdpRes.url,
    turns: cdpRes.turns,
    mode,
    elapsedMs,
  };
}
