/**
 * The shared external-link safety helper: decides whether a link target is
 * safe to render as an `<a href>`. It lives in this narrow static owner so
 * every consuming bundle inlines the SAME judgment — a new render surface can
 * never ship its own (weaker) copy of the scheme gate (arch-review 批 K
 * xss-safeHref-tab-newline-bypass: the former regex-only check was bypassed
 * by `java<tab>script:`/`java\nscript:` — the WHATWG URL parser strips ASCII
 * tab/newline BEFORE scheme recognition, so the regex missed them while the
 * browser parsed them as `javascript:`).
 */

/**
 * Whether a link target is safe to render as an `<a href>`: a `#` anchor, a
 * scheme-less relative target, or an `http:`/`https:`/`mailto:` URL. Any other
 * scheme (`javascript:`, `data:`, `vbscript:`, …) is rejected so content can
 * never produce a scriptable href (self-XSS via pasted markdown).
 *
 * The judgment goes through the WHATWG URL parser (the browser's own): a
 * relative target resolves against the inert `https://anchor.local/` base to
 * the https: protocol and passes; a tab/newline-prefixed scheme — which the
 * parser folds into the scheme before recognition — lands in the protocol
 * whitelist check and is rejected.
 * @param url - the raw link target.
 * @returns the safe href, or `undefined` when the target is disallowed.
 */
export function safeHrefForExternal(url: string): string | undefined {
  const value = url.trim()
  if (value.startsWith('#')) return value
  try {
    const parsed = new URL(value, 'https://anchor.local/')
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return undefined
  } catch {
    return undefined
  }
  return value
}
