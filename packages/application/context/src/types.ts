/**
 * The page-reference vocabulary: what one `@page:` citation names, what the
 * harness found when it checked, and the durable message source the prepared
 * context carries into the model's step.
 *
 * Two halves of one feature meet here. The browser's page chip serializes a
 * token into the prompt (`packages/client/applications`); this package reads it
 * back at `agent/pre-step` and answers with the records the citation got right.
 * Nothing in this module is browser-visible — the client half builds the token
 * text itself and never imports this package (client packages do not import
 * host packages) — so the wire between them is the token grammar alone, pinned
 * by tests on both sides.
 * @module @matrix1001/dsh-application-harness-context/types
 */

import type { ContextSnapshotSection } from '@deepseek-ai/dsh-llm'

/** The record family a page citation names; applications define their own vocabulary. */
export type PageRecordKind = string

/** One record inside one application. */
export interface PageRecordReference {
  /** The application that owns the record. */
  readonly appId: string
  /** Which family the record belongs to. */
  readonly kind: PageRecordKind
  /** The record's id inside that family. */
  readonly id: string
  /** A display label the citing page knew; never a substitute for reading the record. */
  readonly label?: string
}

/** One parsed `@app:` reference: the application itself, never a record. */
export interface AppReference {
  /** The application whose identity the user referenced. */
  readonly appId: string
}

/**
 * One parsed reference: an application identity or a page/record citation.
 * The source tag keeps the two model-facing meanings from being conflated.
 */
export type Reference =
  | (AppReference & { readonly source: 'app' })
  | (PageReference & { readonly source: 'page' })

/**
 * One parsed `@page:` citation: the application, and the record inside it when
 * the token named one. A citation of the page itself carries no record.
 */
export interface PageReference {
  /** The application whose page was cited. */
  readonly appId: string
  /** The record the citation named, when it named one. */
  readonly record?: PageRecordReference
}

/**
 * What the harness read back about one cited record, in the record's own
 * terms — the minimal facts a model needs to know it is looking at the right
 * object. The record's body stays in the application: a note contributes one
 * bounded line, never its text.
 */
export interface PageRecordFacts {
  /** The record's family, echoed so a reader needs no cross-reference. */
  readonly kind: PageRecordKind
  /** The record's id, echoed for the same reason. */
  readonly id: string
  /** The record's own one-line label: a note's first line, a task's or event's title, a project's name. */
  readonly label?: string
  /** Soft-deleted: still in the application's document, out of its live view (restorable). */
  readonly deleted?: true
  /** Archived: readable, out of the application's active scope. */
  readonly archived?: true
}

/**
 * One citation as the injected context reports it. `found` carries what the
 * application answered (facts, when a record was cited); `stale` says the cited
 * record no longer exists, which the model must resolve by querying again
 * rather than by guessing a replacement.
 */
export type PageContextEntry =
  | {
    readonly status: 'found'
    /** The cited application. */
    readonly appId: string
    /** The application's declared display name. */
    readonly app: string
    /** The record the citation named; absent when the page itself was cited. */
    readonly record?: PageRecordReference
    /** What the application's read operation answered about that record. */
    readonly facts?: PageRecordFacts
  }
  | {
    readonly status: 'stale'
    /** The cited application. */
    readonly appId: string
    /** The application's declared display name, still known: the application is up, the record is gone. */
    readonly app: string
    /** The record that is gone. */
    readonly record: PageRecordReference
  }

/** One read-only operation an application offers to a referenced main conversation. */
export interface AppReadOp {
  /** The operation name. */
  readonly op: string
  /** The application's own one-line description of the read. */
  readonly description: string
}

/**
 * One application reference as the model sees it. Found applications carry only
 * identity and the declared operation catalog; business data is read separately through
 * the unified `applications` tool.
 */
export type AppContextEntry =
  | {
    readonly status: 'found'
    /** The referenced application. */
    readonly appId: string
    /** The application's declared display name. */
    readonly app: string
    /** The application's declared one-line description. */
    readonly description: string
    /** The operations the AI may read through the unified tool. */
    readonly readOps: readonly AppReadOp[]
  }
  | {
    readonly status: 'unavailable'
    /** The referenced application. */
    readonly appId: string
    /** The declared name when the application is registered but not callable. */
    readonly app?: string
    /** Why no read is possible. */
    readonly reason?: string
  }

/**
 * The injected application-reference message. It is deliberately separate from
 * the page snapshot: identity and a read catalog do not claim to carry data.
 */
export interface AppContextSource {
  readonly kind: 'app-context'
  readonly form: 'snapshot'
  /** The named contributions the model-facing text assembled, one per application. */
  readonly sections: readonly ContextSnapshotSection[]
  /** Every application reference that was checked, in first-appearance order. */
  readonly references: readonly AppContextEntry[]
}

/**
 * The injected message's durable source. `kind` is this package's own producer
 * identity in the merge-extensible {@link MessageSourceMap}; `form: 'snapshot'`
 * says the content is current state rather than an account of something that
 * happened, and `sections` are the per-citation contributions it assembled.
 */
export interface PageContextSource {
  readonly kind: 'page-context'
  /** Current state of the page the user cited. */
  readonly form: 'snapshot'
  /** The named contributions the model-facing text assembled, one per citation. */
  readonly sections: readonly ContextSnapshotSection[]
  /** Every citation that was verified, in first-appearance order. */
  readonly references: readonly PageContextEntry[]
}

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'app-context': AppContextSource
    'page-context': PageContextSource
  }
}
