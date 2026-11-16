import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mergeDocument, transformInfoHub, transformWorkbook } from '../migrate-apps.mjs'

const ROOT = new URL('../..', import.meta.url).pathname

function fixture() {
  return {
    schemaVersion: 1,
    revision: 3,
    notes: [{
      id: 'n1', text: '标题\n\n正文', ts: 10, updated: 20, version: 2, tags: ['a'], pinned: true,
      source: { app: 'inbox', id: 'e1', url: 'https://example.test', title: '来源', excerpt: 'x', at: 5 },
    }, { id: 'n2', text: '删除的', ts: 1, version: 1, deleted: true }],
    projects: [{ id: 'p1', name: '项目', description: '旧描述', color: 'red', archivedAt: 3, createdAt: 1, updatedAt: 2, version: 2 }],
    tasks: [
      { id: 't1', title: '任务', description: '说明', projectId: 'p1', dueDate: '2026-11-05', assignee: 'agent', priority: 'high', status: 'done', completedAt: 30, noteIds: ['n1'], createdAt: 1, updatedAt: 2, version: 3 },
      { id: 't2', title: '未完成', description: '', projectId: null, dueDate: null, assignee: 'me', priority: 'low', status: 'todo', completedAt: null, noteIds: [], createdAt: 1, updatedAt: 2, version: 1, deletedAt: 4 },
    ],
    events: [{ id: 'e1', title: '事件', description: '', location: 'A', time: { kind: 'allDay', startDate: '2026-11-05', endDateExclusive: '2026-11-06' }, createdAt: 1, updatedAt: 2, version: 1 }],
    noteMetadata: [], receipts: [],
  }
}

function database() {
  const dir = mkdtempSync(join(tmpdir(), 'migrate-apps-'))
  const path = join(dir, 'app-data.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE app_documents (app_id TEXT NOT NULL, scope TEXT NOT NULL, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (app_id, scope)) WITHOUT ROWID;
    CREATE TABLE app_collections (app_id TEXT NOT NULL, collection TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (app_id, collection, key)) WITHOUT ROWID;`)
  db.prepare('INSERT INTO app_documents VALUES (?, ?, ?, ?, ?, ?)').run('workbook', 'document', 1, 3, JSON.stringify(fixture()), 1)
  db.close()
  return { dir, path }
}

describe('workbook migration', () => {
  it('maps ids, fields and deletion state into the three new documents', () => {
    const result = transformWorkbook(fixture())
    assert.deepEqual(result.counts, { notes: 2, tasks: 2, projects: 1, events: 1 })
    assert.equal(result.notes.notes[0].title, '标题')
    assert.equal(result.notes.notes[0].source.app, 'inbox')
    assert.equal(result.notes.notes[1].deletedAt, 1)
    assert.equal(result.tasks.tasks[0].priority, 1)
    assert.equal(result.tasks.tasks[0].completedAt, 30)
    assert.equal(result.tasks.tasks[1].deletedAt, 4)
    assert.equal(result.tasks.tasks[0].noteIds[0], 'n1')
    assert.equal(result.calendar.events[0].id, 'e1')
  })

  it('maps info-hub entries and sources without copying tokens', () => {
    const result = transformInfoHub([{
      key: 'release:deepseek-ai/repo:tag', kind: 'release', sourceId: 'deepseek-ai/repo', externalId: 'tag',
      title: '发布', url: 'https://example.test', publishedAt: '2026-11-05T00:00:00.000Z', excerpt: '摘要', body: '正文',
      read: true, readAt: 5, favorited: true, addedAt: 10, updatedAt: 11, seenAt: 0,
    }], { trackedRepos: [{ repo: 'deepseek-ai/repo', enabled: true, discussions: false, topic: '', intervalMs: 0 }], githubToken: 'secret' })
    assert.deepEqual(result.counts, { sources: 1, entries: 1 })
    assert.equal(result.document.sources[0].kind, 'github')
    assert.equal(result.document.entries[0].sourceId, 'github:deepseek-ai/repo')
    assert.equal(result.document.entries[0].favorite, true)
    assert.equal(JSON.stringify(result.document).includes('secret'), false)
  })

  it('merges by id and keeps existing fields and records', () => {
    const existing = { schemaVersion: 1, notes: [{ id: 'n1', body: 'keep' }], projects: [{ id: 'p1' }], tasks: [{ id: 't1' }] }
    const incoming = { schemaVersion: 1, notes: [{ id: 'n1', body: 'new' }, { id: 'n2', body: 'add' }], projects: [{ id: 'p2' }], tasks: [{ id: 't2' }] }
    const merged = mergeDocument('tasks', existing, incoming)
    assert.deepEqual(merged.tasks.map(task => task.id), ['t1', 't2'])
    assert.deepEqual(merged.projects.map(project => project.id), ['p1', 'p2'])
    const notes = mergeDocument('notes', existing, incoming)
    assert.deepEqual(notes.notes.map(note => [note.id, note.body]), [['n1', 'keep'], ['n2', 'add']])
  })

  it('refuses a malformed source document instead of guessing', () => {
    assert.throws(() => transformWorkbook({ schemaVersion: 2, notes: [], tasks: [], projects: [], events: [] }), /unsupported/u)
    assert.throws(() => transformWorkbook({ schemaVersion: 1, notes: [], tasks: [], projects: [] }), /no events/u)
  })

  it('dry-runs by default and appends missing legacy records without replacing existing ones', () => {
    const { dir, path } = database()
    try {
      const dry = execFileSync(process.execPath, [join(ROOT, 'scripts/migrate-apps.mjs'), '--db', path], { encoding: 'utf8' })
      assert.match(dry, /dry run/u)
      const db = new DatabaseSync(path)
      assert.equal(db.prepare('SELECT 1 FROM app_documents WHERE app_id = ?').get('notes'), undefined)
      db.close()

      execFileSync(process.execPath, [join(ROOT, 'scripts/migrate-apps.mjs'), '--db', path, '--apply', '--yes'], { encoding: 'utf8' })
      const check = new DatabaseSync(path)
      assert.equal(JSON.parse(check.prepare('SELECT value FROM app_documents WHERE app_id = ? AND scope = ?').get('notes', 'document').value).notes.length, 2)
      check.prepare('DELETE FROM app_documents WHERE app_id = ? AND scope = ?').run('tasks', 'document')
      check.prepare('INSERT INTO app_documents VALUES (?, ?, ?, ?, ?, ?)').run('tasks', 'document', 1, 1, JSON.stringify({ schemaVersion: 1, projects: [], tasks: [] }), 1)
      check.close()

      const again = execFileSync(process.execPath, [join(ROOT, 'scripts/migrate-apps.mjs'), '--db', path, '--apply', '--yes'], { encoding: 'utf8' })
      assert.match(again, /merged legacy records into tasks\/document/u)
      assert.match(again, /legacy data was not modified/u)
      const merged = new DatabaseSync(path)
      assert.equal(JSON.parse(merged.prepare('SELECT value FROM app_documents WHERE app_id = ? AND scope = ?').get('tasks', 'document').value).tasks.length, 2)
      merged.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
