/**
 * The browser half of the `@page:` citation grammar: the one string a page
 * reference serializes into the prompt.
 *
 * Grammar — `<…>` names a field, `[…]` an optional half:
 *
 *     @page:<appId>[:<kind>:<id>]
 *
 * The host half (`@matrix1001/dsh-application-harness-context`) parses exactly this and
 * nothing else: neither half may import the other (client packages never import
 * host packages), so the literal grammar is the contract between them and each
 * half pins it in its own tests.
 *
 * The token is a pure function of the reference — the same application and
 * record always spell the same token — which is what makes a chip stable: the
 * token is fixed when the chip is inserted and travels with the message, so
 * what the model receives never depends on which page is open at submit time.
 * @module @matrix1001/dsh-application-harness-client-applications/client/page-token
 */

import type { PageRecordRef } from './contract.ts'

/**
 * The canonical token of one citation.
 * @param appId - the application whose page is cited.
 * @param record - the record cited, when the citation names one.
 * @returns the token, e.g. `@page:workbook` or `@page:workbook:note:n3`.
 */
export function pageToken(appId: string, record: PageRecordRef | undefined): string {
  return record === undefined ? `@page:${appId}` : `@page:${appId}:${record.kind}:${record.id}`
}


/**
 * The canonical token of one application reference.
 * @param appId - the application the user references.
 * @returns the token, e.g. `@app:workbook`.
 */
export function appToken(appId: string): string {
  return `@app:${appId}`
}
