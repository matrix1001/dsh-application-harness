# View rules

Registration mechanics, props and example code: [APPLICATION_DEVELOPMENT.md §5](../../../docs/APPLICATION_DEVELOPMENT.md#5-开发应用界面)
and [页面与人机交互](../../../docs/architecture/7-页面与人机交互.md). When this page and the
guide/source disagree, the guide/source wins.

## Registration

- The view package is a client plugin: register locale dictionaries and exactly one `ApplicationView` for the app id.
- Return registrations through `ctx.effect`; a second view for the same app id must fail, not silently override.
- The shell supplies `ApplicationViewProps`; use that face instead of importing host modules or the shell at runtime.
- `contentLayout: 'fill'` for a full-height workspace; put the scroll area inside the page.

## Page context

- Report only the page's real view/record; every record/selection entry carries the owning `appId`.
- Clear the report on close/record change; labels are display hints, not authorization.
- `ui` holds JSON only: drafts, filters, selections. No services, Promises, DOM nodes or handles.
- Page context applies only to the application-area/development Session, never ambiently to normal Sessions.

## Calls

- `call(op, args, requestId)` is the only path to the host; a refusal is a stable failure, not a thrown implementation detail.
- The transport `requestId` associates/cancels a call. It is not automatically a business idempotency key; pass a business id where replay matters.
- Keep the latest read only; a late read must not overwrite a newer one, and a failed refresh preserves existing content.
- Use `running` for in-flight state; do not build a second registry.

## UI

- Use repository `client-chrome` controls and shared layout components; do not value-import `@deepseek-ai/dsh-client-*`.
- Type-only slot/locale contracts are allowed; `check-client-ui-imports` is the gate.
- Use `--dsw-alias-*` tokens and the app scale; no literal colors or platform chat typography.
- Keep stable `data-*` anchors; prefer role/name assertions over CSS classes.
- Confirmations use `useConfirm`; do not use `window.confirm`. Preserve drafts when a close/save fails.
- Public copy comes from locale dictionaries.

## View tests

Render through fake `ApplicationViewProps`; cover loading, refusal/failure, latest-read ordering, dirty close, page-context cleanup and keyboard paths. Integration tests mount the real host/runtime rather than mocking the protocol.
