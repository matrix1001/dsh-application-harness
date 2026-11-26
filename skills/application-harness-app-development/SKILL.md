---
name: application-harness-app-development
description: Use when adding or changing an application in dsh-application-harness: host declaration and operations, gated storage, capabilities, tasks/events, client view registration, page context, drafts, navigation, deployment rows, and the app's tests. Not for maintaining the harness itself.
---

# Application Harness app development

This skill is for application authors working **inside this repository**. Repository maintenance is a separate skill (`application-harness-maintenance`); DSH platform facts come from `dsh-doc`. The public, human-facing contract remains [APPLICATION_DEVELOPMENT.md](../../docs/APPLICATION_DEVELOPMENT.md); this skill is the agent-facing entry into it. Mechanics, full examples and exact signatures live there and in the source: **if this skill and the guide/source disagree, the guide/source wins; update the skill.**

Loading this skill authorizes no install, profile change, data deletion, or push.

## Start here

1. Read [APPLICATION_DEVELOPMENT.md](../../docs/APPLICATION_DEVELOPMENT.md), especially the operation, page, and validation sections.
2. Read [REFERENCE.md](../../docs/REFERENCE.md) for current symbols/errors and [11-实现与验收.md](../../docs/architecture/11-实现与验收.md) for current behavior.
3. Use an existing app as the closest example: `notes` (document + attachments + model), `todo` (document + delegations), `inbox` (document + tasks + HTTP), `git-browser` (subprocess + read-only view), `home` (peer reads + events).
4. For a new package, follow the scaffold section in the guide (`node scripts/new-app.mjs`); do not hand-copy package plumbing.

## Workflow

1. **Decide identity.** Pick an app id, unified namespace (must equal the id), package names, version, and whether the app has a view. This is a user-facing identity decision.
2. **Host first.** Write the declaration and operations, then mount with `mountApplication` and the gated store. Add start/stop/reload only where lifecycle work exists.
3. **View second.** Register the page through `ctx.applicationViews.register(appId, view)`; use the props face for calls, cancellation, page context, drafts and navigation.
4. **Contract tests.** Test the declaration/ops and the view through the real runtime; assert `data-*` anchors rather than CSS classes.
5. **Deployment.** Add the app rows to the bundle composition and deployment descriptor; run the generator/checks.
6. **Verify.** Run the ladder in [validation.md](references/validation.md), including app-scale and coverage.

## Non-negotiables

- **No direct database.** Host applications receive only a `GatedStore`; do not import the store, open SQLite, or reach another app's namespace. One app owns one namespace.
- **No fake Session.** Calls use the runtime's caller identity. Do not construct a Session to make a call, and do not bypass capability checks.
- **Declare behavior.** Every operation has `params`/`result`, an explicit `exposure` for AI/peers/human as applicable, and an honest `effect`. Writes that need confirmation say so.
- **Idempotency is business state.** If a write must be retried safely, accept/record a business `requestId`; the transport request id only cancels/associates a call.
- **Page ownership.** A page reports records with the owning `appId`; the host rejects a record/selection owned by another app. Page context only applies to the application-area/development Session, never ambiently to ordinary Sessions.
- **UI boundary.** Production client code may use the repository's `client-chrome` controls and platform services, but must not value-import `@deepseek-ai/dsh-client-*`. Type-only imports are allowed. `check-client-ui-imports` enforces this.
- **No compatibility layer.** New schemas reject old shapes explicitly; do not add silent migrations or dual wire forms.
- **No unsupported claims.** Host and view must agree on the declared operations, page fields and error codes.

## Where to look

| Need | Read |
|---|---|
| Package layout, declaration, mounting, data kind | [app-shape.md](references/app-shape.md) |
| Gated store, capabilities, tasks, events, peer calls | [host.md](references/host.md) |
| View registration, props, page context, drafts, UI | [view.md](references/view.md) |
| Tests, coverage, browser, deployment, release checks | [validation.md](references/validation.md) |

## Stop and ask

Ask before:
- changing a public app id, namespace, operation, event or persisted schema;
- granting a new platform capability or widening AI/peer exposure;
- deleting business data or changing its retention;
- adding a second data owner, Session, or direct network/storage path.

## Anti-patterns

- A view calling a host module directly instead of the `call` face.
- A host app storing business state in a module global while a gated store exists.
- A new platform client component import instead of a chrome control.
- A test that asserts implementation class names instead of `data-*` anchors.
- Adding an app row to code without the deployment/bundle generator and checks.
