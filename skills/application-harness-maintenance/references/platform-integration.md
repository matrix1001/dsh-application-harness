# DSH platform integration

Read facts from the installed version, not from this page alone. Use `dsh-doc` + `cordis_inspect` first; package README/source second. This page was written against the repository's current DSH line; confirm `Runtime.getVersion`/`engines.dsh` before relying on a platform package detail.

## Usually reusable (host)

| Need | DSH seam | Notes |
|---|---|---|
| Approval in an open turn | `ctx.approval.request` | Ask only for a live Agent, open turn; map `allowed-once` only. Use `displayReason` for localized copy; keep `reason` neutral for audit. |
| Git/process spawn | `ctx.subprocess.spawn` | Keep app-level timeout/output caps; use `resolveExecutable` only when a provider needs it. |
| Workspace registration | platform workspace service (`ctx.workspaces` on the client; Remote `workspace.create`) | It registers an **existing** directory. Host mkdir/symlink checks are a prerequisite, not a replacement. |
| Settings forms | `ctx.configForms` + `ConfigForm` data | Read `getSnapshot`/`subscribe`; write with `mutate` and a revision. A bespoke UI is fine; do not depend on platform form components. |
| Model calls | `ctx.llm` / `agentDefaultModel` | Do not create a second provider loop or a fake Session. |
| Tool surface | `ctx.tools` / Typert Remote | Use the generated schemas; do not hand-write a second protocol. |
| UI composition | slots, locale, conversation factory, `uiSession`, input triggers | These are services/contracts, not imported platform UI components. |

## Usually not reusable

- **`ctx.attachments`** — prompt attachment service: immutable, no business delete/list/quota/export, platform-owned bytes. Notes' business attachment store has a different lifecycle and backup boundary.
- **`ctx.web`** — model-facing web retrieval, not a general business HTTP client: it owns UA, size/character limits, redirects and may allow targets the app's private-network fence denies. Keep `applicationHttp` for app feeds/proxying.
- **`ctx.workingDirectory`** — moves a live Session's directory; it does not create/register an application workspace.
- **`ctx.userQuestions`** — HITL tool surface requiring a live Agent; not a replacement for the out-of-session confirmation table.
- **sandbox** — protects model tool calls; the app host is trusted same-process backend code. Do not add it just to mirror a platform feature.

## Client plugin rule

Official guidance for Harness Client plugins:

- Do **not** `require`/value-import `@deepseek-ai/dsh-client-ui-primitives` or any other `@deepseek-ai/dsh-client-*` package.
- Do **not** copy platform implementation source. Write the smallest own control, copy markup/CSS behavior (theme tokens, focus, ARIA), and keep a stable `data-*` test anchor.
- Type-only imports are allowed: they are erased and only describe platform slots/contracts.
- `scripts/check-client-ui-imports.mjs` is the gate. Keep it in `gate.mjs`.

## Platform module table

`packages/client/tsdown.client.ts` mirrors the installed shell's seed module table. It must keep `verify-platform-modules` green. Keeping a seed entry in that table is not an application dependency and does not mean the bundle imports the package.

## Before choosing a reuse

Check the package's actual contract and tests. If the platform seam does not match the app's lifecycle, security boundary, or backup model, keep the app implementation and record why. "Reuse" is not a goal by itself.
