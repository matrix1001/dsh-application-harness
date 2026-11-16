/**
 * Client-namespace projection of the host application surface: a pure re-export
 * of the package's own browser-safe vocabulary. Client code imports ONLY the
 * client namespace (repo discipline), so `./client` projects the same
 * single-source content `./types` serves to host consumers — zero duplication.
 *
 * @module @matrix1001/dsh-application-harness-host-bridge/client
 */

export type * from './types.ts'
