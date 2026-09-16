/**
 * fingerprint.mjs - Order-Sensitive FNV-1a Fingerprint
 * ---------------------------------------------------------------------------
 * Computes an order-sensitive 32-bit FNV-1a hash and character length over
 * JavaScript UTF-16 code units.
 *
 * Guarantees 100% parity between Node.js and Chromium V8 in-browser evaluation.
 * Strings with identical length but differing character order (e.g. "abc" vs "cba")
 * produce distinct hashes.
 */

export const FNV_OFFSET_BASIS = 0x811c9dc5;
export const FNV_PRIME = 0x01000193;

/**
 * Compute order-sensitive FNV-1a fingerprint for a string
 * @param {string} str
 * @returns {{ length: number, hash: string }}
 */
export function computeFingerprint(str) {
  if (typeof str !== 'string') {
    return { length: 0, hash: '811c9dc5' };
  }
  let hash = FNV_OFFSET_BASIS;
  const len = str.length;
  for (let i = 0; i < len; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0');
  return { length: len, hash: hex };
}

/**
 * JavaScript snippet to inject into Chromium browser contexts for computing
 * identical fingerprints on DOM text.
 */
export const BROWSER_FINGERPRINT_SNIPPET = `
  const computeFingerprint = (str) => {
    if (typeof str !== 'string') return { length: 0, hash: '811c9dc5' };
    let hash = 0x811c9dc5;
    const len = str.length;
    for (let i = 0; i < len; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 0x01000193);
    }
    return { length: len, hash: (hash >>> 0).toString(16).padStart(8, '0') };
  };
`;
