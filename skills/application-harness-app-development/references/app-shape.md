# App shape and declaration rules

This is the agent checklist, not the tutorial. Scaffold commands, full declaration
examples and exact signatures live in
[APPLICATION_DEVELOPMENT.md §2–4](../../../docs/APPLICATION_DEVELOPMENT.md#2-创建并运行第一个应用)
and the source; when this page and those disagree, the guide/source wins.

## Package shape

- Host package (`apps/<id>/host`) exports the Cordis plugin and the declaration/repository.
- Optional view package (`apps/<id>/view`) exports the client view registration and locale dictionaries.
- Use `scripts/new-app.mjs` for the skeleton; do not hand-copy another app's package plumbing.
- Rename every identity: package ids, app id, namespace, version, locale namespaces and `data-*` anchors.

## Declaration checklist

- `id`, display name/description, version.
- `data`: `unified` (namespace equal to the id + schema version) or `none`; another kind only with a real owner.
- `capabilities`: only what the app uses (`storage`, `model`, `network`, `process`, `delegate`).
- `ops`: description, params/result schema, effect, exposure, execute.
- `calls`: exact peer app/op pairs.
- `events`: declared publication/subscription.
- Lifecycle hooks only when they add real work.

## Hard rules

- Mount only through `mountApplication` with the gated store; never open the raw store, SQLite or another namespace.
- Schemas validate at the runtime boundary; business invariants still belong in `execute`.
- `exposure` and `effect` must describe the real audience/impact; a write that needs confirmation says so.
- `defineOperation` is optional; it does not replace lifecycle/notification wrappers.
- Do not add a second schema or request type that can drift from the operation contract.
- Changing the document shape means a new schema version that rejects old data; no silent migration.
- A business-owned file directory needs a declared location and an app-owned export/backup boundary; it is not a hidden second store.
- `start` must not write business state just to become ready; `stop` must be safe without a started store.
- A health hook returns a real state, not an optimistic constant.

## Read next

- Full scaffold/declaration examples: [guide §2–4](../../../docs/APPLICATION_DEVELOPMENT.md#2-创建并运行第一个应用)
- Lifecycle and background work: [guide §7](../../../docs/APPLICATION_DEVELOPMENT.md#7-生命周期与后台任务)
- Current public symbols: [REFERENCE.md](../../../docs/REFERENCE.md#符号速查)
