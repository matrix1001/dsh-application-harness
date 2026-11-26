import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactElement } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import type { CallOutcome } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { outcomeFailure, outcomeValue, type FailureKind } from '@matrix1001/dsh-application-harness-client-chrome'
import { NS } from './locales.ts'
import css from './HomeView.module.css'

/** The translate face this page needs. */
export type HomeTranslate = TranslateNS<'home'>

/** The props of the registered page. */
export interface HomePageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface HomeViewProps extends ApplicationViewProps { t: HomeTranslate }

/** One previewed entry in a card. */
interface PreviewItem { readonly id: string; readonly title: string; readonly at?: number; readonly dueDate?: string }
/** Why one card could not be read, as the host bounded it. */
interface CardFailure { readonly kind: FailureKind; readonly code?: string; readonly message?: string }
/** The inbox card. */
interface InboxCard { readonly available: boolean; readonly failure?: CardFailure; readonly unseen?: number; readonly unread?: number; readonly saved?: number; readonly recent?: readonly PreviewItem[] }
/** The todo card. */
interface TodoCard { readonly available: boolean; readonly failure?: CardFailure; readonly open?: number; readonly today?: number; readonly overdue?: number; readonly recent?: readonly PreviewItem[] }
/** The notes card. */
interface NotesCard { readonly available: boolean; readonly failure?: CardFailure; readonly total?: number; readonly recent?: readonly PreviewItem[] }
/** Every card, read in one call. */
interface Overview { readonly generatedAt: number; readonly inbox: InboxCard; readonly todo: TodoCard; readonly notes: NotesCard }
/** One received notice. */
interface Activity { readonly id: string; readonly appId: string; readonly type: string; readonly at: number; readonly count: number }

/** A `YYYY-MM-DD` date in the local zone (the todo app's due-date format). */
function localDate(now: number): string {
  const date = new Date(now)
  return `${String(date.getFullYear())}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function dayLabel(value: number, language: string): string {
  return new Intl.DateTimeFormat(language, { month: 'numeric', day: 'numeric' }).format(new Date(value))
}

/** When one notice happened, in the reader's language. */
function relativeLabel(at: number, now: number, language: string, t: HomeTranslate): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000))
  if (minutes < 1) return t('view.justNow')
  if (minutes < 60) return t('view.minutesAgo', { count: String(minutes) })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('view.hoursAgo', { count: String(hours) })
  return dayLabel(at, language)
}

/** The localized label of one due date. */
function dueLabel(dueDate: string, today: string, language: string, t: HomeTranslate): string {
  if (dueDate === today) return t('view.dueToday')
  if (dueDate < today) return t('view.overdue')
  return dayLabel(Date.parse(`${dueDate}T00:00:00`), language)
}

/** The display name of one publishing application. */
function appName(appId: string, t: HomeTranslate): string {
  if (appId === 'inbox') return t('view.inboxName')
  if (appId === 'todo') return t('view.todoName')
  if (appId === 'notes') return t('view.notesName')
  return appId
}

/** Strip the Markdown heading marker the notes list already hides. */
function displayTitle(title: string): string {
  return title.replace(/^#{1,6}\s+/u, '')
}

/** When one snapshot was read, in the reader's own clock. */
function timeLabel(value: number, language: string): string {
  return new Intl.DateTimeFormat(language, { timeStyle: 'short' }).format(new Date(value))
}

/** The localized reason of one card failure; the kind decides the words. */
function failureReason(failure: CardFailure | undefined, t: HomeTranslate): string {
  switch (failure?.kind) {
    case 'not-approved': return t('view.cardFailureNotApproved')
    case 'undeclared': return t('view.cardFailureUndeclared')
    case 'not-open':
    case 'caller-not-declared': return t('view.cardFailureClosed')
    case 'denied': return t('view.cardFailureDenied')
    case 'confirmation': return t('view.cardFailureConfirmation')
    case 'transport': return t('view.cardFailureTransport')
    default: return t('view.cardFailureOther')
  }
}

/** The failure one card renders; absent while the card is readable. */
interface CardFailureView {
  readonly kind: FailureKind
  readonly label: string
  readonly code?: string
  readonly message?: string
  readonly canRetry: boolean
}

/** Project the host's bounded failure onto the card's own copy and actions. */
function cardFailureView(card: { readonly available?: boolean; readonly failure?: CardFailure } | undefined, t: HomeTranslate): CardFailureView | undefined {
  if (card?.available !== false) return undefined
  const kind = card.failure?.kind ?? 'other'
  return {
    kind,
    label: failureReason({ kind }, t),
    ...(card.failure?.code === undefined ? {} : { code: card.failure.code }),
    ...(card.failure?.message === undefined ? {} : { message: card.failure.message }),
    // A missing/undeclared grant is not fixed by repeating the same read; the
    // card says what to fix instead of offering a retry that cannot succeed.
    canRetry: kind !== 'not-approved' && kind !== 'undeclared',
  }
}

/** One snapshot card: counts, an optional second line and a short preview. */
function Card(props: {
  readonly id: string
  readonly title: string
  readonly state: 'loading' | 'ready' | 'unavailable' | 'unread'
  readonly counts: string
  readonly secondary?: string
  readonly items: ReadonlyArray<{ readonly id: string; readonly title: string; readonly meta?: string }>
  readonly emptyText: string
  readonly unavailableText: string
  readonly unreadText: string
  readonly loadingText: string
  readonly onOpen: () => void
  readonly onOpenRecord: (id: string) => void
  readonly onRetry: () => void
  readonly openLabel: string
  readonly retryLabel: string
  readonly statusLabel: string
  readonly failure?: CardFailureView
  readonly urgent?: string
}): ReactElement {
  const ready = props.state === 'ready'
  const titleId = `home-${props.id}-title`
  const countsId = `home-${props.id}-counts`
  return (
    <section className={css.card} data-home-card={props.id} data-home-card-state={props.state} aria-labelledby={titleId}>
      <h3 className={css.cardHeading} id={titleId}>
        <button type="button" className={css.cardHead} onClick={props.onOpen} data-home-card-open={props.id} aria-describedby={countsId}>
          <span className={css.cardTitle}>{props.title}</span>
          <span className={css.chevron} aria-hidden="true">›</span>
        </button>
      </h3>
      <span className={css.counts} id={countsId}>
        {props.state === 'loading' ? props.loadingText : props.state === 'unavailable' ? props.unavailableText : props.state === 'unread' ? props.unreadText : props.counts}
        {props.urgent === undefined ? null : <span className={css.overdue} data-home-todo-overdue> · {props.urgent}</span>}
      </span>
      {props.secondary === undefined ? null : <span className={css.secondary}>{props.secondary}</span>}
      {props.failure === undefined ? null : (
        <div className={css.cardFailure} data-home-card-failure={props.failure.kind}>
          <span className={css.cardFailureReason}>{props.failure.label}</span>
          {props.failure.canRetry
            ? <button type="button" className={css.retry} onClick={props.onRetry} data-home-card-retry={props.id}>{props.retryLabel}</button>
            : null}
          {props.failure.code === undefined && props.failure.message === undefined
            ? null
            : (
              <details className={css.diagnostic} data-home-card-status={props.id}>
                <summary>{props.statusLabel}</summary>
                {props.failure.code === undefined ? null : <code>{props.failure.code}</code>}
                {props.failure.message === undefined ? null : <p>{props.failure.message}</p>}
              </details>
            )}
        </div>
      )}
      <span className={css.items}>
        {!ready ? null : props.items.length === 0
          ? <span className={css.muted}>{props.emptyText}</span>
          : props.items.map(item => (
            <button key={item.id} type="button" className={css.item} onClick={() => { props.onOpenRecord(item.id) }} data-home-item={item.id}>
              <span className={css.itemTitle}>{item.title}</span>
              {item.meta === undefined ? null : <span className={css.itemMeta}>{item.meta}</span>}
            </button>
          ))}
      </span>
      <footer className={css.cardFoot}>
        <button type="button" className={css.cardOpen} onClick={props.onOpen} data-home-card-footer-open={props.id}>{props.openLabel}</button>
      </footer>
    </section>
  )
}

/** The registered page: bind the dictionary and render the dashboard. */
export function HomePage({ locale, ...props }: HomePageProps): ReactElement {
  const snapshot = useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <HomeView {...props} t={locale.bind(NS)} language={snapshot.active} />
}

/**
 * The home page: a live activity strip over three snapshot cards. The strip is
 * fed by change notices (the host records them), the cards are read from the
 * owning applications on every load — no value is cached across reads.
 */
export function HomeView({ call, onChanged, navigation, t, language = 'zh' }: HomeViewProps & { language?: string }): ReactElement {
  const [overview, setOverview] = useState<Overview>()
  const [activities, setActivities] = useState<readonly Activity[]>([])
  const [readFailure, setReadFailure] = useState<{ readonly kind: FailureKind; readonly code?: string; readonly message?: string }>()
  const [overviewFailure, setOverviewFailure] = useState<{ readonly kind: FailureKind; readonly code?: string; readonly message?: string }>()
  const [activityFailure, setActivityFailure] = useState<{ readonly kind: FailureKind; readonly code?: string; readonly message?: string }>()
  const [loaded, setLoaded] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const tRef = useRef(t)
  tRef.current = t
  const hasDataRef = useRef(false)
  // Every read takes the next ticket; a response that comes back after a newer
  // read started is dropped instead of overwriting the newer snapshot.
  const requestSeq = useRef(0)

  const load = useCallback(async () => {
    const seq = ++requestSeq.current
    setRefreshing(true)
    try {
      let overviewOutcome: CallOutcome
      let activityOutcome: CallOutcome
      try {
        [overviewOutcome, activityOutcome] = await Promise.all([
          call('overview', {}),
          call('activity', {}),
        ])
      } catch {
        if (seq !== requestSeq.current) return
        // A rejected call never produced an Outcome; treat it like a broken
        // carrier and keep whatever this page already read.
        const failure = { kind: 'transport' as FailureKind }
        if (hasDataRef.current) {
          setOverviewFailure(failure)
          setActivityFailure(failure)
          setReadFailure(undefined)
        } else setReadFailure(failure)
        setLoaded(true)
        return
      }
      if (seq !== requestSeq.current) return
      const nextOverview = outcomeValue<Overview>(overviewOutcome)
      const nextActivity = outcomeValue<{ activities?: readonly Activity[] }>(activityOutcome)
      const detail = (outcome: CallOutcome): { readonly kind: FailureKind; readonly code?: string; readonly message?: string } => {
        const failure = outcomeFailure(outcome)
        return {
          kind: failure.kind,
          ...(failure.code === undefined ? {} : { code: failure.code }),
          ...(failure.message === undefined ? {} : { message: failure.message }),
        }
      }
      const overviewMissing = nextOverview === undefined
      const activityMissing = nextActivity === undefined
      setOverviewFailure(overviewMissing ? detail(overviewOutcome) : undefined)
      setActivityFailure(activityMissing ? detail(activityOutcome) : undefined)
      if (overviewMissing && activityMissing) {
        // Keep the last successful snapshot visible; only a first read that
        // never produced data becomes the page-level "not read" state.
        if (hasDataRef.current) setReadFailure(undefined)
        else setReadFailure(detail(overviewOutcome))
        setLoaded(true)
        return
      }
      if (nextOverview !== undefined) { hasDataRef.current = true; setOverview(nextOverview) }
      if (nextActivity?.activities !== undefined) { hasDataRef.current = true; setActivities(nextActivity.activities) }
      setReadFailure(undefined)
      setLoaded(true)
    } finally {
      // Only the newest read owns the busy state; an older response settling
      // late must not clear the spinner the newer one still needs.
      if (seq === requestSeq.current) setRefreshing(false)
    }
  }, [call])

  useEffect(() => { void load() }, [load])
  useEffect(() => onChanged(() => { void load() }), [load, onChanged])
  const retry = useCallback((): void => { void load() }, [load])

  const now = Date.now()
  const today = localDate(now)
  const inbox = overview?.inbox
  const todo = overview?.todo
  const notes = overview?.notes
  const cardState = (available: boolean | undefined): 'loading' | 'ready' | 'unavailable' | 'unread' => {
    // A later refresh failure must not erase what was already read; the cards
    // keep their counts and the failure is reported on its own.
    if (readFailure !== undefined && overview === undefined) return 'unread'
    if (overview === undefined) return overviewFailure !== undefined ? 'unread' : 'unavailable'
    if (!loaded) return 'loading'
    return available === true ? 'ready' : 'unavailable'
  }
  const inboxCounts = inbox === undefined
    ? ''
    : t('view.inboxCounts', { unread: String(inbox.unread ?? 0) })
  const todoCounts = todo === undefined
    ? ''
    : t('view.todoCounts', { open: String(todo.open ?? 0), today: String(todo.today ?? 0) })
  const notesCounts = notes === undefined ? '' : t('view.notesCounts', { total: String(notes.total ?? 0) })
  const inboxFailure = cardFailureView(inbox, t)
  const todoFailure = cardFailureView(todo, t)
  const notesFailure = cardFailureView(notes, t)

  return (
    <div className={css.page} data-home-page>
      <header className={css.head}>
        <div className={css.headMain}>
          <h1 className={css.title}>{t('view.overview')}</h1>
          <span className={css.meta}>{new Intl.DateTimeFormat(language, { dateStyle: 'full' }).format(new Date(now))}</span>
        </div>
        <div className={css.tools} data-home-tools>
          {overview === undefined ? null : (
            <time className={css.meta} dateTime={new Date(overview.generatedAt).toISOString()} data-home-updated>
              {t('view.updatedAt', { time: timeLabel(overview.generatedAt, language) })}
            </time>
          )}
          <button type="button" className={css.refreshButton} onClick={() => { void load() }} disabled={refreshing} aria-busy={refreshing} data-home-refresh>
            {refreshing ? t('view.refreshing') : t('view.refresh')}
          </button>
        </div>
      </header>
      <section className={css.activity} data-home-activity data-empty={activities.length === 0 && readFailure === undefined && activityFailure === undefined ? 'true' : 'false'} aria-labelledby="home-activity-title">
        <h2 className={css.activityHead} id="home-activity-title"><span className={css.dot} aria-hidden="true" /><span>{t('view.activity')}</span></h2>
        {readFailure !== undefined && overview === undefined
          ? (
            <div className={css.activityState} data-home-read-failure={readFailure.kind}>
              <span>{readFailure.kind === 'not-approved' || readFailure.kind === 'undeclared' ? t('view.notRead') : t('view.readFailed')}</span>
              {readFailure.kind === 'not-approved' || readFailure.kind === 'undeclared' ? null : (
                <button type="button" className={css.retry} onClick={() => { void load() }} data-home-read-retry>{t('view.retry')}</button>
              )}
              {readFailure.kind === 'not-approved' || readFailure.kind === 'undeclared' ? null : (
                <details className={css.diagnostic}>
                  <summary>{t('view.diagnostic')}</summary>
                  {readFailure.code === undefined ? null : <code>{readFailure.code}</code>}
                  {readFailure.message === undefined ? null : <p>{readFailure.message}</p>}
                </details>
              )}
            </div>
          )
          : activityFailure !== undefined && activities.length === 0
          ? (
            <div className={css.activityState} data-home-activity-failure={activityFailure.kind}>
              <span>{t('view.readFailed')}</span>
              <button type="button" className={css.retry} onClick={() => { void load() }} data-home-activity-retry>{t('view.retry')}</button>
              {activityFailure.code === undefined && activityFailure.message === undefined ? null : (
                <details className={css.diagnostic}>
                  <summary>{t('view.diagnostic')}</summary>
                  {activityFailure.code === undefined ? null : <code>{activityFailure.code}</code>}
                  {activityFailure.message === undefined ? null : <p>{activityFailure.message}</p>}
                </details>
              )}
            </div>
          )
          : !loaded
          ? <p className={css.muted} data-home-activity-loading>{t('view.loading')}</p>
          : activities.length === 0
          ? <p className={css.muted} data-home-activity-empty>{t('view.activityEmpty')}</p>
          : activities.map(item => (
            <button key={item.id} type="button" className={css.activityRow} data-home-activity-row={item.id} onClick={() => { navigation?.open({ appId: item.appId }) }}>
              <span className={css.activityText}>{item.count === 1 ? t('view.activityOne', { app: appName(item.appId, t) }) : t('view.activityLine', { app: appName(item.appId, t), count: String(item.count) })}</span>
              <span className={css.meta}>{relativeLabel(item.at, now, language, t)}</span>
            </button>
          ))}
        {activityFailure !== undefined && activities.length > 0 ? (
          <div className={css.activityState} role="status" data-home-activity-stale={activityFailure.kind}>
            <span>{t('view.readFailed')}</span>
            <button type="button" className={css.retry} onClick={() => { void load() }} data-home-activity-retry>{t('view.retry')}</button>
          </div>
        ) : null}
      </section>
      {overviewFailure === undefined || readFailure !== undefined ? null : (
        <div className={css.overviewFailure} role="alert" data-home-overview-failure>
          <span>{t('view.readFailed')}</span>
          <button type="button" className={css.retry} onClick={() => { void load() }} data-home-overview-retry>{t('view.retry')}</button>
          {overviewFailure.code === undefined && overviewFailure.message === undefined ? null : (
            <details className={css.diagnostic}>
              <summary>{t('view.diagnostic')}</summary>
              {overviewFailure.code === undefined ? null : <code>{overviewFailure.code}</code>}
              {overviewFailure.message === undefined ? null : <p>{overviewFailure.message}</p>}
            </details>
          )}
        </div>
      )}
      <div className={css.grid} data-home-grid>
        <Card
          id="inbox"
          title={t('view.inbox')}
          state={cardState(inbox?.available)}
          counts={inboxCounts}
          {...(inboxFailure === undefined ? {} : { failure: inboxFailure })}
          {...(inbox?.saved !== undefined && inbox.saved > 0 ? { secondary: t('view.inboxSaved', { saved: String(inbox.saved) }) } : {})}
          items={(inbox?.recent ?? []).map(item => ({ id: item.id, title: item.title, ...(item.at === undefined ? {} : { meta: dayLabel(item.at, language) }) }))}
          emptyText={t('view.empty')}
          unavailableText={t('view.unavailable')}
          unreadText={t('view.notRead')}
          loadingText={t('view.loading')}
          onOpen={() => { navigation?.open({ appId: 'inbox' }) }}
          onOpenRecord={(id) => { navigation?.open({ appId: 'inbox', record: { appId: 'inbox', kind: 'entry', id } }) }}
          onRetry={retry}
          openLabel={t('view.open')}
          retryLabel={t('view.retry')}
          statusLabel={t('view.cardStatus')}
        />
        <Card
          id="todo"
          title={t('view.todo')}
          state={cardState(todo?.available)}
          counts={todoCounts}
          {...(todoFailure === undefined ? {} : { failure: todoFailure })}
          {...(todo?.available === true && todo.overdue !== undefined && todo.overdue > 0 ? { urgent: t('view.todoOverdue', { overdue: String(todo.overdue) }) } : {})}
          items={(todo?.recent ?? []).map(item => ({ id: item.id, title: item.title, ...(item.dueDate === undefined ? {} : { meta: dueLabel(item.dueDate, today, language, t) }) }))}
          emptyText={t('view.empty')}
          unavailableText={t('view.unavailable')}
          unreadText={t('view.notRead')}
          loadingText={t('view.loading')}
          onOpen={() => { navigation?.open({ appId: 'todo' }) }}
          onOpenRecord={(id) => { navigation?.open({ appId: 'todo', record: { appId: 'todo', kind: 'task', id } }) }}
          onRetry={retry}
          openLabel={t('view.open')}
          retryLabel={t('view.retry')}
          statusLabel={t('view.cardStatus')}
        />
        <Card
          id="notes"
          title={t('view.notes')}
          state={cardState(notes?.available)}
          counts={notesCounts}
          {...(notesFailure === undefined ? {} : { failure: notesFailure })}
          items={(notes?.recent ?? []).map(item => ({ id: item.id, title: displayTitle(item.title), ...(item.at === undefined ? {} : { meta: dayLabel(item.at, language) }) }))}
          emptyText={t('view.empty')}
          unavailableText={t('view.unavailable')}
          unreadText={t('view.notRead')}
          loadingText={t('view.loading')}
          onOpen={() => { navigation?.open({ appId: 'notes' }) }}
          onOpenRecord={(id) => { navigation?.open({ appId: 'notes', record: { appId: 'notes', kind: 'note', id } }) }}
          onRetry={retry}
          openLabel={t('view.open')}
          retryLabel={t('view.retry')}
          statusLabel={t('view.cardStatus')}
        />
      </div>
    </div>
  )
}
