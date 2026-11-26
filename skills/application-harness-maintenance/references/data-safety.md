# Data safety

## Locate the real data

Application data is the unified SQLite database declared by the deployment:
`dshHomePath('application-harness/app-data.sqlite')` in the bundle patch. It is usually
`$DSH_HOME/application-harness/app-data.sqlite`.

Do not infer `DSH_HOME`, a workspace, or a namespace. Print the resolved path and read
the database with a read-only connection first. One `DSH_HOME` has one writer.

## Before a cleanup

1. Stop or verify no host is writing the database.
2. Read the namespaces and schema versions:
   - `app_documents(app_id, scope, schema_version, revision, ...)`
   - `app_collections(app_id, collection, key, ...)`
3. Make a consistent backup with `SqliteDataStore.backupTo` (VACUUM INTO). Choose a
   new file under the harness backups directory; never overwrite one.
4. Verify the backup still holds the rows you intend to remove.
5. Delete only the named namespaces/rows. Preserve siblings (`home`, `todo`, etc.).
6. Re-open the live database and verify counts; verify the backup again.

`replaceNamespace(namespace, { documents: {}, collections: {}, meta: {} })` clears one
namespace through the store. A direct SQL delete is acceptable only after the same
read/backup/verification steps.

## Logical vs physical deletion

A committed SQLite delete is logical for the live file. Old bytes can remain in:

- `app-data.sqlite-wal` / `-shm`;
- a `.before-import-*` backup;
- the backup you just created.

Physical erasure requires a separate confirmed action: checkpoint/truncate WAL,
delete the chosen backups, and optionally `VACUUM`. Never do this merely because a
schema was rejected. State the exact files and retain a recovery copy unless the user
explicitly asks for irreversible deletion.

## Schema changes

Changing an application document schema is a data-format decision. Schema N+1 should
reject N on load; do not auto-migrate. If old data is to be removed, follow the cleanup
steps and document the rejection behavior. Tests must seed the new version and cover
the rejection of the old one.

## Tests

Use a temp `DSH_HOME`/database per test. Never point a test at the developer's real
harness home. Clean up temp directories in `afterEach`/`finally`.
