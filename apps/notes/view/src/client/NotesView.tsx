import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { EmptyState, ReadFailure, TabBar, failureKindOf, hasAppCode, isPermissionKind, outcomeMessage, outcomeValue, renderMarkdown, useConfirm, useUiChoice, useUiField, type FailureKind } from '@matrix1001/dsh-application-harness-client-chrome'
import { Button, FenceCodeBlock, Modal } from '@matrix1001/dsh-application-harness-client-chrome'
import { NS, type NotesKey } from './locales.ts'
import css from './NotesView.module.css'

/** The translate face this page needs: this package's locale seat. */
export type NotesTranslate = TranslateNS<'notes'>

/** The props of the registered page. */
export interface NotesPageProps extends ApplicationViewProps {
  locale: LocaleRuntime
}

/** The props of the page body. */
export interface NotesViewProps extends ApplicationViewProps {
  t: NotesTranslate
}

/** One attachment as the page renders it: metadata plus the byte-availability marker. */
interface AttachmentMeta {
  id: string
  name: string
  size: number
  type: string
  sha256: string
  missing?: boolean
}

interface NoteSummary {
  id: string
  title: string
  tags: string[]
  pinned: boolean
  updatedAt: number
  version: number
  deletedAt?: number
  attachments?: AttachmentMeta[]
}

interface Note extends NoteSummary { body: string }

type Scope = 'all' | 'favorites' | 'trash'
type EmptyKind = 'all' | 'search' | 'trash' | 'favorites'
type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'conflict'
/** How long typing settles before the page writes the draft. */
const AUTOSAVE_MS = 600

/** The status line each non-idle save state shows. */
const SAVE_LABELS: Record<Exclude<SaveState, 'idle'>, NotesKey> = {
  dirty: 'view.unsaved',
  saving: 'view.saving',
  saved: 'view.saved',
  error: 'view.saveFailed',
  conflict: 'view.conflictShort',
}

const SHORT_TIME = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' })
const MONTH_DAY = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' })
const YEAR_MONTH_DAY = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
const FULL_TIME = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
function tagsKey(tags: readonly string[]): string {
  return tags.join('\u0000')
}

function isDirty(draft: Note | undefined, saved: Note | undefined): boolean {
  if (draft === undefined || saved === undefined) return false
  return draft.body !== saved.body || draft.pinned !== saved.pinned || tagsKey(draft.tags) !== tagsKey(saved.tags)
}

function displayTitle(title: string, untitled: string): string {
  const value = title.trim().replace(/^#{1,6}\s+/u, '').trim()
  return value === '' ? untitled : value
}

function parseTags(value: string): string[] {
  // Chinese writers type the full-width comma (and sometimes the enumeration
  // comma); splitting only on ASCII kept those notes as one malformed tag.
  return value.split(/[,，、]/u).map(tag => tag.trim()).filter(tag => tag !== '')
}

function countWords(body: string): number {
  return [...body.replace(/\s/gu, '')].length
}

function formatNoteTime(timestamp: number, t: NotesTranslate): string {
  const now = new Date()
  const date = new Date(timestamp)
  if (date.toDateString() === now.toDateString()) return SHORT_TIME.format(date)
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return `${t('view.yesterday')} ${SHORT_TIME.format(date)}`
  if (date.getFullYear() === now.getFullYear()) return MONTH_DAY.format(date)
  return YEAR_MONTH_DAY.format(date)
}

function formatFullTime(timestamp: number): string {
  return FULL_TIME.format(new Date(timestamp))
}

/** Encode exact bytes as canonical base64 for the attachment operation. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Decode an attachment operation's canonical base64 back into exact bytes. */
function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

/** A compact, local-format byte size for the attachment row. */
function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${String(size)} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function emptyCopy(kind: EmptyKind, t: NotesTranslate): { title: string; hint: string } {
  switch (kind) {
    case 'search': return { title: t('view.emptySearch'), hint: t('view.emptySearchHint') }
    case 'trash': return { title: t('view.emptyTrash'), hint: t('view.emptyTrashHint') }
    case 'favorites': return { title: t('view.emptyFavorites'), hint: t('view.emptyFavoritesHint') }
    default: return { title: t('view.empty'), hint: t('view.emptyHint') }
  }
}

/** Render the small inline subset the preview understands. */
/** The registered page: bind the dictionary and render the notes body. */
export function NotesPage({ locale, ...props }: NotesPageProps) {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <NotesView {...props} t={locale.bind(NS)} />
}

/**
 * The notes page: rail + list + editor. The page speaks only through the
 * shell's `call` face, so a revoked storage grant or a stale version is
 * reported by the same operation path the agent uses.
 */
export function NotesView({ call, running, onChanged, pageContext, drafts, registerLeaveGuard, route, ui, openManagement, t }: NotesViewProps) {
  const [notes, setNotes] = useState<NoteSummary[]>([])
  const [selected, setSelected] = useUiField<string | undefined>(ui, 'selected', undefined, (value): value is string | undefined => value === undefined || typeof value === 'string')
  const [draft, setDraft] = useState<Note>()
  const [saved, setSaved] = useState<Note>()
  const [summary, setSummary] = useState<string>()
  const [summaryError, setSummaryError] = useState<string>()
  const [summaryErrorDetail, setSummaryErrorDetail] = useState<string>()
  const [summaryErrorPermission, setSummaryErrorPermission] = useState(false)
  const [summarizing, setSummarizing] = useState(false)
  const [scope, setScope] = useUiChoice<Scope>(ui, 'scope', ['all', 'favorites', 'trash'], 'all')
  const [tag, setTag] = useUiField<string | undefined>(ui, 'tag', undefined, (value): value is string | undefined => value === undefined || typeof value === 'string')
  const [query, setQuery] = useUiField<string>(ui, 'query', '', (value): value is string => typeof value === 'string')
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [readFailure, setReadFailure] = useState<{ readonly kind: FailureKind; readonly code?: string; readonly message?: string }>()
  const loadedRef = useRef(false)
  loadedRef.current = loaded
  const [searchResults, setSearchResults] = useState<NoteSummary[]>()
  const searchSeq = useRef(0)
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string>()
  const [saveErrorPermission, setSaveErrorPermission] = useState(false)
  const [conflict, setConflict] = useState<string>()
  const [copied, setCopied] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const { confirm: confirmLeave, dialog: confirmDialog } = useConfirm()
  // Removing an attachment deletes its bytes for good: confirm first, through
  // the same shared layer the leave guard uses.
  const { confirm: confirmAttachmentDelete, dialog: attachmentConfirmDialog } = useConfirm()
  const [preview, setPreview] = useState(true)
  const [detailOpen, setDetailOpen] = useUiField<boolean>(ui, 'detailOpen', false, (value): value is boolean => typeof value === 'boolean')
  const [shared, setShared] = useState(false)
  const [shareError, setShareError] = useState<string>()
  const [attachmentBusy, setAttachmentBusy] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [tagEditing, setTagEditing] = useState(false)
  const [tagText, setTagText] = useState('')
  const importRef = useRef<HTMLInputElement>(null)
  const attachmentRef = useRef<HTMLInputElement>(null)
  const sourceRef = useRef<HTMLTextAreaElement>(null)
  const focusNewRef = useRef(false)
  const savingRef = useRef(false)
  const saveInFlightRef = useRef<Promise<boolean>>()
  const newNoteIdRef = useRef<string>()
  const tRef = useRef(t)
  tRef.current = t
  const draftRef = useRef<Note>()
  draftRef.current = draft
  const revisionRef = useRef(0)
  const savedRef = useRef<Note>()
  savedRef.current = saved
  const pageContextRef = useRef(pageContext)
  pageContextRef.current = pageContext

  // Draft sharing is per open note: a different note starts unshared and with
  // a fresh revision, so an old grant can never address the new draft.
  useEffect(() => {
    revisionRef.current += 1
    setShared(false)
    setShareError(undefined)
    setTagEditing(false)
  }, [draft?.id])

  useEffect(() => {
    if (drafts === undefined) return
    const offRead = drafts.onRead((input) => {
      const current = draftRef.current
      if (current === undefined || current.id !== input.draftId) throw new Error('the draft is no longer open')
      const all: Record<string, unknown> = { '/body': current.body, '/tags': current.tags }
      const values = Object.fromEntries(Object.entries(all).filter(([field]) => input.fields === undefined || input.fields.includes(field)))
      return { revision: String(revisionRef.current), values: values as never }
    })
    const offUpdate = drafts.onUpdate((input) => {
      const current = draftRef.current
      if (current === undefined || current.id !== input.draftId) return { conflict: true }
      if (input.revision !== String(revisionRef.current)) return { conflict: true }
      const values = input.values as Record<string, unknown>
      const body = typeof values['/body'] === 'string' ? values['/body'] : undefined
      const tags = Array.isArray(values['/tags'])
        ? values['/tags'].filter((tag): tag is string => typeof tag === 'string')
        : undefined
      setDraft((previous) => previous === undefined ? previous : {
        ...previous,
        ...(body === undefined ? {} : { body }),
        ...(tags === undefined ? {} : { tags }),
      })
      revisionRef.current += 1
      return {
        revision: String(revisionRef.current),
        values: {
          ...(body === undefined ? {} : { '/body': body }),
          ...(tags === undefined ? {} : { '/tags': tags }),
        } as never,
      }
    })
    return () => { offRead(); offUpdate() }
  }, [drafts])

  const load = useCallback(async () => {
    setLoading(true)
    const outcome = await call('list', { includeDeleted: true })
    setLoading(false)
    const list = outcomeValue<NoteSummary[]>(outcome)
    if (list === undefined) {
      const kind = failureKindOf(outcome)
      const failed = outcome !== undefined && outcome.status !== 'success' && outcome.status !== 'cancelled'
      const code = failed ? outcome.error?.code : undefined
      const message = failed ? outcome.error?.message : undefined
      // A first read that could not answer is a READ FAILURE, not an empty
      // list: the page says so and offers the permission/re-read action itself.
      // A later refresh keeps the notes already read and marks the refresh.
      if (loadedRef.current) { setLoadError(tRef.current('view.loadFailed')); return }
      setReadFailure({
        kind,
        ...(code === undefined ? {} : { code }),
        ...(message === undefined ? {} : { message }),
      })
      setLoadError(undefined)
      return
    }
    setNotes(list)
    setLoaded(true)
    setLoadError(undefined)
    setReadFailure(undefined)
  }, [call])

  useEffect(() => { void load() }, [load])
  useEffect(() => onChanged(() => { void load() }), [onChanged, load])

  useEffect(() => {
    const needle = query.trim()
    if (needle === '') { setSearchResults(undefined); return undefined }
    const seq = ++searchSeq.current
    const timer = window.setTimeout(() => {
      void (async () => {
        // The trash scope reaches soft-deleted notes; every other scope asks
        // for the live set only, exactly like the list's own default.
        const outcome = await call('search', { query: needle, ...(scope === 'trash' ? { includeDeleted: true } : {}) })
        /* v8 ignore next -- a newer query owns the result; the guard is a race, not a branch a test can time */
        if (seq !== searchSeq.current) return
        const list = outcomeValue<unknown>(outcome)
        if (Array.isArray(list)) setSearchResults(list.filter((item): item is NoteSummary => typeof item === 'object' && item !== null && typeof (item as { id?: unknown }).id === 'string'))
      })()
    }, 250)
    return () => { window.clearTimeout(timer) }
  }, [call, notes, query, scope])

  const openNote = useCallback(async (id: string) => {
    const outcome = await call('get', { id })
    const note = outcomeValue<Note>(outcome)
    if (note === undefined) {
      setError(outcomeMessage(outcome) ?? tRef.current('view.loadFailed'))
      setDraft(undefined)
      setSaved(undefined)
      setDetailOpen(false)
      return
    }
    setDraft(note)
    setSaved(note)
    // A just-created note stays in source mode no matter which of the two
    // effects (create or selected→openNote) settles last.
    setPreview(newNoteIdRef.current !== note.id)
    setError(undefined)
    setSaveError(undefined)
    setConflict(undefined)
    // Summaries, attachment failures and the "copied" flag belong to the note
    // that produced them; leaving them up made A's results look like B's.
    setSummary(undefined)
    setSummaryError(undefined)
    setSummaryErrorDetail(undefined)
    setSummaryErrorPermission(false)
    setAttachmentError(undefined)
    setCopied(false)
  }, [call])

  useEffect(() => {
    if (!focusNewRef.current || preview) return undefined
    focusNewRef.current = false
    sourceRef.current?.focus()
    // An onboarding/leave dialog can finish closing just after the editor
    // mounts and drop focus to the body; put the caret back once, without
    // stealing it from a control the human actually selected.
    const timer = window.setTimeout(() => {
      if (document.activeElement === document.body) sourceRef.current?.focus()
    }, 150)
    // A page mount can settle a second time after a slow route/transition; one
    // late retry avoids leaving a brand-new draft unfocused on the body.
    const late = window.setTimeout(() => {
      if (document.activeElement === document.body) sourceRef.current?.focus()
    }, 450)
    return () => { window.clearTimeout(timer); window.clearTimeout(late) }
  }, [draft?.id, preview])

  useEffect(() => {
    if (selected === undefined) { setDraft(undefined); setSaved(undefined); return }
    void openNote(selected)
  }, [selected, openNote])

  useEffect(() => {
    if (draft === undefined) {
      pageContextRef.current.report({ label: tRef.current('app.name') })
      return undefined
    }
    return pageContextRef.current.report({
      label: draft.title,
      record: { appId: 'notes', kind: 'note', id: draft.id },
      view: 'editor',
      draftId: draft.id,
      dirty: isDirty(draft, saved),
    })
  }, [draft, saved])

  const dirty = isDirty(draft, saved)

  const summarize = async (): Promise<void> => {
    if (saved === undefined || dirty || summarizing) return
    setSummarizing(true)
    setSummaryError(undefined)
    setSummaryErrorDetail(undefined)
    setSummaryErrorPermission(false)
    const outcome = await call('summarize', { id: saved.id })
    setSummarizing(false)
    if (outcome.status === 'success') {
      setSummary((outcome.result as { summary: string }).summary)
      return
    }
    if (isPermissionKind(failureKindOf(outcome))) {
      setSummaryError(t('view.summaryNoPermission'))
      setSummaryErrorPermission(true)
      return
    }
    // A model or vendor failure carries the host's raw diagnostic (masked key,
    // request id, provider wording): localize the visible headline and keep the
    // message behind a disclosure instead of painting it as the page's copy.
    const message = outcomeMessage(outcome)
    setSummaryError(message === undefined ? t('view.summaryFailed') : t('view.summaryModelFailed'))
    setSummaryErrorDetail(message)
  }

  useEffect(() => {
    if (registerLeaveGuard === undefined) return undefined
    return registerLeaveGuard(() => !dirty || confirmLeave({
      title: t('view.leaveUnsaved'),
      body: t('view.leaveBody'),
      confirmLabel: t('view.leaveConfirm'),
      cancelLabel: t('view.leaveStay'),
      danger: true,
    }))
  }, [confirmLeave, dirty, registerLeaveGuard, t])

  const tagCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const note of notes) {
      if (note.deletedAt !== undefined) continue
      for (const value of note.tags) counts.set(value, (counts.get(value) ?? 0) + 1)
    }
    return [...counts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
  }, [notes])

  const counts = useMemo(() => ({
    all: notes.filter(note => note.deletedAt === undefined).length,
    favorites: notes.filter(note => note.deletedAt === undefined && note.pinned).length,
    trash: notes.filter(note => note.deletedAt !== undefined).length,
  }), [notes])

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase()
    const base = query.trim() === ''
      ? notes
      : (searchResults ?? notes.filter(note => `${note.title}\n${note.tags.join(' ')}`.toLocaleLowerCase().includes(needle)))
    return base.filter(note => {
      if (scope === 'trash' ? note.deletedAt === undefined : note.deletedAt !== undefined) return false
      if (scope === 'favorites' && !note.pinned) return false
      if (tag !== undefined && !note.tags.includes(tag)) return false
      return true
    })
  }, [notes, query, searchResults, scope, tag])

  // A scope/tag change (or a deletion) must not leave the editor on a note the
  // active view no longer contains. A plain search does not move the editor:
  // filtering the list is not a reason to throw away an open draft.
  useEffect(() => {
    if (!loaded) return
    const current = selected === undefined ? undefined : notes.find(note => note.id === selected)
    const inScope = current !== undefined
      && (scope === 'trash' ? current.deletedAt !== undefined : current.deletedAt === undefined)
      && (scope !== 'favorites' || current.pinned)
      && (tag === undefined || current.tags.includes(tag))
    if (inScope) return
    setSelected(visible[0]?.id)
  }, [loaded, notes, scope, tag, selected, visible])

  const persist = useCallback(async (): Promise<boolean> => {
    const current = draftRef.current
    const base = savedRef.current
    /* v8 ignore next -- the save controls exist only for an open, live draft */
    if (current === undefined || base === undefined || current.deletedAt !== undefined) return true
    /* v8 ignore next -- clean drafts need no write; the debounce never fires for them */
    if (!isDirty(current, base)) return true
    // A save already in flight owns the write; switching may wait for it but
    // must not start a second write with the same expected version.
    if (savingRef.current) return saveInFlightRef.current ?? true
    savingRef.current = true
    setSaving(true)
    setSaveError(undefined)
    setSaveErrorPermission(false)
    const snapshot = current
    const run = (async (): Promise<boolean> => {
      const outcome = await call('update', {
        id: current.id,
        expectedVersion: base.version,
        body: current.body,
        tags: current.tags,
        pinned: current.pinned,
      })
      const note = outcomeValue<Note>(outcome)
      if (note === undefined) {
        if (hasAppCode(outcome, 'stale-version')) setConflict(tRef.current('view.conflict'))
        else if (isPermissionKind(failureKindOf(outcome))) {
          setSaveError(tRef.current('view.saveNoPermission'))
          setSaveErrorPermission(true)
        } else setSaveError(outcomeMessage(outcome) ?? tRef.current('view.saveFailed'))
        return false
      }
      setSaved(note)
      setError(undefined)
      setSaveError(undefined)
      setConflict(undefined)
      if (draftRef.current === snapshot) setDraft(note)
      await load()
      return true
    })()
    saveInFlightRef.current = run
    try {
      return await run
    } finally {
      if (saveInFlightRef.current === run) saveInFlightRef.current = undefined
      savingRef.current = false
      setSaving(false)
    }
  }, [call, load])

  useEffect(() => {
    if (draft === undefined || saved === undefined || draft.deletedAt !== undefined || conflict !== undefined) return undefined
    if (!isDirty(draft, saved)) return undefined
    const timer = setTimeout(() => { void persist() }, AUTOSAVE_MS)
    return () => { clearTimeout(timer) }
  }, [draft, saved, conflict, persist])

  useEffect(() => {
    const target = route?.record
    if (route?.appId !== 'notes' || target?.kind !== 'note') return
    void (async () => {
      // A navigation from another page is also a leave of the current draft.
      if (!(await persist())) return
      setScope('all')
      setTag(undefined)
      setQuery('')
      newNoteIdRef.current = undefined
      setSelected(target.id)
      setDetailOpen(true)
    })()
  }, [persist, route])

  const selectNote = useCallback(async (id: string) => {
    // Switching away is a leave: if the current draft cannot be saved, keep the
    // user here with the failure visible instead of silently discarding it.
    if (!(await persist())) return
    newNoteIdRef.current = undefined
    setSelected(id)
    setDetailOpen(true)
  }, [persist, setDetailOpen, setSelected])

  const chooseScope = useCallback((next: Scope) => {
    if (dirty) void persist()
    setScope(next)
    setTag(undefined)
    setDetailOpen(false)
  }, [dirty, persist, setDetailOpen, setScope, setTag])

  const chooseTag = useCallback((name: string) => {
    if (dirty) void persist()
    setTag(tag === name ? undefined : name)
    setScope('all')
    setDetailOpen(false)
  }, [dirty, persist, setDetailOpen, setScope, setTag, tag])

  const changeBody = useCallback((body: string) => {
    setDraft(current => current === undefined ? current : { ...current, body })
    setSaveError(undefined)
  }, [])

  const changeTags = useCallback((value: string) => {
    setDraft(current => current === undefined ? current : { ...current, tags: parseTags(value) })
    setSaveError(undefined)
  }, [])

  const removeTag = useCallback((name: string) => {
    setDraft(current => current === undefined ? current : { ...current, tags: current.tags.filter(value => value !== name) })
    setSaveError(undefined)
  }, [])

  const create = useCallback(async () => {
    if (!(await persist())) return
    const outcome = await call('create', { body: tRef.current('view.newBody'), tags: [] })
    const note = outcomeValue<Note>(outcome)
    if (note === undefined) { setError(outcomeMessage(outcome) ?? tRef.current('view.saveFailed')); return }
    newNoteIdRef.current = note.id
    focusNewRef.current = true
    setScope('all')
    setTag(undefined)
    setQuery('')
    await load()
    setSelected(note.id)
    setDraft(note)
    setSaved(note)
    setError(undefined)
    setSaveError(undefined)
    setConflict(undefined)
    setPreview(false)
    setDetailOpen(true)
  }, [call, load, persist])

  const remove = useCallback(async () => {
    /* v8 ignore next -- delete is rendered only beside an open draft */
    if (draft === undefined) return
    setDeleteBusy(true)
    const outcome = await call('delete', { id: draft.id })
    setDeleteBusy(false)
    setDeleteOpen(false)
    if (outcome.status !== 'success') { setError(outcomeMessage(outcome) ?? tRef.current('view.saveFailed')); return }
    setSelected(undefined)
    setDraft(undefined)
    setSaved(undefined)
    setConflict(undefined)
    setDetailOpen(false)
    await load()
  }, [call, draft, load])

  const restore = useCallback(async () => {
    /* v8 ignore next -- restore is rendered only beside a trashed draft */
    if (draft === undefined) return
    const outcome = await call('restore', { id: draft.id })
    const note = outcomeValue<Note>(outcome)
    if (note === undefined) { setError(outcomeMessage(outcome) ?? tRef.current('view.saveFailed')); return }
    setDraft(note)
    setSaved(note)
    setError(undefined)
    setSaveError(undefined)
    setConflict(undefined)
    setScope('all')
    setTag(undefined)
    await load()
    setSelected(note.id)
    setDetailOpen(true)
  }, [call, draft, load])

  const exportAll = useCallback(async () => {
    const outcome = await call('exportNotes', {})
    const value = outcomeValue<{ json: string; warnings?: string[] }>(outcome)
    if (value === undefined) { setError(outcomeMessage(outcome) ?? tRef.current('view.saveFailed')); return }
    setError(undefined)
    const warnings = value.warnings ?? []
    setNotice(warnings.length === 0 ? undefined : tRef.current('view.exportWarnings', { count: warnings.length }))
    const url = URL.createObjectURL(new Blob([value.json], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = 'notes.json'
    anchor.click()
    URL.revokeObjectURL(url)
  }, [call])

  const importFile = useCallback(async (file: File) => {
    const json = await file.text()
    const outcome = await call('importNotes', { json, mode: 'merge' })
    const value = outcomeValue<{ imported: number; attachments?: { written: number; missing: number } }>(outcome)
    if (value === undefined) { setError(outcomeMessage(outcome) ?? tRef.current('view.saveFailed')); return }
    setError(undefined)
    setNotice(tRef.current('view.importSummary', {
      imported: value.imported,
      written: value.attachments?.written ?? 0,
      missing: value.attachments?.missing ?? 0,
    }))
    await load()
  }, [call, load])

  // Attachment operations keep the open draft's unsaved text: only the note's
  // attachment metadata and version come from the server answer.
  const applyAttachmentNote = useCallback((note: Note) => {
    const attachments = note.attachments ?? []
    setDraft(current => current === undefined ? current : { ...current, attachments, version: note.version, updatedAt: note.updatedAt })
    setSaved(current => current === undefined ? current : { ...current, attachments, version: note.version, updatedAt: note.updatedAt })
  }, [])

  const uploadAttachment = useCallback(async (noteId: string, file: File) => {
    setAttachmentBusy(true)
    setAttachmentError(undefined)
    setNotice(undefined)
    try {
      const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()))
      const outcome = await call('uploadAttachment', { noteId, name: file.name, type: file.type, dataBase64 })
      const value = outcomeValue<{ note: Note }>(outcome)
      if (value === undefined) { setAttachmentError(outcomeMessage(outcome) ?? tRef.current('view.attachmentFailed')); return }
      applyAttachmentNote(value.note)
      await load()
    } catch {
      setAttachmentError(tRef.current('view.attachmentFailed'))
    } finally {
      setAttachmentBusy(false)
    }
  }, [applyAttachmentNote, call, load])

  const downloadAttachment = useCallback(async (noteId: string, attachment: AttachmentMeta) => {
    setAttachmentError(undefined)
    setNotice(undefined)
    const outcome = await call('downloadAttachment', { noteId, attachmentId: attachment.id })
    const value = outcomeValue<AttachmentMeta & { missing: boolean; dataBase64?: string }>(outcome)
    if (value === undefined) { setAttachmentError(outcomeMessage(outcome) ?? tRef.current('view.attachmentFailed')); return }
    if (value.missing || value.dataBase64 === undefined) {
      setAttachmentError(tRef.current('view.attachmentMissing'))
      await load()
      return
    }
    const bytes = base64ToBytes(value.dataBase64)
    const url = URL.createObjectURL(new Blob([bytes], { type: value.type }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = value.name
    anchor.click()
    URL.revokeObjectURL(url)
  }, [call, load])

  const deleteAttachment = useCallback(async (noteId: string, attachment: AttachmentMeta) => {
    const confirmed = await confirmAttachmentDelete({
      title: tRef.current('view.deleteAttachmentTitle'),
      body: tRef.current('view.deleteAttachmentBody', { name: attachment.name }),
      confirmLabel: tRef.current('view.delete'),
      cancelLabel: tRef.current('view.cancel'),
      danger: true,
    })
    if (!confirmed) return
    setAttachmentBusy(true)
    setAttachmentError(undefined)
    setNotice(undefined)
    const outcome = await call('deleteAttachment', { noteId, attachmentId: attachment.id })
    setAttachmentBusy(false)
    const value = outcomeValue<{ note: Note }>(outcome)
    if (value === undefined) { setAttachmentError(outcomeMessage(outcome) ?? tRef.current('view.attachmentFailed')); return }
    applyAttachmentNote(value.note)
    await load()
  }, [applyAttachmentNote, call, confirmAttachmentDelete, load])

  const saveState: SaveState = conflict !== undefined
    ? 'conflict'
    : saving
      ? 'saving'
      : saveError !== undefined
        ? 'error'
        : dirty
          ? 'dirty'
          : saved !== undefined
            ? 'saved'
            : 'idle'
  const saveLabel = saveState === 'idle' ? '' : t(SAVE_LABELS[saveState])
  const listTitle = query.trim() !== ''
    ? t('view.searchResults')
    : tag !== undefined
      ? `#${tag}`
      : scope === 'trash'
        ? t('view.trash')
        : scope === 'favorites'
          ? t('view.pinned')
          : t('view.allNotes')
  const emptyKind: EmptyKind = query.trim() !== ''
    ? 'search'
    : scope === 'trash'
      ? 'trash'
      : scope === 'favorites'
        ? 'favorites'
        : 'all'
  const copy = emptyCopy(emptyKind, t)
  const deleted = draft?.deletedAt !== undefined
  const attachments = draft?.attachments ?? []

  return (
    <div className={`${css.page} ${detailOpen ? css.showDetail : ''}`} data-notes-page data-notes-scope={scope} data-notes-mobile-pane={detailOpen ? 'detail' : 'list'}>
      <TabBar
        data-notes-tabs
        tabs={[
          { id: 'all', label: t('view.all'), anchor: { 'data-notes-tab': 'all', 'data-notes-scope': 'all' }, suffix: <span className={css.tabCount} data-notes-tab-count="all">{readFailure === undefined ? counts.all : '—'}</span> },
          { id: 'favorites', label: t('view.pinned'), anchor: { 'data-notes-tab': 'favorites', 'data-notes-scope': 'favorites' }, suffix: <span className={css.tabCount} data-notes-tab-count="favorites">{readFailure === undefined ? counts.favorites : '—'}</span> },
          { id: 'trash', label: t('view.trash'), anchor: { 'data-notes-tab': 'trash', 'data-notes-scope': 'trash' }, suffix: <span className={css.tabCount} data-notes-tab-count="trash">{readFailure === undefined ? counts.trash : '—'}</span> },
        ]}
        active={scope}
        onSelect={id => { chooseScope(id as Scope) }}
        tools={(
          <>
            <input
              type="search"
              className={css.search}
              value={query}
              onChange={event => { setQuery(event.target.value) }}
              placeholder={t('view.search')}
              aria-label={t('view.search')}
              data-notes-search
            />
            <button type="button" className={css.toolButton} onClick={() => { importRef.current?.click() }} disabled={running} data-notes-import>{t('view.import')}</button>
            <button type="button" className={`${css.toolButton} ${css.hideNarrow}`} onClick={() => { void exportAll() }} disabled={running} data-notes-export>{t('view.export')}</button>
            <button type="button" className={`${css.toolButton} ${css.primary}`} onClick={() => { void create() }} disabled={running} data-notes-new>{t('view.newNote')}</button>
          </>
        )}
      />
      {error === undefined ? null : <div className={css.notice} role="alert" data-notes-error>{error}</div>}
      {notice === undefined ? null : <div className={css.notice} role="status" data-notes-notice>{notice}</div>}
      <div className={css.workspace}>
        <aside className={css.rail} data-notes-rail>
          <div className={css.railLabel}>{t('view.tagsLabel')}</div>
          <div className={css.tagList}>
            {tagCounts.length === 0
              ? <span className={css.tagEmpty} data-notes-tags-empty>{t('view.noTags')}</span>
              : tagCounts.map(item => (
                <button
                  key={item.name}
                  type="button"
                  className={`${css.tagRow} ${tag === item.name ? css.tagActive : ''}`}
                  onClick={() => { chooseTag(item.name) }}
                  data-notes-tag={item.name}
                  data-notes-tag-count={item.count}
                >
                  <span className={css.hash}>#</span><span className={css.tagName}>{item.name}</span><b className={css.tagCount}>{item.count}</b>
                </button>
              ))}
          </div>
          <div className={css.railFooter}>{t('view.localOnly')}</div>
        </aside>
        <section className={css.listPane} data-notes-list>
          <header className={css.listHead}>
            <div>
              <h2 className={css.listTitle} data-notes-list-title>{listTitle}</h2>
              <span className={css.listSub} data-notes-list-count>{readFailure === undefined ? t('view.listSummary', { count: visible.length }) : t('view.notReadSummary')}</span>
            </div>
          </header>
          {loadError !== undefined && loaded ? <div className={css.inlineError} data-notes-load-error>{loadError}</div> : null}
          <div className={css.noteList}>
            {readFailure !== undefined
              ? (readFailure.kind === 'not-approved' || readFailure.kind === 'undeclared')
                ? (
                  <EmptyState
                    title={readFailure.kind === 'undeclared' ? t('view.notReadUndeclaredTitle') : t('view.notReadTitle')}
                    body={readFailure.kind === 'undeclared' ? t('view.notReadUndeclaredBody') : t('view.notReadBody')}
                    data-notes-read-failure={readFailure.kind}
                  />
                )
                : (
                  <ReadFailure
                    kind={readFailure.kind}
                    title={t('view.loadFailed')}
                    detailLabel={t('view.diagnostic')}
                    {...(readFailure.code === undefined ? {} : { code: readFailure.code })}
                    {...(readFailure.message === undefined ? {} : { message: readFailure.message })}
                    data-notes-read-failure={readFailure.kind}
                    retry={<button type="button" className={css.toolButton} onClick={() => { void load() }} data-notes-retry>{t('view.retry')}</button>}
                  />
                )
              : loading && !loaded
                ? <div className={css.state} data-notes-loading>{t('view.loading')}</div>
                : loadError !== undefined && !loaded
                  ? (
                    <div className={css.state} data-notes-load-error>
                      <span>{loadError}</span>
                      <button type="button" className={css.toolButton} onClick={() => { void load() }} data-notes-retry>{t('view.retry')}</button>
                    </div>
                  )
                  : visible.length === 0
                    ? <EmptyState title={copy.title} body={copy.hint} data-notes-empty={emptyKind} />
                    : visible.map(note => (
                    <button
                      key={note.id}
                      type="button"
                      className={`${css.noteRow} ${note.id === selected ? css.noteActive : ''}`}
                      onClick={() => { selectNote(note.id) }}
                      data-notes-note={note.id}
                      data-notes-pinned={note.pinned ? 'true' : 'false'}
                      data-notes-deleted={note.deletedAt !== undefined ? 'true' : 'false'}
                    >
                      <span className={css.rowTop}>
                        <span className={css.rowTitle}>{displayTitle(note.title, t('view.untitled'))}</span>
                        {note.pinned ? <span className={css.pinBadge}>{t('view.pinnedBadge')}</span> : null}
                      </span>
                      <span className={css.rowMeta}>
                        {note.tags.slice(0, 3).map(value => <span key={value} className={css.tag}>{value}</span>)}
                        {note.deletedAt !== undefined ? <span className={css.trashBadge}>{t('view.trash')}</span> : null}
                        <span className={css.rowTime} data-notes-time>{formatNoteTime(note.updatedAt, t)}</span>
                      </span>
                    </button>
                  ))}
          </div>
        </section>
        <section className={css.editor} data-notes-editor data-notes-note-id={draft?.id} data-notes-mode={preview ? 'preview' : 'source'}>
          {draft === undefined
            ? <EmptyState title={t('view.select')} body={t('view.selectHint')} data-notes-select />
            : (
              <>
                <header className={css.editorHead}>
                  <button type="button" className={css.back} onClick={() => { setDetailOpen(false) }} aria-label={t('view.backToList')} data-notes-back>←</button>
                  <div className={css.chips} data-notes-editor-tags>
                    {draft.tags.map(name => (
                      <span key={name} className={css.chip} data-notes-tag-chip={name}>
                        {name}
                        {deleted
                          ? null
                          : <button type="button" className={css.chipRemove} aria-label={t('view.removeTag', { tag: name })} onClick={() => { removeTag(name) }} data-notes-remove-tag={name}>×</button>}
                      </span>
                    ))}
                  </div>
                  <span className={css.saveState} data-notes-save-state={saveState} aria-live="polite">
                    <i className={css.saveDot} data-tone={saveState} aria-hidden="true" />
                    {saveLabel}
                  </span>
                  <time className={css.updated} data-notes-updated dateTime={new Date(draft.updatedAt).toISOString()}>{t('view.updatedAt', { time: formatFullTime(draft.updatedAt) })}</time>
                  <div className={css.editorActions}>
                    {deleted
                      ? null
                      : <button type="button" className={css.iconButton} onClick={() => { void summarize() }} disabled={running || dirty || summarizing} data-notes-summarize>{summarizing ? t('view.summarizing') : t('view.summarize')}</button>}
                    <button type="button" className={css.iconButton} onClick={() => { newNoteIdRef.current = undefined; setPreview(value => !value) }} data-notes-toggle-mode>{preview ? t('view.edit') : t('view.preview')}</button>
                    {deleted
                      ? null
                      : (
                        <button
                          type="button"
                          className={css.iconButton}
                          onClick={() => {
                            setDraft(current => current === undefined ? current : { ...current, pinned: !current.pinned })
                            setSaveError(undefined)
                          }}
                          data-notes-pin
                        >
                          {draft.pinned ? t('view.unpin') : t('view.pin')}
                        </button>
                      )}
                    {deleted
                      ? <button type="button" className={css.iconButton} onClick={() => { void restore() }} disabled={running} data-notes-restore>{t('view.restore')}</button>
                      : <button type="button" className={`${css.iconButton} ${css.dangerText}`} onClick={() => { setDeleteOpen(true) }} disabled={running} data-notes-delete>{t('view.delete')}</button>}
                  </div>
                </header>
                {conflict === undefined
                  ? null
                  : (
                    <div className={css.conflict} role="alert" data-notes-conflict>
                      <span>{conflict}</span>
                      <button type="button" className={css.toolButton} onClick={() => { void navigator.clipboard?.writeText(draft.body).then(() => { setCopied(true) }).catch(() => {}) }} data-notes-copy-draft>{copied ? t('view.copied') : t('view.copyDraft')}</button>
                      <button type="button" className={css.toolButton} onClick={() => { void openNote(draft.id) }} data-notes-reload>{t('view.reload')}</button>
                    </div>
                  )}
                {saveError === undefined ? null : (
                  <div className={css.inlineError} role="alert" data-notes-save-error>
                    {saveError}
                    {saveErrorPermission && (
                      <button type="button" className={css.linkButton} data-notes-save-manage onClick={() => { openManagement('permissions') }}>
                        {t('view.managePermissions')}
                      </button>
                    )}
                  </div>
                )}
                {summaryError === undefined ? null : (
                  <div className={css.inlineError} role="alert" data-notes-summary-error>
                    {summaryError}
                    {summaryErrorPermission && (
                      <button type="button" className={css.linkButton} data-notes-summary-manage onClick={() => { openManagement('permissions') }}>
                        {t('view.managePermissions')}
                      </button>
                    )}
                    {summaryErrorDetail === undefined ? null : (
                      <details className={css.summaryDiagnostic} data-notes-summary-detail>
                        <summary>{t('view.diagnostic')}</summary>
                        <p>{summaryErrorDetail}</p>
                      </details>
                    )}
                  </div>
                )}
                {summary === undefined ? null : (
                  <section className={css.summary} data-notes-summary>
                    <header className={css.summaryHead}><strong>{t('view.summary')}</strong><button type="button" className={css.toolButton} onClick={() => { setSummary(undefined) }} data-notes-summary-close>{t('view.close')}</button></header>
                    <p>{summary}</p>
                  </section>
                )}
                {shareError === undefined ? null : <div className={css.inlineError} role="alert" data-notes-share-error>{shareError}</div>}
                <div className={css.docScroll}>
                  {preview
                    ? (
                      <article className={css.doc} data-notes-preview>
                        {draft.body.trim() === ''
                          ? <p className={css.docEmpty} data-notes-empty-body>{t('view.noContent')}</p>
                          : renderMarkdown(draft.body, {
                            externalLinks: true,
                            renderCodeBlock: block => (
                              <FenceCodeBlock lang={block.lang} code={block.code} streaming={false} labels={{ copyLabel: t('markdown.copy'), copiedLabel: t('markdown.copied') }} />
                            ),
                          })}
                      </article>
                    )
                    : (
                      <textarea
                        ref={sourceRef}
                        className={css.source}
                        value={draft.body}
                        onChange={event => { changeBody(event.target.value) }}
                        aria-label={t('view.body')}
                        data-notes-source
                        spellCheck={false}
                        disabled={deleted}
                      />
                    )}
                </div>
                {deleted ? <div className={css.trashNotice} data-notes-trash-notice>{t('view.trashNotice')}</div> : null}
                <section className={css.attachments} data-notes-attachments data-notes-attachment-count={attachments.length} data-empty={attachments.length === 0 ? 'true' : 'false'}>
                  <div className={css.attachmentsHead}>
                    <span className={css.attachmentsTitle}>{t('view.attachments')}</span>
                    {attachments.length === 0 ? <span className={css.attachmentsEmpty} data-notes-attachment-empty>{t('view.attachmentEmpty')}</span> : null}
                    <span className={css.spacer} />
                    {deleted
                      ? null
                      : (
                        <button type="button" className={css.toolButton} disabled={running || attachmentBusy} onClick={() => { attachmentRef.current?.click() }} data-notes-attachment-upload>
                          {t('view.attachFile')}
                        </button>
                      )}
                  </div>
                  {attachmentError === undefined ? null : <div className={css.inlineError} role="alert" data-notes-attachment-error>{attachmentError}</div>}
                  {attachments.length === 0
                    ? null
                    : (
                      <ul className={css.attachmentList}>
                        {attachments.map(attachment => (
                          <li
                            key={attachment.id}
                            className={css.attachmentRow}
                            data-notes-attachment={attachment.id}
                            data-notes-attachment-missing={attachment.missing === true ? 'true' : 'false'}
                          >
                            <span className={css.attachmentName} data-notes-attachment-name>{attachment.name}</span>
                            <span className={css.attachmentSize} data-notes-attachment-size>{formatAttachmentSize(attachment.size)}</span>
                            {attachment.missing === true ? <span className={css.attachmentMissing} data-notes-attachment-missing-badge>{t('view.attachmentMissing')}</span> : null}
                            <span className={css.spacer} />
                            <button
                              type="button"
                              className={css.toolButton}
                              disabled={running || attachmentBusy || attachment.missing === true}
                              onClick={() => { void downloadAttachment(draft.id, attachment) }}
                              data-notes-attachment-download
                            >
                              {t('view.download')}
                            </button>
                            {deleted
                              ? null
                              : (
                                <button
                                  type="button"
                                  className={`${css.toolButton} ${css.dangerText}`}
                                  disabled={running || attachmentBusy}
                                  onClick={() => { void deleteAttachment(draft.id, attachment) }}
                                  data-notes-attachment-delete
                                >
                                  {t('view.deleteAttachment')}
                                </button>
                              )}
                          </li>
                        ))}
                      </ul>
                    )}
                  <input
                    ref={attachmentRef}
                    type="file"
                    accept="image/png,image/jpeg,image/gif,image/webp,text/plain,text/markdown,text/csv,application/json,application/pdf"
                    hidden
                    onChange={event => {
                      const file = event.target.files?.[0]
                      if (file !== undefined) void uploadAttachment(draft.id, file)
                      event.target.value = ''
                    }}
                    data-notes-attachment-input
                  />
                </section>
                <div className={css.metaRow}>
                  <label className={css.metaLabel} htmlFor="notes-tags">{t('view.tagsLabel')}</label>
                  <input
                    id="notes-tags"
                    className={css.tagsInput}
                    value={tagEditing ? tagText : draft.tags.join(', ')}
                    onFocus={() => { setTagText(draft.tags.join(', ')); setTagEditing(true) }}
                    onBlur={() => { setTagEditing(false) }}
                    onChange={event => {
                      // Keep the raw text while the field has focus: deriving the
                      // value from the parsed tags deleted the comma the moment it
                      // was typed, so a second tag could never be entered.
                      setTagText(event.target.value)
                      changeTags(event.target.value)
                    }}
                    placeholder={t('view.tags')}
                    aria-label={t('view.tags')}
                    data-notes-tags
                    disabled={deleted}
                  />
                  <span className={css.spacer} />
                  <span data-notes-linecount>{t('view.lineCount', { count: draft.body.split('\n').length })}</span>
                </div>
                <footer className={css.editorFoot}>
                  <span data-notes-wordcount>{t('view.wordCount', { count: countWords(draft.body) })}</span>
                  <span aria-hidden="true">·</span>
                  <span>{t('view.firstLineTitle')}</span>
                  <span className={css.spacer} />
                  <span data-notes-mode-hint>{preview ? t('view.preview') : t('view.sourceHint')}</span>
                  {deleted
                    ? null
                    : (
                      <>
                        {drafts !== undefined && (
                          <button
                            type="button"
                            className={css.toolButton}
                            data-notes-share={shared ? 'on' : 'off'}
                            disabled={running}
                            onClick={() => {
                              setShareError(undefined)
                              if (shared) {
                                void drafts.revoke({ draftId: draft.id }).then((ok) => {
                                  if (!ok) { setShareError(t('view.shareFailed')); return }
                                  setShared(false)
                                })
                                return
                              }
                              void drafts.share({ draftId: draft.id, fields: ['/body', '/tags'] }).then((ok) => {
                                if (!ok) { setShareError(t('view.shareFailed')); return }
                                setShared(true)
                              })
                            }}
                          >
                            {shared ? t('view.unshare') : t('view.share')}
                          </button>
                        )}
                        <button
                          type="button"
                          className={`${css.toolButton} ${css.primary}`}
                          onClick={() => { void persist() }}
                          disabled={running || saving || !dirty || conflict !== undefined}
                          data-notes-save
                        >
                          {t('view.save')}
                        </button>
                      </>
                    )}
                </footer>
              </>
            )}
        </section>
      </div>
      <Modal
        open={deleteOpen}
        onClose={() => { if (!deleteBusy) setDeleteOpen(false) }}
        title={t('view.deleteTitle')}
        tone="warning"
        closeLabel={t('view.cancel')}
        footer={(
          <>
            <Button size="sm" variant="ghost" disabled={deleteBusy} onClick={() => { setDeleteOpen(false) }}>{t('view.cancel')}</Button>
            <Button size="sm" variant="primary" disabled={deleteBusy} onClick={() => { void remove() }} data-notes-delete-confirm>{t('view.delete')}</Button>
          </>
        )}
      >
        <p>{t('view.confirmDelete')}</p>
      </Modal>
      {confirmDialog}
      {attachmentConfirmDialog}
      <input
        ref={importRef}
        type="file"
        accept="application/json,.json"
        hidden
        onChange={event => {
          const file = event.target.files?.[0]
          if (file !== undefined) void importFile(file)
          event.target.value = ''
        }}
        data-notes-import-input
      />
    </div>
  )
}
