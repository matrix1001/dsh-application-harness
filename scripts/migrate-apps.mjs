#!/usr/bin/env node
/**
 * One-time migration of the legacy Workbook document into the new applications'
 * unified namespaces. It is deliberately a separate, explicit command: the old
 * applications stay running and their document is never modified. A dry run is
 * the default; writing requires both `--apply` and `--yes`.
 *
 * The mapping is loss-aware: fields the new model does not have (project
 * description/color/archive, event project/task links) are dropped, while ids
 * and note/task links are preserved so cross-application references survive.
 * The command never deletes the old workbook data; removing the old rows is a
 * later, separately authorized cutover.
 *
 * Usage:
 *   node scripts/migrate-apps.mjs --db <app-data.sqlite>
 *   node scripts/migrate-apps.mjs --db <app-data.sqlite> --apply --yes
 * @module
 */

import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'

const SCOPE = 'document'

function civil(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) ? value : null
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback
}

function firstLine(body) {
  const line = body.split('\n').find(candidate => candidate.trim() !== '')?.trim() ?? '无标题'
  return line.length <= 200 ? line : `${line.slice(0, 199)}…`
}

function sourceOf(value) {
  if (typeof value !== 'object' || value === null) return undefined
  const source = value
  if (typeof source.app !== 'string' || typeof source.id !== 'string') return undefined
  return {
    app: source.app,
    id: source.id,
    ...(typeof source.url === 'string' ? { url: source.url } : {}),
    ...(typeof source.title === 'string' ? { title: source.title } : {}),
  }
}

/**
 * Transform one legacy workbook document into the three new documents.
 * @param {unknown} value - the stored workbook document.
 * @returns {{notes: object, tasks: object, calendar: object, counts: object}}
 */
export function transformWorkbook(value) {
  if (typeof value !== 'object' || value === null) throw new Error('workbook document is not an object')
  const doc = value
  if (doc.schemaVersion !== 1) throw new Error(`unsupported workbook schema ${String(doc.schemaVersion)}`)
  for (const key of ['notes', 'tasks', 'projects', 'events']) {
    if (!Array.isArray(doc[key])) throw new Error(`workbook document has no ${key} array`)
  }
  const notes = doc.notes.map(note => {
    const body = text(note.text)
    const source = sourceOf(note.source)
    return {
      id: note.id,
      title: firstLine(body),
      body,
      tags: Array.isArray(note.tags) ? note.tags.filter(tag => typeof tag === 'string') : [],
      pinned: note.pinned === true,
      ...(source === undefined ? {} : { source }),
      createdAt: Number(note.ts ?? 0),
      updatedAt: Number(note.updated ?? note.ts ?? 0),
      version: Number(note.version ?? 1),
      ...(note.deleted === true ? { deletedAt: Number(note.updated ?? note.ts ?? Date.now()) } : {}),
    }
  })
  const projects = doc.projects.map(project => ({
    id: project.id,
    name: text(project.name, '未命名项目'),
    createdAt: Number(project.createdAt ?? 0),
    updatedAt: Number(project.updatedAt ?? project.createdAt ?? 0),
    version: Number(project.version ?? 1),
  }))
  const priority = (value) => value === 'high' ? 1 : value === 'low' ? 3 : 2
  const tasks = doc.tasks.map(task => ({
    id: task.id,
    title: text(task.title, '未命名任务'),
    notes: text(task.description),
    projectId: typeof task.projectId === 'string' ? task.projectId : null,
    dueDate: civil(task.dueDate),
    assignee: task.assignee === 'agent' ? 'agent' : 'me',
    priority: priority(task.priority),
    completedAt: task.status === 'done' ? Number(task.completedAt ?? task.updatedAt ?? Date.now()) : null,
    noteIds: Array.isArray(task.noteIds) ? task.noteIds.filter(id => typeof id === 'string') : [],
    createdAt: Number(task.createdAt ?? 0),
    updatedAt: Number(task.updatedAt ?? task.createdAt ?? 0),
    version: Number(task.version ?? 1),
    ...(task.deletedAt === undefined ? {} : { deletedAt: Number(task.deletedAt) }),
  }))
  const events = doc.events.map(event => ({
    id: event.id,
    title: text(event.title, '未命名事件'),
    description: text(event.description),
    location: text(event.location),
    time: event.time,
    color: 'blue',
    createdAt: Number(event.createdAt ?? 0),
    updatedAt: Number(event.updatedAt ?? event.createdAt ?? 0),
    version: Number(event.version ?? 1),
    ...(event.deletedAt === undefined ? {} : { deletedAt: Number(event.deletedAt) }),
  }))
  return {
    notes: { schemaVersion: 1, notes },
    tasks: { schemaVersion: 1, projects, tasks },
    calendar: { schemaVersion: 1, events },
    counts: { notes: notes.length, tasks: tasks.length, projects: projects.length, events: events.length },
  }
}

/**
 * Transform one legacy info-hub inbox collection (plus its settings document)
 * into the new inbox document. The old `release` kind becomes `github`; status
 * sources become RSS-like sources because the new app has no status family.
 * @param {unknown[]} rows - the legacy `inbox` collection values.
 * @param {unknown} settings - the legacy settings document, when present.
 * @returns {{document: object, counts: object}}
 */
export function transformInfoHub(rows, settings) {
  if (!Array.isArray(rows)) throw new Error('info-hub inbox collection is not an array')
  const old = typeof settings === 'object' && settings !== null ? settings : {}
  const sources = []
  const sourceByKey = new Map()
  const ensureSource = (kind, id, name, url, config = {}, enabled = true, intervalMs = 0) => {
    const key = `${kind}:${id}`
    const existing = sourceByKey.get(key)
    if (existing !== undefined) {
      if (existing.name === existing.id && name !== '') existing.name = name
      if (existing.url === '' && url !== '') existing.url = url
      if (existing.intervalMs === 0 && intervalMs > 0) existing.intervalMs = intervalMs
      existing.config = { ...config, ...existing.config }
      return existing
    }
    const source = {
      id: key,
      kind,
      name: name || url || id,
      url,
      enabled,
      intervalMs,
      config,
      removed: false,
      failures: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      version: 1,
    }
    sourceByKey.set(key, source)
    sources.push(source)
    return source
  }
  for (const repo of Array.isArray(old.trackedRepos) ? old.trackedRepos : []) {
    if (typeof repo?.repo !== 'string') continue
    ensureSource('github', repo.repo, repo.repo, `https://github.com/${repo.repo}`, { repo: repo.repo }, repo.enabled !== false, Number(repo.intervalMs ?? 0))
  }
  for (const feed of Array.isArray(old.feeds) ? old.feeds : []) {
    if (typeof feed?.id !== 'string' || typeof feed.url !== 'string') continue
    ensureSource('rss', feed.id, feed.name || feed.url, feed.url, {}, feed.enabled !== false, Number(feed.intervalMs ?? 0))
  }
  for (const watch of Array.isArray(old.watches) ? old.watches : []) {
    if (typeof watch?.id !== 'string' || typeof watch.url !== 'string') continue
    ensureSource('web', watch.id, watch.name || watch.url, watch.url, {
      ...(typeof watch.selector === 'string' ? { selector: watch.selector } : {}),
    }, watch.enabled !== false, Number(watch.intervalMs ?? 0))
  }
  for (const status of Array.isArray(old.statuses) ? old.statuses : []) {
    if (typeof status?.id !== 'string' || typeof status.url !== 'string') continue
    ensureSource('rss', status.id, status.name || status.url, status.url, {}, status.enabled !== false, Number(status.intervalMs ?? 0))
  }
  const entries = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const kind = row.kind === 'release' ? 'github' : row.kind === 'web' ? 'web' : 'rss'
    const oldId = typeof row.sourceId === 'string' && row.sourceId !== '' ? row.sourceId : 'unknown'
    const source = ensureSource(kind, oldId, oldId, '', {})
    const published = typeof row.publishedAt === 'string' ? Date.parse(row.publishedAt) : Number.NaN
    const body = text(row.body)
    entries.push({
      id: text(row.key, `e_${createHash('sha256').update(`${kind}:${oldId}:${String(row.externalId ?? '')}`).digest('hex').slice(0, 24)}`),
      sourceId: source.id,
      sourceKind: kind,
      externalId: text(row.externalId, text(row.key, 'unknown')),
      url: text(row.url),
      title: text(row.title, text(row.key, '未命名条目')),
      summary: text(row.excerpt),
      content: body,
      ...(Number.isNaN(published) ? {} : { publishedAt: published }),
      fetchedAt: Number(row.addedAt ?? row.updatedAt ?? Date.now()),
      contentHash: createHash('sha256').update(body).digest('hex'),
      ...(row.read === true || Number(row.readAt) > 0 ? { readAt: Number(row.readAt) || Number(row.updatedAt) || 0 } : {}),
      ...(Number(row.seenAt) > 0 ? { seenAt: Number(row.seenAt) } : {}),
      favorite: row.favorited === true,
    })
  }
  return {
    document: {
      schemaVersion: 1,
      sources,
      entries,
      settings: { retentionDays: 90, maxEntries: 2000, maxBytes: 50 * 1024 * 1024, githubRefreshMs: 60 * 60_000, feedRefreshMs: 15 * 60_000, watchRefreshMs: 30 * 60_000 },
    },
    counts: { sources: sources.length, entries: entries.length },
  }
}

function documentOf(db, appId) {
  const row = db.prepare('SELECT value FROM app_documents WHERE app_id = ? AND scope = ?').get(appId, SCOPE)
  if (row === undefined) return undefined
  return JSON.parse(row.value)
}

function settingsOf(db) {
  const row = db.prepare('SELECT value FROM app_documents WHERE app_id = ? AND scope = ?').get('info-hub', 'settings')
  return row === undefined ? undefined : JSON.parse(row.value)
}

function hasDocument(db, appId) {
  return db.prepare('SELECT 1 AS ok FROM app_documents WHERE app_id = ? AND scope = ?').get(appId, SCOPE) !== undefined
}

function putDocument(db, appId, value, revision = 1) {
  const now = Date.now()
  db.prepare(`
    INSERT INTO app_documents (app_id, scope, schema_version, revision, value, updated_at)
    VALUES (?, ?, 1, ?, ?, ?)
    ON CONFLICT(app_id, scope) DO UPDATE SET
      schema_version = excluded.schema_version, revision = excluded.revision,
      value = excluded.value, updated_at = excluded.updated_at
  `).run(appId, SCOPE, revision, JSON.stringify(value), now)
}

/** Append records whose ids the existing document does not already carry. */
function appendMissing(existing, incoming, collection) {
  const old = Array.isArray(existing[collection]) ? existing[collection] : []
  const ids = new Set(old.map(record => record?.id).filter(id => typeof id === 'string'))
  const added = (Array.isArray(incoming[collection]) ? incoming[collection] : []).filter(record => typeof record?.id === 'string' && !ids.has(record.id))
  return { ...existing, [collection]: [...old, ...added] }
}

/** Fill missing source metadata on records an earlier migration already wrote. */
function repairSources(existing, incoming) {
  const byId = new Map((incoming.sources ?? []).map(source => [source.id, source]))
  const repaired = (existing.sources ?? []).map((source) => {
    const fresh = byId.get(source.id)
    if (fresh === undefined) return source
    return {
      ...source,
      ...(source.url === '' || source.url === undefined ? { url: fresh.url } : {}),
      ...(source.name === source.id || source.name === source.id.split(':').slice(1).join(':') || source.name === '' || source.name === undefined ? { name: fresh.name } : {}),
      ...(source.intervalMs === 0 ? { intervalMs: fresh.intervalMs } : {}),
      config: { ...fresh.config, ...source.config },
    }
  })
  return { ...existing, sources: repaired }
}

/** Merge legacy data into an existing document without replacing existing records. */
export function mergeDocument(appId, existing, incoming) {
  if (appId === 'inbox') {
    const repaired = repairSources(existing, incoming)
    const withSources = appendMissing(repaired, incoming, 'sources')
    return appendMissing(withSources, incoming, 'entries')
  }
  const collection = appId === 'calendar' ? 'events' : appId === 'notes' ? 'notes' : appId === 'tasks' ? 'tasks' : undefined
  if (collection === undefined) throw new Error(`migrate-apps: no merge strategy for ${appId}`)
  const merged = appendMissing(existing, incoming, collection)
  if (appId === 'tasks' && Array.isArray(incoming.projects) && Array.isArray(merged.projects)) {
    const ids = new Set(merged.projects.map(project => project?.id).filter(id => typeof id === 'string'))
    merged.projects = [...merged.projects, ...incoming.projects.filter(project => typeof project?.id === 'string' && !ids.has(project.id))]
  }
  return merged
}

function main() {
  const args = process.argv.slice(2)
  const dbIndex = args.indexOf('--db')
  const path = dbIndex >= 0 ? args[dbIndex + 1] : undefined
  if (path === undefined || path === '') {
    console.error('usage: node scripts/migrate-apps.mjs --db <app-data.sqlite> [--apply --yes]')
    process.exitCode = 2
    return
  }
  const apply = args.includes('--apply') && args.includes('--yes')
  const db = new DatabaseSync(path)
  try {
    const workbook = documentOf(db, 'workbook')
    const inboxRows = db.prepare('SELECT value FROM app_collections WHERE app_id = ? AND collection = ? ORDER BY seq').all('info-hub', 'inbox')
      .map((row) => JSON.parse(row.value))
    const inboxSettings = settingsOf(db)
    if (workbook === undefined && inboxRows.length === 0 && inboxSettings === undefined) {
      console.log('migrate-apps: no legacy workbook or info-hub data; nothing to migrate')
      return
    }
    const writes = []
    if (workbook !== undefined) {
      const migrated = transformWorkbook(workbook)
      console.log(`migrate-apps: workbook -> notes ${String(migrated.counts.notes)}, tasks ${String(migrated.counts.tasks)}, projects ${String(migrated.counts.projects)}, events ${String(migrated.counts.events)}`)
      writes.push(['notes', migrated.notes], ['tasks', migrated.tasks], ['calendar', migrated.calendar])
    }
    if (inboxRows.length > 0 || inboxSettings !== undefined) {
      const migrated = transformInfoHub(inboxRows, inboxSettings)
      console.log(`migrate-apps: info-hub -> inbox sources ${String(migrated.counts.sources)}, entries ${String(migrated.counts.entries)} (tokens are not copied; re-enter them in the new app)`)
      writes.push(['inbox', migrated.document])
    }
    if (!apply) {
      console.log('migrate-apps: dry run; pass --apply --yes to write')
      return
    }
    for (const [appId, value] of writes) {
      if (hasDocument(db, appId)) {
        const existing = documentOf(db, appId)
        const merged = mergeDocument(appId, existing, value)
        const before = JSON.stringify(existing)
        const after = JSON.stringify(merged)
        if (before === after) {
          console.log(`migrate-apps: ${appId} already contains every legacy record; unchanged`)
          continue
        }
        const revision = Number(db.prepare('SELECT revision FROM app_documents WHERE app_id = ? AND scope = ?').get(appId, SCOPE)?.revision ?? 1)
        putDocument(db, appId, merged, revision + 1)
        console.log(`migrate-apps: merged legacy records into ${appId}/document (existing records kept)`)
        continue
      }
      putDocument(db, appId, value)
      console.log(`migrate-apps: wrote ${appId}/document`)
    }
    console.log('migrate-apps: legacy data was not modified or deleted')
  } finally {
    db.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main()
