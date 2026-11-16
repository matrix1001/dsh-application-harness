/**
 * Script-plane tests for the acceptance scripts' unified-store reader
 * (`node --test`, NOT vitest — vitest collects `packages/*​/*​/tests/**` only).
 *
 * The subject is the AUTHORITY the four-app lane reads back: the SQLite
 * namespace the host writes, not the legacy JSON files that a migrated
 * deployment leaves untouched. The failure this covers is exactly ENG-001 — a
 * saved document reported missing because the reader looked at the old file.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { appDataDbPath, readAppDocument } from '../app-store-read.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BUILT = join(ROOT, 'packages', 'application', 'store', 'lib', 'sqlite-store.js')
const TMP = join(ROOT, 'tmp')
mkdirSync(TMP, { recursive: true })

/** Run `body` against a fresh temp dir, removed afterwards. */
async function withDir(body) {
  const dir = mkdtempSync(join(TMP, 'app-store-read-test-'))
  try {
    return await body(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('reads the document the host wrote, and never a stale legacy file beside it', { skip: !existsSync(BUILT) && 'run pnpm run build first' }, async () => {
  const { SqliteDataStore } = await import(pathToFileURL(BUILT).href)
  await withDir(async (dir) => {
    const home = join(dir, 'home')
    mkdirSync(join(home, 'application-harness'), { recursive: true })
    const dbPath = appDataDbPath(home)
    assert.equal(dbPath, join(home, 'application-harness', 'app-data.sqlite'))
    const store = new SqliteDataStore({ dbPath })
    store.putDocument('info-hub', 'settings', { inboxRetentionDays: 90, inboxMaxEntries: 10_000 })
    store.close()
    // The legacy source stays behind with a DIFFERENT value: a migration does
    // not rewrite it, so treating it as the answer would report the old value.
    writeFileSync(join(home, 'application-harness', 'store.json'), JSON.stringify({ settings: { inboxRetentionDays: 7 } }), 'utf8')

    const read = readAppDocument(dbPath, 'info-hub', 'settings')
    assert.equal(read.state, 'ok')
    assert.equal(read.value.inboxRetentionDays, 90)
    // The row's own bookkeeping travels with the value (a lane can tell a
    // re-read from a cached answer).
    assert.ok(read.revision >= 1)
    assert.ok(read.updatedAt > 0)
  })
})

test('a missing row is not "the old file", and a missing database is not a row', { skip: !existsSync(BUILT) && 'run pnpm run build first' }, async () => {
  const { SqliteDataStore } = await import(pathToFileURL(BUILT).href)
  await withDir(async (dir) => {
    const home = join(dir, 'home')
    mkdirSync(join(home, 'application-harness'), { recursive: true })
    const dbPath = appDataDbPath(home)
    const store = new SqliteDataStore({ dbPath })
    store.putDocument('workbook', 'document', { notes: [] })
    store.close()
    writeFileSync(join(home, 'application-harness', 'workbook.json'), JSON.stringify({ notes: [{ id: 'n1' }] }), 'utf8')

    // The database exists and its namespace has no such scope: the answer is
    // "no document", never the legacy file's notes.
    assert.deepEqual(readAppDocument(dbPath, 'workbook', 'absent'), { state: 'missing' })
    assert.deepEqual(readAppDocument(dbPath, 'other-app', 'document'), { state: 'missing' })
    assert.deepEqual(readAppDocument(join(dir, 'nothing.sqlite'), 'workbook', 'document'), { state: 'missing-db' })
  })
})

test('an unreadable database is reported as a failed read, not as an empty namespace', async () => {
  await withDir(async (dir) => {
    const dbPath = join(dir, 'app-data.sqlite')
    writeFileSync(dbPath, 'not a sqlite database', 'utf8')
    const read = readAppDocument(dbPath, 'workbook', 'document')
    assert.equal(read.state, 'unreadable')
    assert.equal(typeof read.error, 'string')
  })
})
