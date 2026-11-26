---
name: application-harness-maintenance
description: Use when auditing, cleaning, or upgrading the dsh-application-harness repository itself — legacy/dead-code removal, A/B simplification decisions, DSH platform adaptation, the client UI boundary, data cleanup, architecture invariants, and release validation. Not for ordinary application authoring.
---

# Application Harness maintenance

This skill is for maintainers of **this repository**, not for application authors.
Application authoring starts at [APPLICATION_DEVELOPMENT.md](../../docs/APPLICATION_DEVELOPMENT.md); general DSH facts come from the `dsh-doc` skill, not from memory.

Loading this skill authorizes no file change, profile change, data deletion, or push. Apply the repository's normal confirmation rules.

## Start here

1. Read [AGENTS.md](../../AGENTS.md), [docs/README.md](../../docs/README.md), and the relevant design document.
2. Read [11-实现与验收.md](../../docs/architecture/11-实现与验收.md) for the current implementation map and [REFERENCE.md](../../docs/REFERENCE.md) for symbols/errors/state files.
3. For DSH facts, load `dsh-doc`; confirm the installed version with `cordis_inspect` `Runtime.getVersion` and inspect the owning package before copying a platform behavior.
4. Check `git status`, the current branch, and the working tree before editing. Keep unrelated changes.

## Non-negotiables

- **No compatibility shims.** Do not preserve old schemas, old file layouts, old wire forms, or "just in case" branches. Historical Git is the archive.
- **Data is not code.** Deleting or replacing business data needs an explicit target path, a backup, and confirmation. Never scan or delete a home directory by inference.
- **One source per fact.** Host data goes through `ctx.applicationStore`; activation is owned by the bridge; data import/restore commit from the plan; do not reintroduce a second reader/writer.
- **Core contracts first.** Change types/contracts, then callers, tests, docs, and snapshots.
- **Client boundary.** Production client code must not value-import `@deepseek-ai/dsh-client-*`. Type-only imports are allowed because they are erased. `scripts/check-client-ui-imports.mjs` enforces this in the gate.
- **Verify before claiming.** A build alone is not verification. Use the ladder in [validation.md](references/validation.md).

## Workflow

1. **Inventory.** Find the real duplication, compatibility, dead exports, repeated validation, stale docs, and platform coupling. Search before reading whole files.
2. **Classify.**
   - A = directly improvable internal change, no protocol/data/UI behavior change.
   - B = public API, wire, schema, data, UI behavior, or architecture; discuss and record the decision before implementation.
3. **Decide architecture with the user.** Present options, a recommendation, cost, and risk. Do not start a large migration from an assumed decision.
4. **Implement in small, revertible commits.** One concern per commit; keep generated artifacts and snapshots in the same commit when required.
5. **Verify and self-review.** Re-read the diff for accidental removals, then run the relevant checks.
6. **Report.** State what changed, what was intentionally not changed, verification results, and remaining release/data/manual steps.

## Where to look

| Need | Read |
|---|---|
| Architecture invariants and decisions | [architecture.md](references/architecture.md) |
| Audit, A/B, dead-code and data cleanup | [cleanup-audit.md](references/cleanup-audit.md) |
| Reusing DSH services and the official client rule | [platform-integration.md](references/platform-integration.md) |
| Local chrome controls, Menu/Modal, theme tokens | [ui-boundary.md](references/ui-boundary.md) |
| DSH_HOME, backups, WAL, schema rejection | [data-safety.md](references/data-safety.md) |
| Commands, coverage, browser, release gate | [validation.md](references/validation.md) |

## Stop and ask

Stop before changing:
- a public API, wire protocol, data schema, or persisted format;
- real application data;
- the DSH profile or a deployment;
- a UI interaction whose semantics are not covered by a test.

State the exact target and proposed action, take a backup, and wait for confirmation.

## Anti-patterns

- Copying platform implementation instead of writing the smallest own control; see the client boundary.
- Deleting a dependency because it looks unused without running the platform-fixture typecheck.
- Keeping a test-only production abstraction.
- Adding a fallback for an old peer/version.
- Treating a stale audit file or this session's narration as current state.
