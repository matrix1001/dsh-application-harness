import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { TabBar, useModalFocus } from '@matrix1001/dsh-application-harness-client-chrome'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import { NS } from './locales.ts'
import {
  agentLabel, aiStatusLabelKey, evidenceCount, evidenceTitle, formatDateTime, formatDuration, groupTimeline, messageOf,
  metricEntries, outcomeLabelKey, percent, rangeLabelKey, rangeText, shortDate, shortId, signalLabelKey, sourceTotal,
  valueOf, weekRangeText,
  type AgentKind, type EvidenceConclusion, type Review, type ReviewAi, type ReviewPreview, type ReviewRange,
  type ReviewSettings, type ReviewSummary, type SessionEvidenceView, type SourceInfo, type TimelineEntry, type Translate,
  type WorkspaceView,
} from './model.ts'
import css from './WorkspaceReviewView.module.css'

/** The translate face this page needs. */
export type WorkspaceReviewTranslate = TranslateNS<'workspace-review'>

/** The props of the registered page. */
export interface WorkspaceReviewPageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface WorkspaceReviewViewProps extends ApplicationViewProps { t: WorkspaceReviewTranslate }

const RANGES: readonly ReviewRange[] = ['week', 'last7', 'month', 'last30', 'all', 'custom']
const AGENTS: readonly AgentKind[] = ['dsh', 'claude-code', 'codex']

type Tab = 'report' | 'unmatched'

/** The registered page: bind the dictionary and render the body. */
export function WorkspaceReviewPage({ locale, ...props }: WorkspaceReviewPageProps) {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <WorkspaceReviewView {...props} t={locale.bind(NS)} />
}

/** One agent badge. */
function AgentBadge({ agent }: { agent: AgentKind }) {
  return <span className={css.agent} data-agent={agent}>{agentLabel(agent)}</span>
}

/** One clickable evidence reference. */
function EvidenceChip({ id, title, onOpen }: { id: string; title: string; onOpen: (id: string) => void }) {
  return (
    <button type="button" className={css.evidenceChip} onClick={() => { onOpen(id) }} data-wr-evidence={id}>
      {title}
    </button>
  )
}

/** One evidence list for a conclusion. */
function EvidenceList({ evidence, review, onOpen }: { evidence: string[]; review: Review; onOpen: (id: string) => void }) {
  if (evidence.length === 0) return null
  return (
    <span className={css.evidenceRow}>
      {evidence.map(id => <EvidenceChip key={id} id={id} title={evidenceTitle(review, id)} onOpen={onOpen} />)}
    </span>
  )
}

function Notice({ message }: { message: string }) {
  if (message === '') return null
  return <div className={css.notice} role="status" data-wr-notice>{message}</div>
}

function ErrorBanner({ message, anchor }: { message: string; anchor: string }) {
  return <div className={css.errorBanner} role="alert" {...{ [anchor]: true }}>{message}</div>
}

/** The report's AI card when the AI half did not produce a narrative. */
function AiStatusCard({ ai, t }: { ai: ReviewAi; t: WorkspaceReviewTranslate }) {
  if (ai.status === 'generated') return null
  const detail = ai.status === 'disabled'
    ? t('view.aiDisabled')
    : ai.status === 'unavailable'
      ? t('view.aiUnavailable', { message: ai.message ?? '' })
      : ai.status === 'failed'
        ? t('view.aiFailed', { message: ai.message ?? '' })
        : t('view.aiNotRequested')
  return (
    <section className={css.summaryCard} data-wr-ai-failure data-ai-status={ai.status}>
      <div className={css.aiLine}>
        <span className={css.aiBadge}>{t('view.aiBadge')}</span>
        <span>{t('view.aiNotGenerated')}</span>
        <span className={css.spacer} />
        <span className={css.aiStatus}>{t(aiStatusLabelKey(ai.status) as never)}</span>
      </div>
      <p className={css.aiMessage}>{detail}</p>
      <div className={css.summaryFoot}>{t('view.aiFailureNote')}</div>
    </section>
  )
}

/** The AI summary card (or the explicit "not generated" card). */
function SummaryCard({ review, onOpen, t }: { review: Review; onOpen: (id: string) => void; t: WorkspaceReviewTranslate }) {
  const summary = review.narrative?.summary
  if (summary === undefined) return <AiStatusCard ai={review.ai} t={t} />
  const analyzed = review.ai.analyzedSessions ?? review.sessionIds.length
  const total = review.ai.totalSessions ?? review.sessionIds.length
  return (
    <section className={css.summaryCard} data-wr-summary>
      <div className={css.aiLine}>
        <span className={css.aiBadge}>{t('view.aiBadge')}</span>
        <span>{t('view.aiSummary', { analyzed, total })}</span>
        <span className={css.spacer} />
        <span className={css.aiFact}>{t('view.aiFactSeparate')}</span>
      </div>
      <p className={css.summaryText}>{summary.text}</p>
      <div className={css.summaryFoot}>
        <span>{t('view.citation')}</span>
        <EvidenceList evidence={summary.evidence} review={review} onOpen={onOpen} />
        <span>· {t('view.aiEvidenceNote')}</span>
      </div>
    </section>
  )
}

/** The six deterministic metrics. */
function Metrics({ review, t }: { review: Review; t: WorkspaceReviewTranslate }) {
  return (
    <section className={css.metrics} data-wr-metrics>
      {metricEntries(review).map(metric => (
        <div className={css.metric} key={metric.key} data-metric={metric.key}>
          <div className={css.metricLabel}>{t(metric.labelKey as never)}</div>
          <div className={css.metricValue}>{metric.value}</div>
          <div className={css.metricNote}>
            {metric.key === 'sessions'
              ? t(metric.noteKey as never, { count: review.deterministic.sources.length })
              : t(metric.noteKey as never)}
          </div>
        </div>
      ))}
    </section>
  )
}

/** The weekly stacked rhythm chart. */
function RhythmChart({ review, t }: { review: Review; t: WorkspaceReviewTranslate }) {
  const weeks = review.deterministic.weeks
  const max = Math.max(1, ...weeks.map(week => week.total))
  return (
    <div className={css.panel} data-wr-rhythm>
      <div className={css.panelHead}>
        <h2>{t('view.rhythm')}</h2>
        <span className={css.tag}>{t('view.rhythmFact')}</span>
        <span className={css.spacer} />
        <span className={css.tag}>{t('view.rhythmSessions', { count: review.deterministic.metrics.sessions ?? 0 })}</span>
      </div>
      {weeks.length === 0 ? <div className={css.panelEmpty}>{t('view.emptyReview')}</div> : (
        <div className={css.chartWrap}>
          <div className={css.chart} data-wr-rhythm-chart>
            {weeks.map(week => (
              <div className={css.barColumn} key={week.label} data-wr-week={week.label}>
                <div className={css.barStack} style={{ height: `${String(Math.max(2, Math.round((week.total / max) * 100)))}%` }}>
                  {AGENTS.filter(agent => (week.agents[agent] ?? 0) > 0).map(agent => (
                    <span key={agent} className={css.segment} data-agent={agent} style={{ flexGrow: week.agents[agent] ?? 0 }} />
                  ))}
                </div>
                <span className={css.barLabel}>{shortDate(week.label)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={css.legend}>
        {AGENTS.map(agent => <span className={css.legendKey} key={agent}><i className={css.legendDot} data-agent={agent} />{agentLabel(agent)}</span>)}
      </div>
    </div>
  )
}

/** Source distribution: metadata only, never a ranking. */
function SourcePanel({ review, t }: { review: Review; t: WorkspaceReviewTranslate }) {
  const total = sourceTotal(review)
  return (
    <div className={css.panel} data-wr-sources>
      <div className={css.panelHead}>
        <h2>{t('view.sources')}</h2>
        <span className={css.tag}>{t('view.sourcesMeta')}</span>
      </div>
      <div className={css.sourceList}>
        {review.deterministic.sources.map(source => {
          const share = percent(source.count, total)
          return (
            <div className={css.sourceRow} key={source.agent} data-source={source.agent}>
              <AgentBadge agent={source.agent} />
              <span className={css.sourceBar}><i style={{ width: `${String(share)}%` }} data-agent={source.agent} /></span>
              <span className={css.sourceCount}>{source.count} · {share}%</span>
            </div>
          )
        })}
      </div>
      <div className={css.sourceNote}>{t('view.sourcesNote')}</div>
    </div>
  )
}

/** Deterministic fact signals. */
function Signals({ review, t }: { review: Review; t: WorkspaceReviewTranslate }) {
  if (review.deterministic.signals.length === 0) return null
  return (
    <section className={css.signals} data-wr-signals>
      {review.deterministic.signals.map(signal => (
        <span className={css.signalChip} key={`${signal.kind}:${signal.text}`} data-signal={signal.kind}>
          {t(signalLabelKey(signal.kind) as never)} · {signal.text}
        </span>
      ))}
    </section>
  )
}

/** One timeline row. */
function TimelineRow({ entry, onOpen, t }: { entry: TimelineEntry; onOpen: (id: string) => void; t: WorkspaceReviewTranslate }) {
  return (
    <button type="button" className={css.sessionRow} onClick={() => { onOpen(entry.sessionId) }} data-wr-timeline-session={entry.sessionId}>
      <span className={css.sessionDate}>{shortDate(entry.date)}</span>
      <span className={css.sessionMain}>
        <span className={css.sessionTitle}><AgentBadge agent={entry.agent} /><b>{entry.title}</b></span>
        <span className={css.sessionSummary}>{entry.summary}</span>
        <span className={css.sessionMeta}>
          <span>{formatDuration(entry.durationMinutes)}</span><span>·</span><span>{entry.turnCount} {t('view.turns')}</span>
          <span>·</span><span className={css.outcome} data-outcome={entry.outcome}>{t(outcomeLabelKey(entry.outcome) as never)}</span>
        </span>
      </span>
      <span className={css.sessionEvidence}>{t('view.evidenceCount', { count: evidenceCount(entry) })}</span>
    </button>
  )
}

/** The parent-session timeline grouped by week. */
function Timeline({ review, onOpen, t }: { review: Review; onOpen: (id: string) => void; t: WorkspaceReviewTranslate }) {
  const groups = groupTimeline(review.deterministic.timeline)
  return (
    <section className={css.section} data-wr-timeline>
      <div className={css.sectionHead}>
        <h2>{t('view.timeline')}</h2>
        <span className={css.sectionNote}>{t('view.timelineFact')}</span>
      </div>
      <div className={css.timeline}>
        {groups.length === 0 ? <div className={css.panelEmpty}>{t('view.emptyReview')}</div> : groups.map(group => (
          <div key={group.label}>
            <div className={css.weekLabel}>{weekRangeText(group.label)}</div>
            {group.entries.map(entry => <TimelineRow key={entry.sessionId} entry={entry} onOpen={onOpen} t={t} />)}
          </div>
        ))}
      </div>
    </section>
  )
}

/** One AI conclusion line. */
function ConclusionLine({ conclusion, review, onOpen, t: _t }: { conclusion: EvidenceConclusion; review: Review; onOpen: (id: string) => void; t: WorkspaceReviewTranslate }) {
  return (
    <div className={css.conclusion}>
      <div className={css.conclusionMain}>{conclusion.text}</div>
      <EvidenceList evidence={conclusion.evidence} review={review} onOpen={onOpen} />
    </div>
  )
}

/** Themes, decisions, patterns and open loops, each with evidence. */
function NarrativeSections({ review, onOpen, t }: { review: Review; onOpen: (id: string) => void; t: WorkspaceReviewTranslate }) {
  const narrative = review.narrative
  if (narrative === undefined) return null
  return (
    <>
      <section className={css.section} data-wr-themes>
        <div className={css.sectionHead}><h2>{t('view.themes')}</h2><span className={css.sectionNote}>{t('view.themesNote')}</span></div>
        <div className={css.themeGrid}>
          {narrative.themes.map(theme => (
            <div className={css.theme} key={theme.title}>
              <div className={css.aiLine}><span className={css.aiBadge}>{t('view.aiBadge')}</span><span>{t('view.themes')}</span></div>
              <h3>{theme.title}</h3>
              <p>{theme.text}</p>
              <EvidenceList evidence={theme.evidence} review={review} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </section>
      <section className={css.section} data-wr-decisions>
        <div className={css.sectionHead}><h2>{t('view.decisions')}</h2><span className={css.sectionNote}>{t('view.decisionsNote')}</span></div>
        <div className={css.list}>
          {narrative.decisions.map(decision => (
            <div className={css.listRow} key={decision.text}>
              <span className={css.kind} data-kind={decision.kind}>{t(decision.kind === 'explicit' ? 'view.kind.explicit' : 'view.kind.inferred')}</span>
              <div className={css.conclusionMain}>{decision.text}</div>
              <EvidenceList evidence={decision.evidence} review={review} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </section>
      <section className={css.section} data-wr-patterns>
        <div className={css.sectionHead}><h2>{t('view.patterns')}</h2><span className={css.sectionNote}>{t('view.patternsNote')}</span></div>
        <div className={css.list}>
          {narrative.friction.map(item => (
            <div className={css.listRow} key={item.text}>
              <i className={css.patternMark} />
              <div className={css.conclusionMain}>{item.text}</div>
              <EvidenceList evidence={item.evidence} review={review} onOpen={onOpen} />
            </div>
          ))}
        </div>
      </section>
      <section className={css.section} data-wr-dead-ends>
        <div className={css.sectionHead}><h2>{t('view.deadEnds')}</h2><span className={css.sectionNote}>{t('view.deadEndsNote')}</span></div>
        <div className={css.list}>
          {narrative.deadEnds.map(item => <ConclusionLine key={item.text} conclusion={item} review={review} onOpen={onOpen} t={t} />)}
        </div>
      </section>
      <section className={css.section} data-wr-open-loops>
        <div className={css.sectionHead}><h2>{t('view.openLoops')}</h2><span className={css.sectionNote}>{t('view.openLoopsNote')}</span></div>
        <div className={css.list}>
          {narrative.openLoops.map(item => <ConclusionLine key={item.text} conclusion={item} review={review} onOpen={onOpen} t={t} />)}
        </div>
      </section>
    </>
  )
}

/** The full report. */
function ReportView({ review, workspace, newSinceReview, syncError, syncWarning, onOpen, onGenerate, onSync, t }: {
  review: Review
  workspace: WorkspaceView | undefined
  newSinceReview: number
  syncError: string | undefined
  syncWarning: string | undefined
  onOpen: (id: string) => void
  onGenerate: () => void
  onSync: () => void
  t: WorkspaceReviewTranslate
}) {
  const tx = t as unknown as Translate
  return (
    <div className={css.report} data-wr-report>
      <div className={css.reportHead}>
        <div>
          <div className={css.kicker}>{t('view.kicker')}</div>
          <h1>{t(rangeLabelKey(review.range) as never)}</h1>
          <div className={css.reportSub}>{rangeText(review.from, review.to, tx)} · {t('view.generatedAt', { time: formatDateTime(review.generatedAt) })}</div>
        </div>
      </div>
      <div className={css.workspaceLine}>
        <span className={css.workspaceName}>{review.workspaceName}</span>
        <span className={css.workspacePath}>{review.root}</span>
        <WorkspaceAgents review={review} t={t} />
      </div>
      {syncError === undefined ? null : (
        <div className={css.syncError} data-wr-sync-error>
          <div>{t('view.syncFailed', { message: syncError })}</div>
          <div className={css.small}>{t('view.syncFailedNote')}</div>
          <button type="button" className={css.button} onClick={onSync}>{t('view.retry')}</button>
        </div>
      )}
      {syncWarning === undefined ? null : <div className={css.syncWarning} role="status" data-wr-sync-warning>{syncWarning}</div>}
      {newSinceReview > 0 ? (
        <div className={css.newBanner} data-wr-new-sessions>
          <span>{t('view.newSessionsPlain', { count: newSinceReview })}</span>
          <span className={css.spacer} />
          <button type="button" className={css.linkButton} onClick={onGenerate}>{t('view.generateNew')}</button>
        </div>
      ) : null}
      <SummaryCard review={review} onOpen={onOpen} t={t} />
      <Metrics review={review} t={t} />
      <div className={css.insightGrid}>
        <RhythmChart review={review} t={t} />
        <SourcePanel review={review} t={t} />
      </div>
      <Signals review={review} t={t} />
      <Timeline review={review} onOpen={onOpen} t={t} />
      <NarrativeSections review={review} onOpen={onOpen} t={t} />
      {workspace === undefined ? null : <div className={css.reportFoot} data-wr-workspace-root={workspace.root}>{t('view.workspaceRoot')} · {workspace.root}</div>}
    </div>
  )
}

/** The "no review yet" state, keeping empty, missing-source and sync failure distinct. */
function EmptyReview({ sources, syncError, syncWarning, onGenerate, onSync, t }: {
  sources: SourceInfo[]
  syncError: string | undefined
  syncWarning: string | undefined
  onGenerate: () => void
  onSync: () => void
  t: WorkspaceReviewTranslate
}) {
  if (sources.length > 0 && sources.every(source => !source.found)) {
    return (
      <div className={css.emptyPanel} data-wr-source-missing>
        <h2>{t('view.sourceMissing')}</h2>
        <p>{t('view.sourceMissingNote')}</p>
        <div className={css.sourceMissingList}>
          {sources.map(source => (
            <div key={source.agent} className={css.sourceMissingRow}>
              <AgentBadge agent={source.agent} />
              <span className={css.workspacePath}>{source.path}</span>
              {source.lastError === undefined ? null : <span className={css.small}>{t('view.sourceLastError')} · {source.lastError}</span>}
            </div>
          ))}
        </div>
        <button type="button" className={css.button} onClick={onSync}>{t('view.sync')}</button>
      </div>
    )
  }
  if (syncError !== undefined) {
    return (
      <div className={css.emptyPanel} data-wr-sync-error>
        <h2>{t('view.syncFailed', { message: syncError })}</h2>
        <p>{t('view.syncFailedNote')}</p>
        <button type="button" className={css.button} onClick={onSync}>{t('view.retry')}</button>
      </div>
    )
  }
  return (
    <div className={css.emptyPanel} data-wr-empty-review>
      {syncWarning === undefined ? null : <p className={css.syncWarning} role="status" data-wr-sync-warning>{syncWarning}</p>}
      <h2>{t('view.emptyReview')}</h2>
      <p>{t('view.emptyReviewNote')}</p>
      <button type="button" className={`${css.button} ${css.primary}`} onClick={onGenerate}>{t('view.generateFirst')}</button>
    </div>
  )
}

/** One evidence drawer. */
function EvidenceDrawer({ open, sessionId, evidence, loading, error, onClose, t }: {
  open: boolean
  sessionId: string | undefined
  evidence: SessionEvidenceView | undefined
  loading: boolean
  error: string | undefined
  onClose: () => void
  t: WorkspaceReviewTranslate
}) {
  const panel = useRef<HTMLDivElement>(null)
  useModalFocus(open, panel, onClose)
  if (!open) return null
  const session = evidence?.session
  const outcome = evidence?.outcome ?? 'unconfirmed'
  const sourceAvailable = evidence?.sourceAvailable ?? false
  const subagents = evidence?.subagents ?? []
  const hasContent = session !== undefined && (session.excerpt !== '' || session.keyTurns.length > 0 || session.tools.length > 0 || session.filesTouched.length > 0 || session.commands.length > 0 || session.tests.length > 0)
  return (
    <div className={css.drawerBackdrop} data-wr-evidence-backdrop onClick={onClose}>
      <aside ref={panel} className={css.drawer} role="dialog" aria-label={t('view.drawer.title')} tabIndex={-1} data-wr-evidence-drawer onClick={event => { event.stopPropagation() }}>
        <div className={css.drawerHead}>
          <h2>{t('view.drawer.title')}</h2>
          <button type="button" className={css.linkButton} onClick={onClose} data-wr-drawer-close>{t('view.drawer.close')}</button>
        </div>
        <div className={css.drawerBody}>
          {loading ? <div className={css.loading}>{t('view.drawer.loading')}</div> : null}
          {error === undefined ? null : <div className={css.errorText}>{t('view.drawer.failed', { message: error })}</div>}
          {session === undefined ? (loading || error !== undefined ? null : <div className={css.panelEmpty} data-wr-drawer-empty>{t('view.drawer.noContent')}</div>) : (
            <>
              <h3 className={css.evidenceTitle} data-wr-evidence-session={session.id}>{session.title}</h3>
              <div className={css.evidenceMeta}>
                <AgentBadge agent={session.agent} />
                <span>{formatDateTime(session.startedAt)}</span>
                <span>·</span><span>{session.turnCount} {t('view.turns')}</span>
                <span>·</span><span>{formatDuration(session.endedAt === undefined ? 0 : Math.round((session.endedAt - session.startedAt) / 60_000))}</span>
                <span className={css.outcome} data-outcome={outcome}>{t(outcomeLabelKey(outcome) as never)}</span>
              </div>
              {hasContent ? (
                <>
                  <div className={css.evidenceBlock}><h4>{t('view.drawer.result')}</h4><div className={css.evidenceText}>{session.excerpt}</div></div>
                  <div className={css.evidenceBlock}><h4>{t('view.drawer.keyTurns')}</h4>{session.keyTurns.length === 0 ? <div className={css.small}>{t('view.drawer.noContent')}</div> : session.keyTurns.map(turn => (
                    <div className={css.quote} key={`${turn.role}:${turn.text}`}><b>{t(turn.role === 'user' ? 'view.drawer.turn.user' : 'view.drawer.turn.assistant')}</b>{turn.text}</div>
                  ))}</div>
                  <div className={css.evidenceBlock}><h4>{t('view.drawer.tools')}</h4><div className={css.toolRow}>{session.tools.map(tool => <span className={css.toolChip} key={tool}>{tool}</span>)}</div></div>
                  <div className={css.evidenceBlock}><h4>{t('view.drawer.files')}</h4><div className={css.evidenceText}>{session.filesTouched.join('\n')}</div></div>
                  <div className={css.evidenceBlock}><h4>{t('view.drawer.commands')}</h4><div className={css.evidenceText}>{session.commands.join('\n')}</div></div>
                  <div className={css.evidenceBlock}><h4>{t('view.drawer.tests')}</h4>{session.tests.map(test => <div className={css.testRow} key={test.command}><span>{test.command}</span><span data-status={test.status}>{t(`view.drawer.test.${test.status}` as never)}</span></div>)}</div>
                </>
              ) : <div className={css.panelEmpty}>{t('view.drawer.noContent')}</div>}
              <div className={css.evidenceBlock}><h4>{t('view.drawer.source')}</h4><div className={css.evidenceText}>{session.sourcePath}</div><div className={css.small}>{sourceAvailable ? t('view.drawer.sourceAvailable') : t('view.drawer.sourceMissing')}</div></div>
              {subagents.length === 0 ? null : <div className={css.evidenceBlock}><h4>{t('view.drawer.subagents')}</h4>{subagents.map(child => <div className={css.subagentRow} key={child.id}><AgentBadge agent={child.agent} /><span>{child.name ?? child.title}</span>{child.name !== undefined && child.name !== child.title ? <span className={css.small}>{child.title}</span> : null}<span className={css.small}>{shortId(child.id)}</span></div>)}</div>}
            </>
          )}
          {sessionId === undefined ? null : <div className={css.drawerId}>{shortId(sessionId)}</div>}
        </div>
        <div className={css.drawerFoot}>{t('view.drawer.readOnly')}</div>
      </aside>
    </div>
  )
}

/** The generate-review modal. */
function GenerateModal({ open, range, customFrom, customTo, preview, previewError, generating, onRange, onFrom, onTo, onConfirm, onClose, t }: {
  open: boolean
  range: ReviewRange
  customFrom: string
  customTo: string
  preview: ReviewPreview | undefined
  previewError: string | undefined
  generating: boolean
  onRange: (range: ReviewRange) => void
  onFrom: (value: string) => void
  onTo: (value: string) => void
  onConfirm: () => void
  onClose: () => void
  t: WorkspaceReviewTranslate
}) {
  const panel = useRef<HTMLDivElement>(null)
  useModalFocus(open, panel, onClose)
  if (!open) return null
  const disabled = generating || preview === undefined || preview.sessionCount === 0
  return (
    <div className={css.modalBackdrop} data-wr-generate-modal onClick={onClose}>
      <div ref={panel} className={css.modal} role="dialog" aria-label={t('view.modal.title')} tabIndex={-1} onClick={event => { event.stopPropagation() }}>
        <div className={css.modalHead}>
          <h2>{t('view.modal.title')}</h2>
          <button type="button" className={css.linkButton} onClick={onClose} data-wr-modal-close>{t('view.modal.close')}</button>
        </div>
        <div className={css.modalBody}>
          <div className={css.modalLabel}>{t('view.modal.range')}</div>
          <div className={css.rangeList}>
            {RANGES.map(option => (
              <button
                key={option}
                type="button"
                className={`${css.range} ${option === range ? css.rangeActive : ''}`}
                onClick={() => { onRange(option) }}
                data-wr-range={option}
              >{t(rangeLabelKey(option) as never)}</button>
            ))}
          </div>
          {range === 'custom' ? (
            <div className={css.customRange}>
              <label>{t('view.modal.customFrom')}<input type="date" value={customFrom} onChange={event => { onFrom(event.target.value) }} data-wr-custom-from /></label>
              <label>{t('view.modal.customTo')}<input type="date" value={customTo} onChange={event => { onTo(event.target.value) }} data-wr-custom-to /></label>
            </div>
          ) : null}
          {previewError === undefined ? null : <div className={css.errorText} data-wr-preview-error>{t('view.modal.previewFailed', { message: previewError })}</div>}
          {preview === undefined ? (previewError === undefined ? <div className={css.loading}>{t('view.loading')}</div> : null) : (
            <div className={css.scopeNote} data-wr-preview>
              <div>{t('view.modal.scopePlain', { sessions: preview.sessionCount, ai: preview.aiSessions })}</div>
              <div className={css.small}>{preview.aiEnabled ? t('view.modal.privacy') : t('view.modal.aiDisabled')}</div>
              {preview.sessionCount === 0 ? <div className={css.errorText}>{t('view.modal.noSessions')}</div> : null}
            </div>
          )}
        </div>
        <div className={css.modalFoot}>
          <button type="button" className={css.button} onClick={onClose} data-wr-modal-cancel>{t('view.modal.cancel')}</button>
          <button type="button" className={`${css.button} ${css.primary}`} onClick={onConfirm} disabled={disabled} data-wr-confirm>{t('view.modal.confirm')}</button>
        </div>
      </div>
    </div>
  )
}

/** The unmatched-session assignment tab. */
function UnmatchedView({ sessions, workspaces, error, onAssign, t }: {
  sessions: SessionEvidenceView['session'][]
  workspaces: WorkspaceView[]
  error: string | undefined
  onAssign: (sessionId: string, workspaceId: string) => void
  t: WorkspaceReviewTranslate
}) {
  return (
    <div className={css.unmatched} data-wr-unmatched>
      <div className={css.sectionHead}><h2>{t('view.unmatched.title')}</h2><span className={css.sectionNote}>{t('view.unmatched.note')}</span></div>
      {error === undefined ? null : <ErrorBanner message={t('view.unmatched.failed', { message: error })} anchor="data-wr-assign-error" />}
      {sessions.length === 0 ? <div className={css.panelEmpty}>{t('view.unmatched.empty')}</div> : (
        <div className={css.list}>
          {sessions.map(session => (
            <div className={css.unmatchedRow} key={session.id} data-wr-unmatched-session={session.id}>
              <AgentBadge agent={session.agent} />
              <div className={css.unmatchedMain}>
                <div className={css.unmatchedTitle}>{session.title}</div>
                <div className={css.small}>{session.cwd} · {session.sourcePath}</div>
              </div>
              <label className={css.assignLabel}>
                {t('view.unmatched.assignTo')}
                <select defaultValue="" onChange={event => { if (event.target.value !== '') onAssign(session.id, event.target.value) }} data-wr-assign={session.id}>
                  <option value="">{t('view.unmatched.unassigned')}</option>
                  {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
              </label>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** A small deterministic source/agent summary for the workspace line. */
function WorkspaceAgents({ review, t }: { review: Review; t: WorkspaceReviewTranslate }) {
  if (review.deterministic.sources.length === 0) return null
  return (
    <span className={css.workspaceAgents}>
      {review.deterministic.sources.map(source => (
        <span key={source.agent} className={css.agentCount}><AgentBadge agent={source.agent} /> {source.count}</span>
      ))}
      <span className={css.small}>{t('view.sourcesMeta')}</span>
    </span>
  )
}

/** The workspace-review page body. */
export function WorkspaceReviewView({
  call, running, onChanged, pageContext, viewport, t,
}: WorkspaceReviewViewProps) {
  const tx = t as unknown as Translate
  const [workspaces, setWorkspaces] = useState<WorkspaceView[]>([])
  const [reviews, setReviews] = useState<ReviewSummary[]>([])
  const [review, setReview] = useState<Review>()
  const [sources, setSources] = useState<SourceInfo[]>([])
  const [settings, setSettings] = useState<ReviewSettings>()
  const [unmatched, setUnmatched] = useState<SessionEvidenceView['session'][]>([])
  const [selected, setSelected] = useState('')
  const [selectedReview, setSelectedReview] = useState<string>()
  const [tab, setTab] = useState<Tab>('report')
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string>()
  const [syncError, setSyncError] = useState<string>()
  const [syncWarning, setSyncWarning] = useState<string>()
  const [syncRunning, setSyncRunning] = useState(false)
  const [newSinceReview, setNewSinceReview] = useState(0)
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string>()
  const [addError, setAddError] = useState<string>()
  const [assignError, setAssignError] = useState<string>()
  const [notice, setNotice] = useState('')
  const [modalOpen, setModalOpen] = useState(false)
  const [range, setRange] = useState<ReviewRange>('last30')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [preview, setPreview] = useState<ReviewPreview>()
  const [previewError, setPreviewError] = useState<string>()
  const [drawerId, setDrawerId] = useState<string>()
  const [drawer, setDrawer] = useState<SessionEvidenceView>()
  const [drawerLoading, setDrawerLoading] = useState(false)
  const [drawerError, setDrawerError] = useState<string>()
  const autoSynced = useRef(new Set<string>())
  const syncRunningRef = useRef(false)
  const tRef = useRef(t)
  tRef.current = t
  const selectedRef = useRef('')
  selectedRef.current = selected

  const loadAll = useCallback(async () => {
    setLoading(true)
    const [workspaceOutcome, sourceOutcome, settingsOutcome] = await Promise.all([
      call('listWorkspaces', {}),
      call('listSources', {}),
      call('settings', {}),
    ])
    const list = valueOf<WorkspaceView[]>(workspaceOutcome)
    if (list === undefined) { setLoadError(messageOf(workspaceOutcome) ?? tRef.current('view.loadFailedDetail')); setLoading(false); return }
    setWorkspaces(list)
    setSources(valueOf<SourceInfo[]>(sourceOutcome) ?? [])
    const nextSettings = valueOf<ReviewSettings>(settingsOutcome)
    if (nextSettings !== undefined) setSettings(nextSettings)
    setSelected(current => current !== '' && list.some(item => item.id === current) ? current : (list[0]?.id ?? ''))
    setLoadError(undefined)
    setLoading(false)
  }, [call])

  const loadReviews = useCallback(async (workspaceId: string, preferred?: string) => {
    const outcome = await call('listReviews', { workspaceId })
    const list = valueOf<ReviewSummary[]>(outcome)
    if (list === undefined) { setLoadError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail')); return }
    setReviews(list)
    const target = preferred !== undefined && list.some(item => item.id === preferred) ? preferred : list[0]?.id
    if (target === undefined) { setSelectedReview(undefined); setReview(undefined); return }
    setSelectedReview(target)
    const detail = await call('getReview', { reviewId: target })
    const value = valueOf<Review>(detail)
    if (value === undefined) { setLoadError(messageOf(detail) ?? tRef.current('view.loadFailedDetail')); return }
    setReview(value)
  }, [call])

  const loadUnmatched = useCallback(async () => {
    const outcome = await call('listUnmatchedSessions', {})
    const list = valueOf<SessionEvidenceView['session'][]>(outcome)
    if (list === undefined) { setAssignError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail')); return }
    setUnmatched(list)
    setAssignError(undefined)
  }, [call])

  useEffect(() => { void loadAll() }, [loadAll])
  useEffect(() => {
    if (selected === '') { setReview(undefined); setReviews([]); return }
    void loadReviews(selected)
  }, [selected, loadReviews])
  useEffect(() => {
    if (tab !== 'unmatched') return
    void loadUnmatched()
  }, [tab, loadUnmatched])
  useEffect(() => onChanged(() => {
    if (selectedRef.current !== '') {
      void loadReviews(selectedRef.current)
      void loadUnmatched()
    }
    void loadAll()
  }), [onChanged, loadAll, loadReviews, loadUnmatched])
  useEffect(() => {
    const disposer = pageContext.report({
      label: review?.workspaceName ?? tRef.current('app.name'),
      ...(review === undefined ? {} : { record: { appId: 'workspace-review', kind: 'review', id: review.id }, view: 'report' }),
    })
    return disposer
  }, [pageContext, review?.id, review?.workspaceName])
  useEffect(() => viewport.report({ key: `${tab}:${selected}`, ready: !loading }), [viewport, tab, selected, loading])

  const syncOne = useCallback(async (workspaceId: string) => {
    /* v8 ignore next -- an empty workspace has no action, and the button is disabled while a sync runs */
    if (workspaceId === '' || syncRunningRef.current) return
    syncRunningRef.current = true
    setSyncRunning(true)
    setSyncError(undefined)
    setSyncWarning(undefined)
    try {
      const outcome = await call('syncWorkspace', { workspaceId })
      const value = valueOf<{ newSinceReview: number; errors?: string[]; truncatedSources?: string[]; unmatchedTruncated?: boolean }>(outcome)
      if (value === undefined) { setSyncError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail')); return }
      if (value.errors !== undefined && value.errors.length > 0) setSyncError(value.errors.join('; '))
      const warnings: string[] = []
      if (value.truncatedSources !== undefined && value.truncatedSources.length > 0) {
        warnings.push(tRef.current('view.sourcesTruncated', { sources: value.truncatedSources.join(', ') }))
      }
      if (value.unmatchedTruncated === true) warnings.push(tRef.current('view.unmatchedTruncated'))
      setSyncWarning(warnings.length === 0 ? undefined : warnings.join(' '))
      setNewSinceReview(value.newSinceReview)
      // A sync started for A must not paint A's reviews after the human moved
      // to B. The ref is the live selection; only the still-selected workspace
      // gets the follow-up read.
      if (selectedRef.current === workspaceId) {
        await loadReviews(workspaceId, selectedReview ?? undefined)
      }
      await loadAll()
      autoSynced.current.add(workspaceId)
    } finally {
      syncRunningRef.current = false
      setSyncRunning(false)
    }
  }, [call, loadAll, loadReviews, selectedReview])

  useEffect(() => {
    if (selected === '' || autoSynced.current.has(selected) || syncRunningRef.current) return
    void syncOne(selected)
  }, [selected, syncOne])

  useEffect(() => {
    if (!modalOpen || selected === '') return
    let live = true
    setPreview(undefined)
    setPreviewError(undefined)
    void (async () => {
      const outcome = await call('previewReview', {
        workspaceId: selected,
        range,
        ...(range === 'custom' ? { from: customFrom, to: customTo } : {}),
      })
      if (!live) return
      const value = valueOf<ReviewPreview>(outcome)
      if (value === undefined) setPreviewError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail'))
      else setPreview(value)
    })()
    return () => { live = false }
  }, [modalOpen, selected, range, customFrom, customTo, call])

  const openGenerate = useCallback(() => {
    /* v8 ignore next -- the generate controls are disabled while no workspace is selected */
    if (selected === '') return
    setGenerateError(undefined)
    setModalOpen(true)
  }, [selected])
  const confirmGenerate = useCallback(async () => {
    setModalOpen(false)
    setGenerating(true)
    setGenerateError(undefined)
    try {
      const outcome = await call('generateReview', {
        workspaceId: selected,
        range,
        ...(range === 'custom' ? { from: customFrom, to: customTo } : {}),
      })
      const value = valueOf<Review>(outcome)
      if (value === undefined) { setGenerateError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail')); return }
      setReview(value)
      setSelectedReview(value.id)
      setNewSinceReview(0)
      setNotice(tRef.current('view.generated', { count: value.sessionIds.length }))
      await loadReviews(selected, value.id)
      await loadAll()
    } finally {
      setGenerating(false)
    }
  }, [selected, range, customFrom, customTo, call, loadReviews, loadAll])
  const cancelGeneration = useCallback(async () => {
    const outcome = await call('cancelGenerate', { workspaceId: selected })
    /* v8 ignore next 4 -- a refused cancellation is a host contract edge */
    if (outcome.status === 'success') setNotice(tRef.current('view.generationCancelled'))
    else setGenerateError(messageOf(outcome) ?? tRef.current('view.cancelFailed'))
  }, [selected, call])

  const openEvidence = useCallback(async (sessionId: string) => {
    setDrawerId(sessionId)
    setDrawer(undefined)
    setDrawerError(undefined)
    setDrawerLoading(true)
    try {
      const outcome = await call('getSessionEvidence', { sessionId })
      const value = valueOf<SessionEvidenceView>(outcome)
      if (value === undefined) setDrawerError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail'))
      else setDrawer(value)
    } finally {
      setDrawerLoading(false)
    }
  }, [call])
  const closeDrawer = useCallback(() => { setDrawerId(undefined); setDrawer(undefined); setDrawerError(undefined) }, [])

  const [addOpen, setAddOpen] = useState(false)
  const [addRoot, setAddRoot] = useState('')
  const [addName, setAddName] = useState('')
  const openAddWorkspace = useCallback(() => {
    setAddRoot('')
    setAddName('')
    setAddError(undefined)
    setAddOpen(true)
  }, [])
  const addWorkspace = useCallback(async () => {
    const root = addRoot.trim()
    if (root === '') { setAddError(tRef.current('view.addWorkspaceRoot')); return }
    const name = addName.trim()
    const outcome = await call('createWorkspace', { root, ...(name === '' ? {} : { name }) })
    if (outcome.status !== 'success') { setAddError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail')); return }
    const created = valueOf<WorkspaceView>(outcome) ?? valueOf<{ id: string }>(outcome)
    setAddError(undefined)
    setAddOpen(false)
    await loadAll()
    if (created !== undefined) setSelected(created.id)
  }, [addName, addRoot, call, loadAll])

  const assign = useCallback(async (sessionId: string, workspaceId: string) => {
    const outcome = await call('assignSession', { sessionId, workspaceId })
    if (outcome.status !== 'success') { setAssignError(messageOf(outcome) ?? tRef.current('view.loadFailedDetail')); return }
    setAssignError(undefined)
    setNotice(tRef.current('view.unmatched.assigned', { name: workspaces.find(item => item.id === workspaceId)?.name ?? workspaceId }))
    await loadUnmatched()
    await loadAll()
  }, [call, loadAll, loadUnmatched, workspaces])

  const syncCurrent = useCallback(() => { void syncOne(selected) }, [selected, syncOne])
  const retry = useCallback(() => {
    void loadAll()
    /* v8 ignore next -- the retry action is only rendered with a selected workspace */
    if (selectedRef.current !== '') void loadReviews(selectedRef.current)
    void loadUnmatched()
  }, [loadAll, loadReviews, loadUnmatched])
  const workspace = useMemo(() => workspaces.find(item => item.id === selected), [workspaces, selected])
  const tabs = useMemo(() => [
    { id: 'report', label: t('view.tab.report') },
    { id: 'unmatched', label: t('view.tab.unmatched'), dot: unmatched.length > 0 },
  ], [t, unmatched.length])

  if (loading && workspaces.length === 0) return <div className={css.page} data-wr-loading>{t('view.loading')}</div>

  return (
    <div className={css.page} data-workspace-review>
      <TabBar
        tabs={tabs}
        active={tab}
        onSelect={id => { setTab(id === 'unmatched' ? 'unmatched' : 'report') }}
        data-wr-tabs
        tools={(
          <>
            <button type="button" className={css.button} onClick={syncCurrent} disabled={syncRunning || generating || selected === ''} data-wr-sync>
              {syncRunning ? t('view.syncing') : t('view.sync')}
            </button>
            {syncRunning ? <button type="button" className={css.button} onClick={() => { void call('cancelSync', { workspaceId: selected }) }} data-wr-cancel-sync>{t('view.cancelSync')}</button> : null}
            {generating ? <button type="button" className={css.button} onClick={() => { void cancelGeneration() }} data-wr-cancel-generate>{t('view.cancelGenerate')}</button> : null}
            <button type="button" className={`${css.button} ${css.primary}`} onClick={openGenerate} disabled={generating || selected === '' || running} data-wr-generate>{generating ? t('view.generating') : t('view.generate')}</button>
          </>
        )}
      />
      {loadError === undefined ? null : (
        <div className={css.loadError} data-wr-load-error>
          <span>{t('view.loadFailed', { message: loadError })}</span>
          <button type="button" className={css.button} onClick={retry}>{t('view.retry')}</button>
        </div>
      )}
      {generateError === undefined ? null : <ErrorBanner message={t('view.generateFailed', { message: generateError })} anchor="data-wr-generate-error" />}
      <div className={css.mobileBar}>
        <label htmlFor="wr-mobile-workspace">{t('view.workspaceLabel')}</label>
        <select id="wr-mobile-workspace" data-wr-mobile-workspace value={selected} onChange={event => { setSelected(event.target.value) }} disabled={workspaces.length === 0}>
          {workspaces.length === 0 ? <option value="">{t('view.noWorkspaces')}</option> : workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <button type="button" className={css.iconButton} onClick={() => { openAddWorkspace() }} aria-label={t('view.addWorkspace')} data-wr-mobile-add>+</button>
        {selected === '' || reviews.length === 0 ? null : (
          <>
            <label htmlFor="wr-mobile-review">{t('view.historyTitle')}</label>
            <select id="wr-mobile-review" data-wr-mobile-review value={selectedReview ?? ''} onChange={event => { const id = event.target.value; if (id === '') return; setSelectedReview(id); const outcome = call('getReview', { reviewId: id }); void outcome.then(result => { const value = valueOf<Review>(result); if (value === undefined) setLoadError(messageOf(result) ?? tRef.current('view.loadFailedDetail')); else setReview(value) }) }}>
              {reviews.map(item => <option key={item.id} value={item.id}>{rangeText(item.from, item.to, tx)}</option>)}
            </select>
          </>
        )}
      </div>
      <div className={css.body}>
        <aside className={css.rail} data-wr-rail>
          <div className={css.railTitle}><span>{t('view.workspaceTitle')}</span><span className={css.spacer} /><button type="button" className={css.iconButton} onClick={() => { openAddWorkspace() }} aria-label={t('view.addWorkspace')} data-wr-add>+</button></div>
          {workspaces.length === 0 ? <div className={css.railEmpty} data-wr-empty-workspaces>{t('view.noWorkspaces')}</div> : workspaces.map(item => (
            <button key={item.id} type="button" className={`${css.workspaceItem} ${item.id === selected ? css.workspaceActive : ''}`} onClick={() => { setSelected(item.id) }} data-wr-workspace={item.id}>
              <span className={css.workspaceItemName}>{item.name}</span>
              <span className={css.workspaceItemMeta}>{item.lastReviewAt === undefined ? t('view.lastReviewNever') : t('view.lastReviewAt', { time: formatDateTime(item.lastReviewAt) })} · {t('view.workspaceSessions', { count: item.sessionCount })}</span>
            </button>
          ))}
          {addError === undefined ? null : <ErrorBanner message={t('view.addFailed', { message: addError })} anchor="data-wr-add-error" />}
          {selected === '' ? null : (
            <>
              <div className={css.divider} />
              <div className={css.railTitle}><span>{t('view.historyTitle')}</span></div>
              {reviews.length === 0 ? <div className={css.railEmpty}>{t('view.emptyReview')}</div> : reviews.map(item => (
                <button key={item.id} type="button" className={`${css.reviewItem} ${item.id === selectedReview ? css.reviewActive : ''}`} onClick={() => { setSelectedReview(item.id); const outcome = call('getReview', { reviewId: item.id }); void outcome.then(result => { const value = valueOf<Review>(result); if (value === undefined) setLoadError(messageOf(result) ?? tRef.current('view.loadFailedDetail')); else setReview(value) }) }} data-wr-review={item.id}>
                  <span className={css.reviewRange}>{rangeText(item.from, item.to, tx)}</span>
                  <span className={css.reviewMeta}>{t(rangeLabelKey(item.range) as never)} · {formatDateTime(item.generatedAt)}</span>
                </button>
              ))}
              {settings === undefined ? null : <div className={css.railFoot}>{t('view.retention', { count: settings.reviewRetention })}</div>}
            </>
          )}
        </aside>
        <main className={css.content}>
          {tab === 'unmatched' ? <UnmatchedView sessions={unmatched} workspaces={workspaces} error={assignError} onAssign={(sessionId, workspaceId) => { void assign(sessionId, workspaceId) }} t={t} /> : (
            review === undefined ? (
              selected === '' ? (
                <div className={css.emptyPanel} data-wr-first-run>
                  <h2>{t('view.firstRunTitle')}</h2>
                  <p>{t('view.firstRunNote')}</p>
                  <button type="button" className={`${css.button} ${css.primary}`} onClick={() => { openAddWorkspace() }} data-wr-first-run-add>{t('view.addWorkspace')}</button>
                  {addError === undefined ? null : <ErrorBanner message={t('view.addFailed', { message: addError })} anchor="data-wr-add-error" />}
                </div>
              ) : <EmptyReview sources={sources} syncError={syncError} syncWarning={syncWarning} onGenerate={openGenerate} onSync={syncCurrent} t={t} />
            ) : (
              <ReportView review={review} workspace={workspace} newSinceReview={newSinceReview} syncError={syncError} syncWarning={syncWarning} onOpen={id => { void openEvidence(id) }} onGenerate={openGenerate} onSync={syncCurrent} t={t} />
            )
          )}
        </main>
      </div>
      <Modal
        open={addOpen}
        onClose={() => { setAddOpen(false) }}
        title={t('view.addWorkspace')}
        closeLabel={t('view.drawer.close')}
        footer={(
          <>
            <Button size="sm" variant="ghost" onClick={() => { setAddOpen(false) }}>{t('view.modal.cancel')}</Button>
            <Button size="sm" variant="primary" onClick={() => { void addWorkspace() }} data-wr-add-confirm>{t('view.addWorkspace')}</Button>
          </>
        )}
      >
        <div className={css.addForm}>
          <label>{t('view.addWorkspaceRoot')}<input autoFocus value={addRoot} onChange={event => { setAddRoot(event.target.value) }} placeholder="/home/you/project" data-wr-add-root /></label>
          <label>{t('view.addWorkspaceName')}<input value={addName} onChange={event => { setAddName(event.target.value) }} data-wr-add-name /></label>
          {addError === undefined ? null : <ErrorBanner message={t('view.addFailed', { message: addError })} anchor="data-wr-add-error" />}
        </div>
      </Modal>
      <Notice message={notice} />
      <GenerateModal
        open={modalOpen}
        range={range}
        customFrom={customFrom}
        customTo={customTo}
        preview={preview}
        previewError={previewError}
        generating={generating}
        onRange={setRange}
        onFrom={setCustomFrom}
        onTo={setCustomTo}
        onConfirm={() => { void confirmGenerate() }}
        onClose={() => { setModalOpen(false) }}
        t={t}
      />
      <EvidenceDrawer
        open={drawerId !== undefined}
        sessionId={drawerId}
        evidence={drawer}
        loading={drawerLoading}
        error={drawerError}
        onClose={closeDrawer}
        t={t}
      />
    </div>
  )
}

/** A tiny exported helper used by the node/plugin tests to prove the page is wired. */
export function pageTitle(t: WorkspaceReviewTranslate): string {
  return t('app.name')
}
