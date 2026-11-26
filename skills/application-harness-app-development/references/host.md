# Host rules

Mechanisms and examples: [APPLICATION_DEVELOPMENT.md §4](../../../docs/APPLICATION_DEVELOPMENT.md#4-管理数据与使用能力),
[§3.1](../../../docs/APPLICATION_DEVELOPMENT.md#31-声明和订阅业务变化) and
[§7](../../../docs/APPLICATION_DEVELOPMENT.md#7-生命周期与后台任务). When this page and the
guide/source disagree, the guide/source wins.

## Store

- Use only the `GatedStore` handed to the mount factory; never import the store, open SQLite, or reach another app's namespace.
- Writes that can race carry `expectedRevision`; a conflict is a business result, not a silent overwrite.
- Keep one serial write queue per document if the repository does load → mutate → put.
- Do not pass a raw namespace, store service or peer handle to a page.

## Capabilities

- Declare only what the app uses; attach the capability door in `start`.
- A missing grant means refusal; never fall back to an unguarded path.
- Confirmation exposure belongs to the operation declaration, not a page-local reimplementation.

## Peer calls and events

- Call peers through the runtime/operation context; never import the peer's host module or repository.
- `calls` declares exact `ops`; do not use a broad "all open operations" string for a new app.
- Treat peer answers as untrusted JSON; a refused/failed peer call degrades the feature, not the app.
- Never manufacture a Session to make a call; caller identity is runtime-owned.
- Publish only declared events; use `notifyChanged` for durable state, not for transient progress.

## Tasks and errors

- Long work uses the task surface and its cancellation signal, not an invisible closure.
- Progress is transient; do not persist it as business state or replay it from a task file.
- Background work has no interactive confirmation channel; fail closed if it cannot be asked.
- Use `AppError` with stable codes; never leak traces, credentials or raw model output.
- A failed write leaves the previous state and explains the code; a successful return means the Host accepted it.

## Files and network

- App-owned attachment files have explicit size/MIME/export/backup rules; platform prompt attachments are a different lifecycle.
- Outbound HTTP uses `ctx.applicationHttp`, not `ctx.web`; keep the app's private-network fence and proxy.
- Git/process work uses `ctx.subprocess.spawn` with timeouts/output caps; map spawn failures to stable errors.
