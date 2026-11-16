/**
 * The `@page:` citation token: the one wire form the browser's page chip
 * serializes into a prompt, and the parser this package reads it back with.
 *
 * Grammar — `<…>` names a field, `[…]` an optional half:
 *
 *     @page:<appId>[:<kind>:<id>]
 *
 * `<appId>` is the runtime's own application id (`^[a-z][a-z0-9-]*$`) and
 * `<kind>` is one of the record families a page can cite, so a citation names
 * an application and, at most, one record inside it. The bracketed half is
 * absent when the page cited itself rather than a record.
 *
 * A token is read only at a text boundary and must END at one: an `@` inside a
 * word or an address (a `…@page:book` is not a chip), a half-written record
 * half and a longer `@page:`-looking word are all read as no token rather than
 * half of one. Prose that happens to spell a whole valid token IS one — the
 * grammar cannot tell a chip from a sentence, and the citation it names is
 * exactly the citation the text asked for.
 *
 * The browser half builds exactly these strings (see the page-source module in
 * `packages/client/applications`); neither half may import the other, so the
 * literal grammar is the contract between them and each half pins it in its own
 * tests.
 * @module @matrix1001/dsh-application-harness-context/token
 */

import type { AppReference, PageRecordKind, PageReference, Reference } from './types.ts'

/** The shape of one application-defined record family. */
const KIND = '[a-z][a-z0-9-]*'

/**
 * One whole token, anywhere in a text value.
 *
 * `(?<![\w@])` is the opening boundary (`@page:` inside a word is not a chip)
 * and `(?![\w:-])` the closing one (a longer run that merely starts like a token
 * is no token at all). Both halves are load-bearing: without the second, a
 * half-written record half would be read as a citation of the page alone.
 */
const TOKEN = new RegExp(
  `(?<![\\w@])@page:([a-z][a-z0-9-]*)(?::(${KIND}):([A-Za-z0-9_-]+))?(?![\\w:-])`,
  'gu',
)

/** One application reference: the user is talking about the application itself. */
const APP_TOKEN = /(?<![\w@])@app:([a-z][a-z0-9-]*)(?![\w:-])/gu

/**
 * Every citation in one text value, in first-appearance order.
 *
 * A token repeated in the same text is one citation: the second occurrence says
 * nothing the first did not, and the model needs the reference once.
 * @param text - the text value to read (one content block, in practice).
 * @returns the citations, deduplicated in first-appearance order.
 */
export function parsePageTokens(text: string): PageReference[] {
  const references: PageReference[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(TOKEN)) {
    // The pattern's first group is mandatory, so a match always carries an
    // appId; the record half is present only when both its groups matched.
    const appId = match[1] as string
    const kind = match[2]
    const id = match[3]
    const reference: PageReference = kind === undefined || id === undefined
      ? { appId }
      // The kind group IS the kinds list the pattern was built from.
      : { appId, record: { kind: kind as PageRecordKind, id } }
    const key = citationKey(reference)
    if (seen.has(key)) continue
    seen.add(key)
    references.push(reference)
  }
  return references
}

/**
 * The identity of one citation. `appId`, kind and id cannot contain a `/` (the
 * runtime's id rules), so the parts cannot forge another citation's key — two
 * citations that name the same object always key the same.
 * @param reference - the citation.
 * @returns its identity key.
 */
export function citationKey(reference: PageReference): string {
  const { record } = reference
  return record === undefined ? reference.appId : `${reference.appId}/${record.kind}/${record.id}`
}

/**
 * Every application reference in one text value, in first-appearance order.
 * `@app:foo` names the application itself; it never carries a record half.
 * @param text - the text value to read.
 * @returns the application references, deduplicated in first-appearance order.
 */
export function parseAppTokens(text: string): AppReference[] {
  const references: AppReference[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(APP_TOKEN)) {
    const appId = match[1] as string
    if (seen.has(appId)) continue
    seen.add(appId)
    references.push({ appId })
  }
  return references
}

/**
 * Every reference in one text value, both kinds in first-appearance order.
 * Page and application tokens share a boundary rule but name different things:
 * the returned union keeps that distinction explicit.
 * @param text - the text value to read.
 * @returns the references, deduplicated by kind and identity.
 */
export function parseReferences(text: string): Reference[] {
  const found: Array<{ index: number; reference: Reference }> = []
  for (const match of text.matchAll(TOKEN)) {
    const appId = match[1] as string
    const kind = match[2]
    const id = match[3]
    const reference: Reference = kind === undefined || id === undefined
      ? { source: 'page', appId }
      : { source: 'page', appId, record: { kind: kind as PageRecordKind, id } }
    found.push({ index: match.index as number, reference })
  }
  for (const match of text.matchAll(APP_TOKEN)) {
    found.push({ index: match.index as number, reference: { source: 'app', appId: match[1] as string } })
  }
  found.sort((left, right) => left.index - right.index)
  const seen = new Set<string>()
  const references: Reference[] = []
  for (const { reference } of found) {
    const key = reference.source === 'app' ? `app:${reference.appId}` : `page:${citationKey(reference)}`
    if (seen.has(key)) continue
    seen.add(key)
    references.push(reference)
  }
  return references
}
