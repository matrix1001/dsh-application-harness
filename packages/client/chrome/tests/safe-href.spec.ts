// @vitest-environment jsdom
/**
 * The shared link-safety helper: `safeHrefForExternal` judges link targets
 * through the WHATWG URL parser (the browser's own) so a tab/newline-prefixed
 * scheme cannot bypass the whitelist (the parser strips ASCII tab/newline
 * before scheme recognition — arch-review 批 K xss-safeHref-tab-newline).
 */
import { describe, expect, it } from 'vitest'
import { safeHrefForExternal } from '../src/safe-href.ts'

describe('safeHrefForExternal', () => {
  it('accepts http/https/mailto targets', () => {
    expect(safeHrefForExternal('https://example.com/x')).toBe('https://example.com/x')
    expect(safeHrefForExternal('http://example.com')).toBe('http://example.com')
    expect(safeHrefForExternal('mailto:a@b.c')).toBe('mailto:a@b.c')
  })

  it('accepts anchors and scheme-less relative targets', () => {
    expect(safeHrefForExternal('#section')).toBe('#section')
    expect(safeHrefForExternal('docs/guide.md')).toBe('docs/guide.md')
    expect(safeHrefForExternal('/absolute/path')).toBe('/absolute/path')
  })

  it('rejects scriptable and unexpected schemes', () => {
    expect(safeHrefForExternal('javascript:alert(1)')).toBeUndefined()
    expect(safeHrefForExternal('data:text/html,x')).toBeUndefined()
    expect(safeHrefForExternal('vbscript:x')).toBeUndefined()
  })

  it('rejects the tab/newline scheme bypass (WHATWG folding)', () => {
    expect(safeHrefForExternal('java\tscript:alert(1)')).toBeUndefined()
    expect(safeHrefForExternal('java\nscript:alert(1)')).toBeUndefined()
    expect(safeHrefForExternal('java\rscript:alert(1)')).toBeUndefined()
  })

  it('rejects an unparseable target', () => {
    expect(safeHrefForExternal('http://[invalid')).toBeUndefined()
  })
})
