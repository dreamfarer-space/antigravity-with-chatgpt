/**
 * target_selector.mjs - Pure Function Target Tab Selection State Machine
 * ---------------------------------------------------------------------------
 * Encapsulates ChatGPT tab resolution with Fail-Closed semantics:
 *   - Prevents silent re-binding to a different tab if the bound tab disappears
 *   - Precise selection by canonical conversation identity (multi-tab safe)
 *   - Fully testable in pure unit test environments without live browser
 */

/**
 * Canonicalize a ChatGPT conversation URL to `protocol//host/path`
 * (query string, hash and trailing slashes are stripped)
 * @param {string} rawUrl
 * @returns {string}
 */
export function canonicalizeConversationUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
    return `${parsed.protocol}//${host}${pathname}`;
  } catch {
    const clean = rawUrl.split('?')[0].split('#')[0].replace(/\/+$/, '');
    return clean.startsWith('/') ? clean : `/${clean}`;
  }
}

/**
 * Extract only the pathname of a conversation URL
 * @param {string} rawUrl
 * @returns {string}
 */
export function conversationPathname(rawUrl) {
  const canonical = canonicalizeConversationUrl(rawUrl);
  if (!canonical) return '';
  try {
    return new URL(canonical).pathname || '/';
  } catch {
    const stripped = canonical.split('?')[0].split('#')[0];
    return stripped.startsWith('/') ? stripped : `/${stripped}`;
  }
}

/**
 * A root (unbound) conversation URL: `https://chatgpt.com/` — no concrete /c/<id> identity yet
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isRootConversation(rawUrl) {
  const p = conversationPathname(rawUrl);
  return p === '' || p === '/';
}

/**
 * Ephemeral (client-side, not yet persisted) conversation identity.
 * Observed live: right after submitting a brand-new chat, ChatGPT briefly sits on
 * `/c/WEB:<uuid>` before the SPA swaps in the server-assigned `/c/<uuid>`.
 * Such a URL carries NO durable identity and must never be pinned or used as a credential.
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isEphemeralConversation(rawUrl) {
  const p = conversationPathname(rawUrl);
  if (!p.startsWith('/c/')) return false;
  let id = p.slice(3);
  try { id = decodeURIComponent(id); } catch {}
  return id.includes(':') || /^WEB/i.test(id);
}

/**
 * Whether a URL carries a durable, pinnable conversation identity
 * (concrete /c/<id>, not root, not the ephemeral WEB:<uuid> form)
 * @param {string} rawUrl
 * @returns {boolean}
 */
export function isPinnableConversation(rawUrl) {
  return !isRootConversation(rawUrl) && !isEphemeralConversation(rawUrl);
}

/**
 * Identity comparison that tolerates the legitimate unbound → bound transition:
 * a root URL is treated as compatible with any concrete /c/<id> conversation.
 * NOTE: this is intentionally permissive; use isSameConversationStrict() once an
 * identity has been PINNED, otherwise `/` would whitelist every conversation.
 * @param {string} currentUrl
 * @param {string} expectedUrl
 * @returns {boolean}
 */
export function isSameConversation(currentUrl, expectedUrl) {
  if (!currentUrl || !expectedUrl) return false;
  const c = canonicalizeConversationUrl(currentUrl);
  const e = canonicalizeConversationUrl(expectedUrl);
  if (c === e) return true;

  try {
    const parsedC = new URL(c);
    const parsedE = new URL(e);
    if (parsedC.hostname !== parsedE.hostname) return false;
    if (parsedC.pathname === parsedE.pathname) return true;

    // 初始新会话 (从根路径 / 提交) 在流式生成过程中正常跃迁为 /c/<new-conversation-id>
    if ((parsedE.pathname === '/' || parsedE.pathname === '') && parsedC.pathname.startsWith('/c/')) {
      return true;
    }
    return false;
  } catch {
    try {
      // 一方是完整 URL，另一方是纯路径（如 /c/<id>）
      const normC = c.startsWith('http') ? new URL(c).pathname : c;
      const normE = e.startsWith('http') ? new URL(e).pathname : e;
      if (normC === normE) return true;
      if ((normE === '/' || normE === '') && normC.startsWith('/c/')) {
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}

/**
 * Strict identity comparison for a PINNED conversation: host + pathname must match exactly.
 * `/` never matches `/c/<id>` here — this is the guard that closes the
 * `/ → /c/A → /c/B` wildcard hole.
 * @param {string} currentUrl
 * @param {string} expectedUrl
 * @returns {boolean}
 */
export function isSameConversationStrict(currentUrl, expectedUrl) {
  if (!currentUrl || !expectedUrl) return false;
  const c = canonicalizeConversationUrl(currentUrl);
  const e = canonicalizeConversationUrl(expectedUrl);
  if (!c || !e) return false;
  if (c === e) return true;
  try {
    const parsedC = new URL(c);
    const parsedE = new URL(e);
    return parsedC.hostname === parsedE.hostname && parsedC.pathname === parsedE.pathname;
  } catch {
    return false;
  }
}

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
 * @param {string} [options.conversationUrl] Required canonical conversation identity (multi-tab precise match)
 * @returns {{ target: object|null, isNewBinding: boolean }}
 */
export function selectTargetPage(pages, boundTargetId = null, options = {}) {
  const cgPages = filterChatGptPages(pages);
  const { preferredId = null, allowRebind = false, conversationUrl = null } = options;

  // 1. Explicit preferredId
  if (preferredId) {
    const found = cgPages.find((t) => t.id === preferredId);
    if (found) {
      return { target: found, isNewBinding: found.id !== boundTargetId };
    }
    throw new Error(`指定的 ChatGPT 目标标签页 "${preferredId}" 未找到或未开放 WebSocket 调试端口`);
  }

  // 2. Exact conversation identity match (never "first tab + hope")
  //    仅对"可锁定"的具体会话身份做精确匹配；根路径与临时 WEB:<uuid> 身份不具备可比性
  if (conversationUrl && isPinnableConversation(conversationUrl)) {
    const exact = cgPages.find((t) => isSameConversationStrict(t.url, conversationUrl));
    if (exact) {
      return { target: exact, isNewBinding: exact.id !== boundTargetId };
    }
    throw new Error(
      `未找到与目标会话匹配的 ChatGPT 标签页 ("${canonicalizeConversationUrl(conversationUrl)}")，` +
      `已中止以防止读取其他会话 (Fail-Closed)`
    );
  }

  // 3. Existing bound target
  if (boundTargetId) {
    const bound = cgPages.find((t) => t.id === boundTargetId);
    if (bound) {
      return { target: bound, isNewBinding: false };
    }
    // Fail-Closed: the bound target was closed or disappeared
    if (!allowRebind) {
      throw new Error(`已绑定的 ChatGPT 目标标签页已关闭或丢失 ("${boundTargetId}")，已中止以防止静默操作其他标签页 (Fail-Closed)`);
    }
    if (cgPages.length > 0) {
      return { target: cgPages[0], isNewBinding: true };
    }
  }

  // 4. Initial binding or explicit allowRebind
  if (cgPages.length > 0) {
    return { target: cgPages[0], isNewBinding: true };
  }

  return { target: null, isNewBinding: false };
}
