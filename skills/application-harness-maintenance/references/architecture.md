# Architecture invariants

These are the current decisions. If code and this page disagree, inspect the source and fix the mismatch; do not quietly restore the old shape.

| Fact | Current owner | Do not reintroduce |
|---|---|---|
| Application data | `ctx.applicationStore` (`AppStore` / `SqliteDataStore`) | `app-bridge.dataPath`, a second SQLite connection opened by the bridge, two path configs |
| Activation | `app-bridge` reading `activation.json` | runtime `activationPath` / `initialActivation` file reader; a second disabled set |
| Import/restore commit | in-memory data plan | passing `json`, `backupPath`, or `previewFingerprint` again at commit; the plan payload and base are authoritative |
| Table state | `AppTableStore<T>` for model selection/usage/limits | three copies of load → serial queue → rollback |
| JSONL control files | `jsonl.ts` for history/tasks | two copies of append/rotate/parse/caller validation |
| Page record ownership | `PageRecordRef.appId` / `PageRecordReference.appId` | legacy optional ownership, matching by kind alone |
| Progress takeover | gone | `ApplicationViewData.claimProgress`, shell claim maps, per-call filtering |
| Page record families | notes + todo only | a production `workbook` row; `excerpt` / `archived` features that only a test fixture uses |
| Validation list | `scripts/gate.mjs` | separate release/Gate/CI lists that drift |

## Store ownership

`app-store` must be mounted before `app-bridge`. The bridge resolves `ctx.applicationStore`; if it is absent it refuses to mount. Data management opens no separate live database. Backup/restore still reads a backup file directly, which is not a second live owner.

When changing the store:
- keep `dbPath` one value;
- keep one writer per `DSH_HOME`;
- update `packages/bundle/app-harness/cordis.patch.yml` and regenerate the web overlay;
- run `verify-build-role`, `verify-runtime-deps`, and the data tests.

## Activation and start gating

The bridge owns the file and the start gate. Runtime accepts only an explicit programmatic activation snapshot for embedders. Do not add a sync file read back to runtime; it creates two disabled states and a race before the bridge installs its resolver.

## Plan commits

`dataImport(appId, planId, requestId)` and `dataRestore(appId, planId, requestId)` are the public commit shapes. The preview plan stores the filtered JSON or backup path, base revision, expiry and replay results. A retry with the same request id returns the first committed result; a different request id is refused.

## Context and app identity

`PageRecordRef.appId` and `PageRecordReference.appId` are required. The host rejects a record or selection whose owner differs from the page's app. `unified.namespace` must equal the app id. Route all app data management through the declared unified namespace.

## Gate

`release:check` delegates to `node scripts/gate.mjs`. CI selects named gate steps; do not add a second workflow list. Coverage policy and diff coverage run inside the coverage step, not again in contracts.
