# Validation ladder

Select by change surface; do not run release checks for a comment-only edit.

| Change | Minimum |
|---|---|
| Docs | `pnpm run check:docs`; verify links/commands against source |
| Internal code/refactor | targeted Vitest, `pnpm run typecheck` |
| Client/UI | chrome/app tests, `pnpm run test:browser`, manual 2×/dark check |
| Contract/API | generated types/tests, `verify-api-snapshot` (update when intended) |
| Store/data | data/restore/plan tests, startup with a temp home |
| Build/scripts/deployment | `pnpm run build`, relevant `scripts/tests/*.test.mjs`, descriptors/generator |
| Before release | `pnpm run release:check` |

## Useful commands

```sh
pnpm exec vitest run <paths>
pnpm run typecheck
pnpm run test:coverage
pnpm run build
pnpm run test:browser
pnpm run check:docs
pnpm run release:check
node scripts/verify-api-snapshot.mjs [--update]
node scripts/verify-build-role.mjs
node scripts/verify-runtime-deps.mjs
node scripts/generate-bundle-patch.mjs --check
```

`release:check` is the gate, not a publisher. It runs typecheck/docs/coverage/build/
scripts/publint/contracts/platform/smoke. CI uses selected gate steps; do not create a
second checklist.

## Coverage

Core `packages/application/**/src` stays at per-file 100%. Global/non-core floors and
changed-line coverage are in `check-coverage-policy`/`check-diff-coverage`. Use
`coverage:uncovered` for exact lines. A new helper needs a test or a removed branch,
not a blanket ignore. `v8 ignore` needs a reason.

## UI verification

Automated browser smoke covers keyless shell/application flows. It does not prove:

- 2× zoom/narrow layout;
- dark-theme contrast and token fallbacks;
- focus ring/menu placement with a real browser;
- screen-reader announcements.

Do these manually before a release. Keep `data-*` anchors stable for automation.

## Data isolation

Validation must use a temp `DSH_HOME`, profile, workspace, and port. Never read or
write the developer's live application home. Tests must clean their temp directories.

## Before claiming done

Report:
- files/commits changed;
- commands run and their result;
- intended API/data/UI breaks;
- what was not verified (manual browser, physical deletion, push);
- whether the tree is clean and whether anything was pushed.
