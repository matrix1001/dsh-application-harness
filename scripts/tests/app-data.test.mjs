import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CLI = join(ROOT, 'scripts', 'app-data.mjs')
const BUILT = join(ROOT, 'packages', 'application', 'store', 'lib', 'sqlite-store.js')
const TMP = join(ROOT, 'tmp')
mkdirSync(TMP, { recursive: true })

/** Run the documented CLI shape without a shell. */
function cli(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' })
}

test('backup, export, dry-run and import operate on the unified store', { skip: !existsSync(BUILT) && 'run pnpm run build first' }, async () => {
  const dir = mkdtempSync(join(TMP, 'app-data-test-'))
  try {
    const db = join(dir, 'app-data.sqlite')
    const { SqliteDataStore } = await import(pathToFileURL(BUILT).href)
    const store = new SqliteDataStore({ dbPath: db })
    store.putDocument('alpha', 'settings', { theme: 'dark' })
    store.putCollectionItem('alpha', 'inbox', 'one', { title: 'first' })
    store.close()

    const checked = cli('check', '--db', db)
    assert.equal(checked.status, 0, checked.stderr)
    assert.match(checked.stdout, /"appId": "alpha"/)
    assert.match(checked.stdout, /"inbox": 1/)

    const backup = join(dir, 'backup.sqlite')
    const backed = cli('backup', '--db', db, '--out', backup)
    assert.equal(backed.status, 0, backed.stderr)
    assert.ok(existsSync(backup))

    const exported = join(dir, 'export.json')
    const dumped = cli('export', '--db', db, '--out', exported)
    assert.equal(dumped.status, 0, dumped.stderr)
    const dump = JSON.parse(readFileSync(exported, 'utf8'))
    assert.equal(dump.apps.alpha.documents.settings.value.theme, 'dark')

    // A dry run validates in memory and leaves the real database untouched.
    dump.apps.alpha.collections.inbox.push({ key: 'two', seq: 2, value: { title: 'second' }, updatedAt: Date.now() })
    writeFileSync(exported, JSON.stringify(dump), 'utf8')
    const before = readFileSync(db)
    const dry = cli('import', '--db', db, '--from', exported, '--dry-run')
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /dry-run OK/)
    assert.deepEqual(readFileSync(db), before)

    const imported = cli('import', '--db', db, '--from', exported)
    assert.equal(imported.status, 0, imported.stderr)
    assert.match(imported.stdout, /pre-import backup/)
    const rows = cli('check', '--db', db)
    assert.match(rows.stdout, /"inbox": 2/)

    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{"not":"a dump"}', 'utf8')
    const refused = cli('import', '--db', db, '--from', bad, '--dry-run')
    assert.equal(refused.status, 1)
    assert.match(refused.stderr, /app-data:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('refuses an unknown command and a missing required flag', () => {
  assert.equal(cli('wat').status, 1)
  assert.equal(cli('check').status, 1)
})
