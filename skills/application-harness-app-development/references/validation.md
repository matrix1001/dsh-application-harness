# App validation

Full task guide: [APPLICATION_DEVELOPMENT.md §8](../../../docs/APPLICATION_DEVELOPMENT.md#8-测试调试与交付).
This page is the agent's command/checklist layer.

## Minimum by change

- Host/declaration: declaration/ops tests, store tests, `pnpm run typecheck`.
- View: view tests with fake props, `pnpm run typecheck`.
- UI behavior: `pnpm run test:browser`; manual 2× and dark-theme check.
- Public API/schema/capability: relevant contract tests and API/type updates.
- Deployment rows: generator `--check`, deployment/layering checks.
- Full delivery: `pnpm run release:check`.

## Commands

```sh
pnpm exec vitest run <paths>
pnpm run typecheck
pnpm run test:coverage
pnpm run build
node scripts/verify-app-scale.mjs --strict
pnpm run test:browser
node scripts/check-client-ui-imports.mjs
pnpm run release:check
```

For deployment rows additionally:

```sh
node scripts/generate-bundle-patch.mjs
node scripts/generate-bundle-patch.mjs --check
node scripts/verify-deployment-descriptor.mjs
node scripts/verify-build-role.mjs
```

`pnpm run test:browser` uses an isolated instance; it does not prove 2×/dark/screen-reader behavior.

## Coverage and tests

- Core `packages/application/**/src` is per-file 100%; app/view files follow the global/non-core floors and changed-line coverage.
- Use `pnpm run coverage:uncovered` for exact gaps; do not add an ignore without a reason.
- Test behavior through the public face: declaration/ops, `ApplicationViewProps`, `data-*` anchors. Do not assert CSS-module class names.
- Integration mount the real runtime; do not fake the protocol or manufacture a Session.

## Before finishing

Report:
- app identity/version and files/rows added;
- public operations/schemas/capabilities changed;
- commands run and results;
- what was not verified (manual browser/dark, push, install).
