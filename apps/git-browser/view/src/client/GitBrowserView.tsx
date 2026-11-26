/**
 * The git-browser page: **one repository workbench** over the four read-only
 * `git-browser` operations.
 *
 * The human types a path (or picks a recent one), and the page reads `status`
 * and one bounded `log` page. The working-tree tab groups the changes into
 * staged / unstaged / untracked / conflict and opens one file's unified patch
 * on click; the history tab lists commits and opens one commit's detail and
 * patch. The page is deliberately read-only: there is no stage, commit,
 * checkout or push control anywhere.
 *
 * Requests are serialized by the controls (busy disables the next click), and
 * a failure is shown as the call reported it — a missing git, a path that is
 * not a repository and a timeout have separate copy. The layout is responsive
 * with CSS alone: on a narrow page the list fills the body and a selected
 * detail replaces it, with a back control; on a wide page both panes are
 * visible.
 * @module @matrix1001/dsh-application-harness-git-browser-view/GitBrowserView
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { EmptyState, TabBar, useUiChoice, useUiField } from '@matrix1001/dsh-application-harness-client-chrome'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { Menu, MenuItemButton } from '@matrix1001/dsh-application-harness-client-chrome'
import css from './GitBrowserView.module.css'
import { ERROR_COPY, NS, type GitBrowserKey } from './locales.ts'
import { readRecentRepos, rememberRepo } from './recent.ts'
import {
  commitDateLabel,
  diffOf,
  errorKindOf,
  failureOf,
  groupFiles,
  groupOf,
  logOf,
  messageOfError,
  parsePatch,
  patchStats,
  repoNameOf,
  shortHash,
  showOf,
  statusOf,
  type CommitFileFace,
  type FailureInfo,
  type FileStatus,
  type LogFace,
  type PatchLine,
  type ShowFace,
  type StatusFace,
  type StatusFile,
  type WorktreeGroup,
} from './model.ts'

/** The translate face the page needs: this package's locale seat. */
export type GitBrowserTranslate = TranslateNS<'git-browser'>

/** The props of the registered page: the shell's face plus the locale service. */
export interface GitBrowserPageProps extends ApplicationViewProps {
  /** The client locale service (the registration binds the dictionary through it). */
  locale: LocaleRuntime
}

/** The props of the page body: the shell's call face and this package's translate seat. */
export interface GitBrowserViewProps extends ApplicationViewProps {
  /** The bound translate face of this package's own dictionary. */
  t: GitBrowserTranslate
}

/** The op whose request is in flight (its control shows the running label). */
type BusyOp = 'open' | 'diff' | 'show' | undefined

/** One page of the workbench. */
type TabId = 'worktree' | 'history'

/** One `log` page request (the host's default page size). */
const LOG_PAGE_SIZE = 50

/** The host's hard cap on one `log` page (`MAX_LOG_LIMIT` in the host's git module). */
const LOG_PAGE_MAX = 100

/**
 * What the one page-level banner reports failed. An open/status failure has no
 * content behind it and must survive navigation; a detail failure belongs to
 * the pane that asked for it and is cleared when that pane goes away.
 */
type FailureScope = 'open' | 'detail'

/** The page-level banner's failure plus the read that owns it. */
interface PageFailure {
  readonly info: FailureInfo
  readonly scope: FailureScope
}

/** Group → dictionary key. */
const GROUP_LABEL: Record<WorktreeGroup, GitBrowserKey> = {
  staged: 'view.group.staged',
  unstaged: 'view.group.unstaged',
  untracked: 'view.group.untracked',
  conflict: 'view.group.conflict',
}

/** One request through the page's single call face. */
interface RequestResult {
  value?: unknown
  failure?: FailureInfo
}

/**
 * The registered page: bind this package's dictionary to the viewer's locale
 * and render the workbench. The locale subscription repaints the page on a
 * language switch.
 * @param props - the shell's view face plus the locale service.
 * @returns the git-browser page.
 */
export function GitBrowserPage({ locale, ...props }: GitBrowserPageProps) {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <GitBrowserView {...props} t={locale.bind(NS)} />
}

/**
 * Render the git-browser workbench.
 * @param props - the shell's call face and the bound translator.
 * @returns the page chrome and the workbench body.
 */
export function GitBrowserView({ call, ui, t, openManagement }: GitBrowserViewProps) {
  const callRef = useRef(call)
  callRef.current = call

  const [path, setPath] = useUiField<string>(ui, 'path', '', (value): value is string => typeof value === 'string')
  const [tab, setTab] = useUiChoice<TabId>(ui, 'tab', ['worktree', 'history'], 'worktree')
  const [fileName, setFileName] = useUiField<string>(ui, 'file', '', (value): value is string => typeof value === 'string')
  const [fileSide, setFileSide] = useUiChoice<'staged' | 'unstaged'>(ui, 'side', ['staged', 'unstaged'], 'unstaged')
  const [commitId, setCommitId] = useUiField<string>(ui, 'commit', '', (value): value is string => typeof value === 'string')
  const [recent, setRecent] = useState<string[]>(() => readRecentRepos())
  const [recentOpen, setRecentOpen] = useState(false)
  const [openFormOpen, setOpenFormOpen] = useState(true)
  const [status, setStatus] = useState<StatusFace>()
  const [log, setLog] = useState<LogFace>()
  const [logLimit, setLogLimit] = useState(LOG_PAGE_SIZE)
  const [diff, setDiff] = useState<ReturnType<typeof diffOf>>()
  const [show, setShow] = useState<ShowFace>()
  const [selection, setSelection] = useState<StatusFile>()
  const [commitHash, setCommitHash] = useState<string>()
  const [busy, setBusy] = useState<BusyOp>()
  const [failure, setFailure] = useState<PageFailure>()
  const [logError, setLogError] = useState<string>()
  const [diffError, setDiffError] = useState<string>()
  const [showError, setShowError] = useState<string>()
  const [restoreNote, setRestoreNote] = useState<string>()
  const restored = useRef(false)
  const backRef = useRef<HTMLButtonElement>(null)
  const focusPathRef = useRef<string>()
  const focusHashRef = useRef<string>()
  const detailWasOpen = useRef(false)

  /** Run one op through the shell's one call face; a transport rejection is a failure too. */
  const request = async (op: string, args: Record<string, unknown>): Promise<RequestResult> => {
    try {
      const outcome = await callRef.current(op, args as JsonValue)
      if (outcome.status === 'success') return { value: outcome.result }
      return { failure: failureOf(outcome, t('view.cancelled')) }
    } catch (error) {
      return { failure: { message: messageOfError(error) } }
    }
  }

  /**
   * Report a failure that has no readable content to sit in. Only the
   * open/status read qualifies; log, diff and show keep their copy in the pane
   * that asked for it.
   * @param info - the host's failure, or the page's own malformed/cancelled copy.
   */
  const showPageFailure = (info: FailureInfo): void => {
    setFailure({ info, scope: 'open' })
  }

  /** Drop a banner a detail read put up; an open failure is still true. */
  const clearDetailFailure = (): void => {
    setFailure(current => current?.scope === 'detail' ? undefined : current)
  }

  /** Open one repository (a directory inside it resolves to its root). */
  const openRepo = async (rawPath: string, preserveSelection = false): Promise<void> => {
    const target = rawPath.trim()
    if (target === '') return
    // A refresh keeps the workbench on screen while it re-reads; only opening a
    // different repository may clear the previous one. A failed refresh must not
    // turn a readable workbench into an empty page.
    const refreshing = preserveSelection && status !== undefined
    setRecentOpen(false)
    setFailure(undefined)
    setBusy('open')
    if (!refreshing) {
      setSelection(undefined)
      setDiff(undefined)
      setCommitHash(undefined)
      setShow(undefined)
      setStatus(undefined)
      setLog(undefined)
      setLogLimit(LOG_PAGE_SIZE)
      setLogError(undefined)
    }
    if (!preserveSelection) {
      setFileName('')
      setCommitId('')
      setRestoreNote(undefined)
    }
    const statusResult = await request('status', { path: target })
    const statusFace = statusResult.failure === undefined ? statusOf(statusResult.value) : undefined
    if (statusFace === undefined) {
      showPageFailure(statusResult.failure ?? { message: t('view.malformed') })
      setBusy(undefined)
      return
    }
    setStatus(statusFace)
    setPath(statusFace.root)
    setOpenFormOpen(false)
    setRecent(rememberRepo(statusFace.root))
    const logResult = await request('log', { path: statusFace.root, limit: refreshing ? logLimit : LOG_PAGE_SIZE })
    const logFace = logResult.failure === undefined ? logOf(logResult.value) : undefined
    if (logFace === undefined) {
      // The repository header (and any rows read before a refresh) is still
      // valid content, so a history failure stays in the history pane.
      setLogError((logResult.failure ?? { message: t('view.malformed') }).message)
    } else {
      if (!refreshing) setLogLimit(LOG_PAGE_SIZE)
      setLog(logFace)
      setLogError(undefined)
    }
    setBusy(undefined)
  }

  const loadMoreLog = async (): Promise<void> => {
    /* v8 ignore next -- a stale button cannot outlive the repository it belongs to */
    if (status === undefined) return
    // The host clamps a page to LOG_PAGE_MAX; never ask for a page it cannot
    // return, or the next click would repaint the same rows with no control.
    const next = Math.min(logLimit + LOG_PAGE_SIZE, LOG_PAGE_MAX)
    setBusy('open')
    const result = await request('log', { path: status.root, limit: next })
    setBusy(undefined)
    if (result.failure !== undefined) { setLogError(result.failure.message); return }
    const face = logOf(result.value)
    /* v8 ignore next 3 -- a malformed log payload is a host contract violation */
    if (face === undefined) { setLogError(t('view.malformed')); return }
    setLog(face)
    setLogLimit(next)
    setLogError(undefined)
  }

  /** Submit the path control. */
  const submitPath = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    void openRepo(path)
  }

  /** Toggle the recent-repository menu. */
  const toggleRecent = (): void => {
    setRecentOpen((open) => !open)
  }

  /** Open one remembered repository. */
  const chooseRecent = (root: string): void => {
    setPath(root)
    void openRepo(root)
  }

  /** Re-read the repository on screen. */
  const refresh = (): void => {
    void openRepo(status?.root ?? path, true)
  }

  /** Select the history / working-tree page. */
  const selectTab = (id: string): void => {
    const next: TabId = id === 'history' ? 'history' : 'worktree'
    if (next === tab) return
    // A detail error belongs to the pane being left. The page banner does not:
    // an open/status failure still describes the workbench, so it stays.
    clearDetailFailure()
    if (next === 'history') setDiffError(undefined)
    else setShowError(undefined)
    setTab(next)
  }

  /** Read one file's patch and show it in the detail pane. */
  const selectFile = async (file: StatusFile, root: string): Promise<void> => {
    setSelection(file)
    setFileName(file.path)
    setFileSide(file.staged ? 'staged' : 'unstaged')
    setDiff(undefined)
    setDiffError(undefined)
    setBusy('diff')
    const result = await request('diff', { path: root, file: file.path, staged: file.staged })
    setBusy(undefined)
    if (result.failure !== undefined) {
      setDiffError(result.failure.message)
      return
    }
    const face = diffOf(result.value)
    if (face === undefined) {
      setDiffError(t('view.malformed'))
      return
    }
    setDiff(face)
  }

  /** Read one commit's detail and show it in the detail pane. */
  const selectCommit = async (hash: string, root: string): Promise<void> => {
    setCommitHash(hash)
    setCommitId(hash)
    setShow(undefined)
    setShowError(undefined)
    setBusy('show')
    const result = await request('show', { path: root, rev: hash })
    setBusy(undefined)
    if (result.failure !== undefined) {
      setShowError(result.failure.message)
      return
    }
    const face = showOf(result.value)
    if (face === undefined) {
      setShowError(t('view.malformed'))
      return
    }
    setShow(face)
  }

  /** Close the active detail (the overlay's back control, and Escape). */
  const goBack = (): void => {
    clearDetailFailure()
    if (tab === 'worktree') {
      focusPathRef.current = selection?.path
      setSelection(undefined)
      setFileName('')
      setDiff(undefined)
      setDiffError(undefined)
    } else {
      focusHashRef.current = commitHash
      setCommitHash(undefined)
      setCommitId('')
      setShow(undefined)
      setShowError(undefined)
    }
  }

  const sections = groupFiles(status?.files ?? [])
  // The shell's per-application UI state is the page's memory across app
  // switches: reopen the repository, then the file/commit the human left on.
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    if (path.trim() !== '') void openRepo(path, true)
  }, [])

  useEffect(() => {
    if (status === undefined || fileName === '' || selection !== undefined) return
    const file = status.files.find(candidate => candidate.path === fileName && (candidate.staged ? 'staged' : 'unstaged') === fileSide)
    if (file === undefined) {
      setFileName('')
      setRestoreNote(t('view.restore.fileGone'))
      return
    }
    void selectFile(file, status.root)
  }, [status, fileName, fileSide, selection])

  useEffect(() => {
    if (status === undefined || log === undefined || commitId === '' || commitHash !== undefined) return
    if (!log.commits.some(commit => commit.hash === commitId)) {
      setCommitId('')
      setRestoreNote(t('view.restore.commitGone'))
      return
    }
    void selectCommit(commitId, status.root)
  }, [status, log, commitId, commitHash])

  const commits = log?.commits ?? []
  const detailCommit = commitHash === undefined ? undefined : commits.find((commit) => commit.hash === commitHash)
  const detailOpen = tab === 'worktree' ? selection !== undefined : detailCommit !== undefined

  // The detail overlays the list on narrow and medium content widths; move the
  // reading focus with it and put it back on the row that opened it.
  const goBackRef = useRef(goBack)
  goBackRef.current = goBack
  useEffect(() => {
    if (detailOpen && !detailWasOpen.current) backRef.current?.focus()
    detailWasOpen.current = detailOpen
    if (detailOpen) return
    const path = focusPathRef.current
    const hash = focusHashRef.current
    if (path === undefined && hash === undefined) return
    focusPathRef.current = undefined
    focusHashRef.current = undefined
    const row = [...document.querySelectorAll<HTMLElement>(tab === 'worktree' ? '[data-git-file]' : '[data-git-commit]')]
      .find(candidate => path !== undefined ? candidate.dataset.gitFilePath === path : candidate.dataset.gitHash === hash)
    row?.focus()
  }, [detailOpen, tab])

  useEffect(() => {
    if (!detailOpen) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      goBackRef.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [detailOpen])
  const patchLines = diff === undefined ? [] : parsePatch(diff.patch)
  const stats = patchStats(patchLines)
  const tabs = [
    { id: 'worktree', label: t('view.tab.worktree'), anchor: { 'data-git-tab': 'worktree' } },
    { id: 'history', label: t('view.tab.history'), anchor: { 'data-git-tab': 'history' } },
  ]
  const failureView = failure === undefined
    ? undefined
    : { kind: errorKindOf(failure.info.code), info: failure.info }

  return (
    <div className={css.view} data-git-browser>
      {status === undefined || openFormOpen ? <header className={css.topbar} data-git-topbar>
        <form className={css.openForm} onSubmit={submitPath} data-git-open-form>
          <input
            className={css.pathInput}
            type="text"
            value={path}
            placeholder={t('view.path.placeholder')}
            aria-label={t('view.path.label')}
            onChange={(event) => { setPath(event.target.value) }}
            data-git-path-input
          />
          <button type="submit" className={css.openBtn} disabled={busy !== undefined} data-git-open>
            {busy === 'open' ? t('view.opening') : t('view.open')}
          </button>
        </form>
        <div className={css.actions}>
          <span className={css.readonlyBadge} data-git-readonly>{t('view.readonly')}</span>
          <div className={css.recentWrap}>
            <Menu
              open={recentOpen}
              align="end"
              listClassName={css.recentList}
              onClose={() => { setRecentOpen(false) }}
              anchor={(
                <button type="button" className={css.actionBtn} aria-haspopup="menu" aria-expanded={recentOpen} onClick={toggleRecent} data-git-recent-toggle>{t('view.recent')}</button>
              )}
            >
              {recent.length === 0
                ? <div className={css.recentEmpty} data-git-recent-empty>{t('view.recent.empty')}</div>
                : recent.map((root) => (
                  <MenuItemButton key={root} onSelect={() => { setRecentOpen(false); chooseRecent(root) }}>
                    <span className={css.recentItemBody} data-git-recent-item>
                      <span className={css.recentName}>{repoNameOf(root)}</span>
                      <span className={css.recentPath}>{root}</span>
                    </span>
                  </MenuItemButton>
                ))}
            </Menu>
          </div>
          <button type="button" className={css.actionBtn} onClick={refresh} disabled={busy !== undefined} data-git-refresh>{busy === 'open' ? t('view.opening') : t('view.refresh')}</button>
        </div>
      </header> : null}

      {failureView === undefined ? null : (
        <section className={css.notice} role="alert" data-git-error data-git-error-kind={failureView.kind}>
          <strong className={css.noticeTitle}>{t(ERROR_COPY[failureView.kind].title)}</strong>
          <p className={css.noticeBody}>{t(ERROR_COPY[failureView.kind].body)}</p>
          {failureView.kind === 'permission' ? (
            // The refusal names the header's "Notifications" control; this
            // button is the programmatic entry to the same permission page.
            <button
              type="button"
              className={css.managePermissions}
              onClick={() => { openManagement('permissions') }}
              data-git-manage-permissions
            >{t('view.error.permission.manage')}</button>
          ) : null}
          <details className={css.noticeDetail} data-git-error-detail>
            <summary>{t('view.error.diagnostic')}</summary>
            <span>{t('view.error.detail', { message: failureView.info.message })}</span>
          </details>
        </section>
      )}
      {restoreNote === undefined ? null : <p className={css.note} role="status" data-git-restore-note>{restoreNote}</p>}

      {status === undefined ? (
        failure === undefined ? (
          <EmptyState title={busy === 'open' ? t('view.opening') : t('view.empty.title')} body={busy === 'open' ? t('view.opening.hint') : t('view.empty.body')} data-git-empty />
        ) : null
      ) : (
        <>
          <header className={css.repoHead} data-git-repo>
            <div className={css.repoMain}>
              <div className={css.repoName}>
                <span className={css.repoNameText} data-git-repo-name title={status.root}>{repoNameOf(status.root)}</span>
                <span className={css.branchPill} data-git-branch title={status.branch ?? t('view.repo.detached')}>{status.branch ?? t('view.repo.detached')}</span>
                <span className={css.repoPath} data-git-root title={status.root}>{status.root}</span>
              </div>
            </div>
            <div className={css.repoMeta}>
              <button type="button" className={css.actionBtn} onClick={() => { setOpenFormOpen(true) }} data-git-change-repo>{t('view.changeRepo')}</button>
              {openFormOpen ? null : <button type="button" className={css.actionBtn} onClick={refresh} disabled={busy !== undefined} data-git-refresh>{busy === 'open' ? t('view.opening') : t('view.refresh')}</button>}
              {status.upstream === null ? null : <span className={css.pill} data-git-upstream>{t('view.repo.upstream', { upstream: status.upstream })}</span>}
              {status.upstream === null ? null : <span className={css.pill}>{t('view.repo.aheadBehind', { ahead: status.ahead, behind: status.behind })}</span>}
              <span
                className={status.files.length === 0 ? css.pillClean : css.pillDirty}
                data-git-dirty={status.files.length === 0 ? 'false' : 'true'}
              >{status.files.length === 0 ? t('view.repo.clean') : t('view.repo.dirty', { count: status.files.length })}</span>
              {status.lastCommit === undefined ? null : (
                <span className={css.lastCommit} data-git-last-commit>
                  {t('view.repo.lastCommit', { hash: shortHash(status.lastCommit.hash), subject: status.lastCommit.subject })}
                </span>
              )}
            </div>
          </header>

          <div className={css.tabsWrap}>
            <TabBar className={css.tabs} tabs={tabs} active={tab} onSelect={selectTab} data-git-tabs />
          </div>

          <main
            className={detailOpen ? `${css.main} ${css.mainDetail}` : css.main}
            data-git-main
            data-git-tab={tab}
            data-git-show-detail={detailOpen ? 'true' : 'false'}
          >
            <section className={css.listPane} data-git-list>
              {tab === 'worktree' ? (
                <>
                  <div className={css.listHead} data-git-list-head>
                    <span>{t('view.worktree.total', { count: status.files.length })}</span>
                    <span className={css.spacer} />
                    <span>{t('view.worktree.note')}</span>
                  </div>
                  {sections.length === 0 ? (
                    <p className={css.listEmpty} data-git-worktree-empty>{t('view.worktree.empty')}</p>
                  ) : sections.map((section) => (
                    <div key={section.group} data-git-section={section.group}>
                      <div className={css.groupHead} data-git-group={section.group}>
                        <b className={css.groupName}>{t(GROUP_LABEL[section.group])}</b>
                        <span className={css.groupCount}>{section.files.length}</span>
                      </div>
                      {section.files.map((file) => (
                        <button
                          key={`${file.staged ? 's' : 'w'}:${file.path}`}
                          type="button"
                          className={selection === file ? `${css.fileRow} ${css.fileRowSelected}` : css.fileRow}
                          disabled={busy !== undefined}
                          onClick={() => { void selectFile(file, status.root) }}
                          data-git-file
                          data-git-file-path={file.path}
                          data-git-file-side={file.staged ? 'staged' : 'unstaged'}
                          data-git-file-status={file.status}
                          title={file.path}
                          data-git-selected={selection === file ? 'true' : 'false'}
                        >
                          <span className={css.statusLetter} data-git-file-letter={file.status}>{file.status}</span>
                          <span className={css.filePath}>{file.path}</span>
                          {file.additions === undefined ? null : (
                            <span className={css.fileStat} data-git-file-stat>
                              <span className={css.add}>+{file.additions}</span> <span className={css.del}>−{file.deletions ?? 0}</span>
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  ))}
                </>
              ) : (
                <>
                  <div className={css.listHead} data-git-list-head>
                    <span data-git-history-total>{t('view.history.total', { count: commits.length })}</span>
                  </div>
                  {logError !== undefined ? (
                    // A failed page belongs beside the rows it could not extend:
                    // an open refresh keeps the already-read commits visible.
                    <div className={css.listEmpty} role="alert" data-git-log-error>
                      <p>{t('view.history.failed', { message: logError })}</p>
                      <button type="button" className={css.actionBtn} onClick={refresh} data-git-log-retry>{t('view.retry')}</button>
                    </div>
                  ) : null}
                  {commits.length === 0 ? (
                    logError === undefined ? <p className={css.listEmpty} data-git-history-empty>{t('view.history.empty')}</p> : null
                  ) : commits.map((commit) => (
                    <button
                      key={commit.hash}
                      type="button"
                      className={commitHash === commit.hash ? `${css.historyRow} ${css.historyRowSelected}` : css.historyRow}
                      disabled={busy !== undefined}
                      onClick={() => { void selectCommit(commit.hash, status.root) }}
                      data-git-commit
                      data-git-commit-open
                      data-git-hash={commit.hash}
                      title={commit.subject}
                      data-git-selected={commitHash === commit.hash ? 'true' : 'false'}
                    >
                      <span className={css.commitSubject}>{commit.subject}</span>
                      <span className={css.commitMeta}>
                        <span className={css.hash}>{shortHash(commit.hash)}</span>
                        <span>·</span>
                        <span>{commit.author}</span>
                        <span>·</span>
                        <span>{commitDateLabel(commit.time)}</span>
                      </span>
                    </button>
                  ))}
                  {logError === undefined && commits.length >= logLimit ? (
                    commits.length >= LOG_PAGE_MAX ? (
                      <p className={css.listCap} data-git-log-cap>{t('view.history.cap', { count: LOG_PAGE_MAX })}</p>
                    ) : (
                      <button type="button" className={css.actionBtn} onClick={() => { void loadMoreLog() }} disabled={busy !== undefined} data-git-load-more>{t('view.history.loadMore')}</button>
                    )
                  ) : null}
                </>
              )}
            </section>

            <section className={css.detailPane} data-git-detail>
              {detailOpen ? (
                <button ref={backRef} type="button" className={css.backBtn} onClick={goBack} data-git-back>{t('view.back')}</button>
              ) : null}
              {tab === 'worktree' ? (
                selection === undefined ? (
                  <p className={css.detailEmpty} data-git-detail-empty>{t('view.worktree.note')}</p>
                ) : (
                  <div className={css.diff} data-git-diff>
                    <header className={css.diffHead}>
                      <div>
                        <h2 className={css.diffTitle} data-git-diff-title>{selection.path}</h2>
                        <div className={css.diffSub} data-git-diff-subtitle>{t('view.diff.subtitle', { group: t(GROUP_LABEL[groupOf(selection)]) })}</div>
                      </div>
                      <span className={css.diffStats} data-git-diff-stats>{t('view.diff.stats', { additions: stats.additions, deletions: stats.deletions })}</span>
                    </header>
                    <p className={css.note} data-git-diff-readonly>{t('view.diff.readonly')}</p>
                    {diffError !== undefined ? (
                      <div className={css.detailEmpty} role="alert" data-git-diff-error>
                        <p>{t('view.diff.failed', { message: diffError })}</p>
                        <button type="button" className={css.actionBtn} onClick={() => { if (selection !== undefined && status !== undefined) void selectFile(selection, status.root) }} data-git-diff-retry>{t('view.retry')}</button>
                      </div>
                    ) : diff === undefined ? (
                      <p className={css.note} data-git-diff-pending>{busy === 'diff' ? t('view.diff.loading') : t('view.diff.empty')}</p>
                    ) : (
                      <>
                        {diff.binary ? <p className={css.note} data-git-binary>{t('view.diff.binary')}</p> : null}
                        {!diff.binary && diff.patch === '' ? (
                          <p className={css.note} data-git-diff-empty>{selection.status === '?' ? t('view.diff.untracked') : t('view.diff.empty')}</p>
                        ) : null}
                        {!diff.binary && diff.patch !== '' ? <PatchView lines={patchLines} /> : null}
                        {diff.truncated ? <p className={css.note} data-git-truncated>{t('view.diff.truncated')}</p> : null}
                      </>
                    )}
                  </div>
                )
              ) : detailCommit === undefined ? (
                <p className={css.detailEmpty} data-git-detail-empty>{t('view.history.select')}</p>
              ) : (
                <div className={css.commitDetail} data-git-show>
                  <h2 className={css.commitTitle} data-git-show-subject>{detailCommit.subject}</h2>
                  <div className={css.commitMeta} data-git-show-meta>
                    <span className={css.hash}>{shortHash(detailCommit.hash)}</span>
                    <span>·</span>
                    <span>{detailCommit.author}</span>
                    <span>·</span>
                    <span>{commitDateLabel(detailCommit.time)}</span>
                  </div>
                  {showError !== undefined ? (
                    <div className={css.detailEmpty} role="alert" data-git-show-error>
                      <p>{t('view.show.failed', { message: showError })}</p>
                      <button type="button" className={css.actionBtn} onClick={() => { if (commitHash !== undefined && status !== undefined) void selectCommit(commitHash, status.root) }} data-git-show-retry>{t('view.retry')}</button>
                    </div>
                  ) : show === undefined ? (
                    <p className={css.note} data-git-show-loading>{busy === 'show' ? t('view.show.loading') : t('view.diff.empty')}</p>
                  ) : (
                    <>
                      <p className={css.sectionLabel} data-git-show-body-label>{t('view.commit.body')}</p>
                      <pre className={css.commitBody} data-git-show-body>{show.commit.body === '' ? '—' : show.commit.body}</pre>
                      <p className={css.sectionLabel} data-git-show-files-label>{t('view.commit.files')}</p>
                      {show.files.length === 0 ? (
                        <p className={css.note} data-git-show-files-empty>{t('view.commit.noFiles')}</p>
                      ) : (
                        <ul className={css.commitFiles} data-git-show-files>
                          {show.files.map((file: CommitFileFace) => (
                            <li key={file.path} className={css.commitFile} data-git-show-file>
                              <span className={css.filePath} data-git-show-file-path title={file.path}>{file.path}</span>
                              <span className={css.commitFileStat}>
                                {file.binary
                                  ? t('view.diff.binary')
                                  : t('view.diff.stats', { additions: file.additions ?? 0, deletions: file.deletions ?? 0 })}
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                      {show.patch !== ''
                        ? <PatchView lines={parsePatch(show.patch)} />
                        : show.binary ? <p className={css.note} data-git-show-binary>{t('view.diff.binary')}</p> : null}
                      {show.truncated ? <p className={css.note} data-git-show-truncated>{t('view.diff.truncated')}</p> : null}
                      <p className={css.note} data-git-commit-readonly>{t('view.commit.readonly', { hash: shortHash(detailCommit.hash) })}</p>
                    </>
                  )}
                </div>
              )}
            </section>
          </main>
        </>
      )}
    </div>
  )
}

/**
 * Render one parsed unified patch: hunk headers and numbered add/delete/context
 * lines with their two line-number columns.
 * @param props - the parsed lines.
 * @returns the patch box.
 */
function PatchView({ lines }: { lines: readonly PatchLine[] }) {
  return (
    <div className={css.patch} data-git-patch>
      {lines.map((line, index) => line.kind === 'hunk' ? (
        <div key={index} className={css.hunkHead} data-git-hunk>{line.text}</div>
      ) : (
        <div
          key={index}
          className={line.kind === 'add' ? `${css.line} ${css.lineAdd}` : line.kind === 'del' ? `${css.line} ${css.lineDel}` : `${css.line} ${css.lineCtx}`}
          data-git-line
          data-git-line-kind={line.kind}
          {...(line.kind === 'add' || line.kind === 'del' ? { 'aria-label': `${line.kind === 'add' ? '+' : '−'} ${line.text}` } : {})}
        >
          <span className={css.lineMark} aria-hidden="true">{line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}</span>
          <span className={css.lineNo} data-git-line-old>{line.oldLine ?? ''}</span>
          <span className={css.lineNo} data-git-line-new>{line.newLine ?? ''}</span>
          <span className={css.lineCode}>{line.text}</span>
        </div>
      ))}
    </div>
  )
}

/** The status letter type is exported by the model; re-exported here for the page tests. */
export type { FileStatus }
