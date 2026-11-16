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

import { useCallback, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { EmptyState, TabBar } from '@matrix1001/dsh-application-harness-client-chrome'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import type { JsonValue } from '@matrix1001/dsh-application-harness-host-bridge/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { Menu, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
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
export function GitBrowserView({ call, t }: GitBrowserViewProps) {
  const callRef = useRef(call)
  callRef.current = call

  const [path, setPath] = useState('')
  const [recent, setRecent] = useState<string[]>(() => readRecentRepos())
  const [recentOpen, setRecentOpen] = useState(false)
  const [openFormOpen, setOpenFormOpen] = useState(true)
  const [tab, setTab] = useState<TabId>('worktree')
  const [status, setStatus] = useState<StatusFace>()
  const [log, setLog] = useState<LogFace>()
  const [logLimit, setLogLimit] = useState(50)
  const [diff, setDiff] = useState<ReturnType<typeof diffOf>>()
  const [show, setShow] = useState<ShowFace>()
  const [selection, setSelection] = useState<StatusFile>()
  const [commitHash, setCommitHash] = useState<string>()
  const [busy, setBusy] = useState<BusyOp>()
  const [failure, setFailure] = useState<FailureInfo>()
  const [logError, setLogError] = useState<string>()
  const [diffError, setDiffError] = useState<string>()
  const [showError, setShowError] = useState<string>()

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

  /** Open one repository (a directory inside it resolves to its root). */
  const openRepo = async (rawPath: string): Promise<void> => {
    const target = rawPath.trim()
    if (target === '') return
    setRecentOpen(false)
    setFailure(undefined)
    setBusy('open')
    setSelection(undefined)
    setDiff(undefined)
    setCommitHash(undefined)
    setShow(undefined)
    setStatus(undefined)
    setLog(undefined)
    setLogLimit(50)
    setLogError(undefined)
    const statusResult = await request('status', { path: target })
    const statusFace = statusResult.failure === undefined ? statusOf(statusResult.value) : undefined
    if (statusFace === undefined) {
      setFailure(statusResult.failure ?? { message: t('view.malformed') })
      setBusy(undefined)
      return
    }
    setStatus(statusFace)
    setPath(statusFace.root)
    setOpenFormOpen(false)
    setRecent(rememberRepo(statusFace.root))
    const logResult = await request('log', { path: statusFace.root, limit: 50 })
    const logFace = logResult.failure === undefined ? logOf(logResult.value) : undefined
    if (logFace === undefined) {
      setFailure(logResult.failure ?? { message: t('view.malformed') })
      setLogError((logResult.failure ?? { message: t('view.malformed') }).message)
    } else {
      setLog(logFace)
      setLogError(undefined)
    }
    setBusy(undefined)
  }

  const loadMoreLog = async (): Promise<void> => {
    /* v8 ignore next -- a stale button cannot outlive the repository it belongs to */
    if (status === undefined) return
    const next = logLimit + 50
    setBusy('open')
    const result = await request('log', { path: status.root, limit: next })
    setBusy(undefined)
    if (result.failure !== undefined) { setFailure(result.failure); setLogError(result.failure.message); return }
    const face = logOf(result.value)
    /* v8 ignore next 3 -- a malformed log payload is a host contract violation */
    if (face === undefined) { setLogError(t('view.malformed')); return }
    setLog(face)
    setLogLimit(next)
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
    void openRepo(status?.root ?? path)
  }

  /** Select the history / working-tree page. */
  const selectTab = (id: string): void => {
    setTab(id === 'history' ? 'history' : 'worktree')
  }

  /** Read one file's patch and show it in the detail pane. */
  const selectFile = async (file: StatusFile, root: string): Promise<void> => {
    setSelection(file)
    setDiff(undefined)
    setDiffError(undefined)
    setFailure(undefined)
    setBusy('diff')
    const result = await request('diff', { path: root, file: file.path, staged: file.staged })
    setBusy(undefined)
    if (result.failure !== undefined) {
      setFailure(result.failure)
      setDiffError(result.failure.message)
      return
    }
    const face = diffOf(result.value)
    if (face === undefined) {
      setFailure({ message: t('view.malformed') })
      setDiffError(t('view.malformed'))
      return
    }
    setDiff(face)
  }

  /** Read one commit's detail and show it in the detail pane. */
  const selectCommit = async (hash: string, root: string): Promise<void> => {
    setCommitHash(hash)
    setShow(undefined)
    setShowError(undefined)
    setFailure(undefined)
    setBusy('show')
    const result = await request('show', { path: root, rev: hash })
    setBusy(undefined)
    if (result.failure !== undefined) {
      setFailure(result.failure)
      setShowError(result.failure.message)
      return
    }
    const face = showOf(result.value)
    if (face === undefined) {
      setFailure({ message: t('view.malformed') })
      setShowError(t('view.malformed'))
      return
    }
    setShow(face)
  }

  /** Close the active detail (the narrow layout's back control). */
  const goBack = (): void => {
    if (tab === 'worktree') {
      setSelection(undefined)
      setDiff(undefined)
    } else {
      setCommitHash(undefined)
      setShow(undefined)
    }
  }

  const sections = groupFiles(status?.files ?? [])
  const commits = log?.commits ?? []
  const detailCommit = commitHash === undefined ? undefined : commits.find((commit) => commit.hash === commitHash)
  const detailOpen = tab === 'worktree' ? selection !== undefined : detailCommit !== undefined
  const patchLines = diff === undefined ? [] : parsePatch(diff.patch)
  const stats = patchStats(patchLines)
  const tabs = [
    { id: 'worktree', label: t('view.tab.worktree'), anchor: { 'data-git-tab': 'worktree' } },
    { id: 'history', label: t('view.tab.history'), anchor: { 'data-git-tab': 'history' } },
  ]

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

      {failure === undefined ? null : (
        <section className={css.notice} role="alert" data-git-error data-git-error-kind={errorKindOf(failure.code)}>
          <strong className={css.noticeTitle}>{t(ERROR_COPY[errorKindOf(failure.code)].title)}</strong>
          <p className={css.noticeBody}>{t(ERROR_COPY[errorKindOf(failure.code)].body)}</p>
          <p className={css.noticeDetail} data-git-error-detail>{t('view.error.detail', { message: failure.message })}</p>
        </section>
      )}

      {status === undefined ? (
        failure === undefined ? (
          <EmptyState title={busy === 'open' ? t('view.opening') : t('view.empty.title')} body={busy === 'open' ? t('view.path.placeholder') : t('view.empty.body')} data-git-empty />
        ) : null
      ) : (
        <>
          <header className={css.repoHead} data-git-repo>
            <div className={css.repoMain}>
              <div className={css.repoName}>
                <span data-git-repo-name>{repoNameOf(status.root)}</span>
                <span className={css.branchPill} data-git-branch>{status.branch ?? t('view.repo.detached')}</span>
                <span className={css.repoPath} data-git-root>{status.root}</span>
              </div>
            </div>
            <div className={css.repoMeta}>
              <button type="button" className={css.actionBtn} onClick={() => { setOpenFormOpen(true) }} data-git-change-repo>{t('view.changeRepo')}</button>
              {openFormOpen ? null : <button type="button" className={css.actionBtn} onClick={refresh} data-git-refresh>{t('view.refresh')}</button>}
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
            <TabBar tabs={tabs} active={tab} onSelect={selectTab} data-git-tabs />
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
                    <div className={css.listEmpty} role="alert" data-git-log-error>
                      <p>{t('view.history.failed', { message: logError })}</p>
                      <button type="button" className={css.actionBtn} onClick={refresh} data-git-log-retry>{t('view.retry')}</button>
                    </div>
                  ) : commits.length === 0 ? (
                    <p className={css.listEmpty} data-git-history-empty>{t('view.history.empty')}</p>
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
                    <button type="button" className={css.actionBtn} onClick={() => { void loadMoreLog() }} disabled={busy !== undefined} data-git-load-more>{t('view.history.loadMore')}</button>
                  ) : null}
                </>
              )}
            </section>

            <section className={css.detailPane} data-git-detail>
              {detailOpen ? (
                <button type="button" className={css.backBtn} onClick={goBack} data-git-back>{t('view.back')}</button>
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
                              <span className={css.filePath} data-git-show-file-path>{file.path}</span>
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
        >
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
