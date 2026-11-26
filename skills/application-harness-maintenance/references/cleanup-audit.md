# Cleanup and A/B audit

## Search before reading

Use narrow, repeated searches; do not start with whole-tree dumps.

```sh
grep -RIn --include=*.ts --include=*.tsx -E "legacy|fallback|compat|optional on purpose|older|predates|migration" packages apps
grep -RIn --include=*.ts --include=*.tsx "as never|as unknown as" packages apps
grep -RIn --include=*.ts --include=*.tsx -E "TODO|FIXME|HACK" packages apps scripts
```

Look for:
- exports with no production caller (separate public API value from dead internal code);
- the same validation, JSON read/write, queue, or error mapping in two places;
- a parameter overwritten before use;
- a test-only production abstraction;
- a dependency removed without running the platform-fixture typecheck;
- docs claiming a feature or command the source no longer has.

## A/B classification

**A: change directly**
- internal renaming/extraction with no public behavior;
- a dead parameter/field/export with no consumer;
- duplicate validation replaced by the existing single helper;
- build/check duplication with the same pass/fail set;
- a bug fix covered by an existing test surface.

**B: decide first**
- public API/Remote/type changes;
- schema, wire, persisted JSONL/SQLite format;
- UI interaction or visual behavior;
- data deletion or a data-retention boundary;
- replacing one architecture owner with another;
- large test-fixture refactors.

For B, present: current shape, options, recommendation, files/tests affected, rollback. Wait for a decision before coding.

## Data cleanup

A data cleanup is not a code cleanup. Before deleting:
1. Resolve the exact `DSH_HOME`/database/namespace and read it back.
2. Confirm the host is not writing.
3. Make a consistent backup (`SqliteDataStore.backupTo`/`VACUUM INTO`) and verify the backup contains the target data.
4. Delete only the named namespaces/rows; preserve siblings.
5. Re-read the live database and the backup.

Logical deletion is not physical erasure: SQLite WAL, `-shm`, and the backup may still contain old bytes. `VACUUM`, `wal_checkpoint(TRUNCATE)`, and backup removal are a separate destructive decision.

## Dependencies

A package can look unused and still be needed by the platform test fixture/types. Remove one at a time and run:

```sh
pnpm install
pnpm run typecheck
```

If `typecheck-tests` changes the recorded platform-fixture diagnostics, restore it. Do not "fix" the baseline to silence a real missing module.

## Test-only production code

A helper with only test callers is not automatically dead: it may be a public extension point. Check exports/API snapshot/docs. If it is only a test fixture, move the fixture to tests or remove the production branch; do not keep a generic feature no application uses.

## Commit hygiene

- One concern per commit.
- Include generated contract/API/deployment artifacts with the source change that requires them.
- Do not include `tmp/`, local homes, worktrees, or audit notes.
- Report the exact verification commands and any check that could not run.
