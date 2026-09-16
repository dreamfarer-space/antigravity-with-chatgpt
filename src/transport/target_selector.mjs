/**
 * target_selector.mjs - Pure Function Target Tab Selection State Machine
 * ---------------------------------------------------------------------------
 * Encapsulates ChatGPT tab resolution with Fail-Closed semantics:
 *   - Prevents silent re-binding to a different tab if the bound tab disappears
 *   - Fully testable in pure unit test environments without live browser
 */

/**
 * Filter pages to valid ChatGPT pages
 * @param {Array<object>} pages
 * @returns {Array<object>}
 */
export function filterChatGptPages(pages) {
  if (!Array.isArray(pages)) return [];
  return pages.filter((t) => {
    if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
    try {
      const u = new URL(t.url);
      return /(^|\.)chatgpt\.com$/.test(u.hostname);
    } catch {
      return false;
    }
  });
}

/**
 * Select target tab with Fail-Closed semantics
 * @param {Array<object>} pages List of target objects from /json/list
 * @param {string|null} boundTargetId Currently bound target ID
 * @param {object} [options={}]
 * @param {string} [options.preferredId] Explicitly requested target ID
 * @param {boolean} [options.allowRebind=false] Whether re-binding is permitted if bound tab disappeared
 * @returns {{ target: object|null, isNewBinding: boolean }}
 */
export function selectTargetPage(pages, boundTargetId = null, options = {}) {
  const cgPages = filterChatGptPages(pages);
  const { preferredId = null, allowRebind = false } = options;

  // 1. Explicit preferredId
  if (preferredId) {
    const found = cgPages.find((t) => t.id === preferredId);
    if (found) {
      return { target: found, isNewBinding: found.id !== boundTargetId };
    }
    throw new Error(`指定的 ChatGPT 目标标签页 "${preferredId}" 未找到或未开放 WebSocket 调试端口`);
  }

  // 2. Existing bound target
  if (boundTargetId) {
    const bound = cgPages.find((t) => t.id === boundTargetId);
    if (bound) {
      return { target: bound, isNewBinding: false };
    }
    // Fail-Closed: the bound target was closed or disappeared
    if (!allowRebind) {
      throw new Error(`已绑定的 ChatGPT 目标标签页已关闭或丢失 ("${boundTargetId}")，已中止以防止静默操作其他标签页 (Fail-Closed)`);
    }
  }

  // 3. Initial binding or explicit allowRebind
  if (cgPages.length > 0) {
    return { target: cgPages[0], isNewBinding: true };
  }

  return { target: null, isNewBinding: false };
}
