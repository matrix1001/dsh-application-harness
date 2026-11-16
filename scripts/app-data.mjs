#!/usr/bin/env node
/**
 * Local data-management command for the unified application store.
 *
 * It operates on the SQLite file directly and never starts an application:
 * `check` reports row counts, `backup` takes a consistent `VACUUM INTO`
 * snapshot, `export` writes the reviewable JSON dump, and `import` restores a
 * dump after taking a pre-import backup (or validates it in `:memory:` with
 * `--dry-run`). Application-level migration runs when an application first
 * starts; this command is the explicit backup/restore path beside it.
 *
 * Usage:
 *   node scripts/app-data.mjs check --db ~/.dsh/application-harness/app-data.sqlite
 *   node scripts/app-data.mjs backup --db <db> --out <backup.sqlite>
 *   node scripts/app-data.mjs export --db <db> --out <data.json>
 *   node scripts/app-data.mjs import --db <db> --from <data.json> [--replace] [--dry-run]
 * @module scripts/app-data
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const BUILT = resolve(ROOT, 'packages/application/store/lib/sqlite-store.js')

/** Parse the small `--flag value` vocabulary; unknown flags are refused. */
function parseArgs(argv) {
  const [command, ...rest] = argv
  const flags = {}
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index]
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`)
    const name = token.slice(2)
    if (name === 'replace' || name === 'dry-run') { flags[name] = true; continue }
    const value = rest[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} needs a value`)
    flags[name] = value
    index += 1
  }
  return { command, flags }
}

/** Open the built store; the command is run after a build by design. */
async function openStore(path) {
  if (!existsSync(BUILT)) throw new Error(`the store is not built (${BUILT}); run pnpm run build first`)
  const { SqliteDataStore } = await import(BUILT)
  if (path === undefined) throw new Error('--db is required')
  return new SqliteDataStore({ dbPath: path })
}

/** One compact summary of an exported/opened store. */
function summarize(store) {
  const dump = store.exportAll()
  const apps = Object.entries(dump.apps).map(([appId, app]) => ({
    appId,
    documents: Object.keys(app.documents).length,
    collections: Object.fromEntries(Object.entries(app.collections).map(([name, rows]) => [name, rows.length])),
  }))
  return { apps, exportedAt: dump.exportedAt }
}

const { command, flags } = parseArgs(process.argv.slice(2))
try {
  if (command === 'check') {
    const store = await openStore(flags.db)
    try { console.log(JSON.stringify(summarize(store), null, 2)) } finally { store.close() }
  } else if (command === 'backup') {
    if (flags.out === undefined) throw new Error('--out is required')
    const store = await openStore(flags.db)
    try {
      mkdirSync(dirname(resolve(flags.out)), { recursive: true })
      store.backupTo(resolve(flags.out))
      console.log(`backup: ${resolve(flags.out)}`)
    } finally { store.close() }
  } else if (command === 'export') {
    if (flags.out === undefined) throw new Error('--out is required')
    const store = await openStore(flags.db)
    try {
      const dump = store.exportAll()
      writeFileSync(resolve(flags.out), `${JSON.stringify(dump, null, 2)}\n`, 'utf8')
      console.log(`exported ${Object.keys(dump.apps).length} app(s): ${resolve(flags.out)}`)
    } finally { store.close() }
  } else if (command === 'import') {
    if (flags.from === undefined) throw new Error('--from is required')
    const data = JSON.parse(readFileSync(resolve(flags.from), 'utf8'))
    if (flags['dry-run'] === true) {
      const memory = await openStore(':memory:')
      try {
        const summary = memory.importAll(data, { mode: flags.replace === true ? 'replace' : 'merge' })
        console.log(`dry-run OK: ${JSON.stringify(summary)}`)
      } finally { memory.close() }
    } else {
      const store = await openStore(flags.db)
      try {
        const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
        const backup = `${resolve(flags.db)}.before-import-${stamp}`
        store.backupTo(backup)
        const summary = store.importAll(data, { mode: flags.replace === true ? 'replace' : 'merge' })
        console.log(`imported: ${JSON.stringify(summary)}; pre-import backup: ${backup}`)
      } finally { store.close() }
    }
  } else {
    throw new Error('usage: app-data.mjs check|backup|export|import')
  }
} catch (error) {
  console.error(`app-data: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
