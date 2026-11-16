/**
 * The DeepSeek usage page: the six account figures, the daily-spend bar chart,
 * the model × API-key table, the 7/30-day switch, refresh, CSV export and the
 * three distinct states the account can be in (no token, failed read, stale
 * snapshot).
 *
 * The page reads through the one `call` face and never owns a second data
 * path: `usage` returns the projection of the current window, and the view
 * only chooses how to paint it. The 7/30 switch asks the host for the other
 * window (the host cuts it from the same cached base reading), while the model
 * and API-key filters only filter the table — the chart and the six figures
 * stay the window's own.
 * @module @matrix1001/dsh-application-harness-usage-view
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { type ApplicationViewProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import { NoticeLayer, TabBar, useConfirm, useUiField } from '@matrix1001/dsh-application-harness-client-chrome'
import { NS } from './locales.ts'
import css from './UsageView.module.css'

/** The translate face this page needs. */
export type UsageTranslate = TranslateNS<'usage'>

/** The props of the registered page. */
export interface UsagePageProps extends ApplicationViewProps { locale: LocaleRuntime }

/** The props of the page body. */
export interface UsageViewProps extends ApplicationViewProps { t: UsageTranslate }

/** The two windows the switch offers. */
export type UsagePeriod = 7 | 30

/** The measurement states the page distinguishes. */
export type UsageStatus = 'ready' | 'stale' | 'unconfigured' | 'failed'

/** One day of the window's daily series. */
export interface UsageDayWire {
  date: string
  cost?: number
  tokens?: number
  requests?: number
}

/** One model × API-key row of the window. */
export interface UsageRowWire {
  model: string
  keyId: string
  keyName: string
  tokens?: number
  requests?: number
  cost?: number
}

/** The six figures of the window. */
export interface UsageSummaryWire {
  balance?: number
  cumulativeCost?: number
  monthCost?: number
  windowCost?: number
  windowTokens?: number
  windowRequests?: number
}

/** The `usage` operation's value. */
export interface UsageResultWire {
  status: UsageStatus
  configured: boolean
  period: number
  fetchedAt?: number
  stale?: boolean
  code?: string
  message?: string
  window: { start: string; end: string; days: number }
  summary: UsageSummaryWire
  days: UsageDayWire[]
  rows: UsageRowWire[]
}

/** The `exportUsage` operation's value. */
export interface UsageExportWire {
  filename: string
  csv: string
  rows: number
}

/** The settings panel's fact: whether a token is set (never the token). */
interface UsageSettingsWire {
  period: number
  cacheTtlMs: number
  tokenSet: boolean
}

type Outcome = Awaited<ReturnType<ApplicationViewProps['call']>>

/** The value of an accepted call, or `undefined`. */
function valueOf<T>(outcome: Outcome): T | undefined {
  return outcome.status === 'success' ? outcome.result as T : undefined
}

/** The readable message of a failed/rejected call. */
function messageOf(outcome: Outcome): string | undefined {
  return outcome.status === 'success' || outcome.status === 'cancelled' ? undefined : outcome.error?.message
}

/** `¥ 1,234.50`. */
function money(value: number): string {
  return `¥ ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** A compact token count (`12.40M`, `1.5K`, `842`). */
function compact(value: number): string {
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
  return String(value)
}

/** The local time of one fetchedAt instant. */
function updatedLabel(value: number): string {
  const date = new Date(value)
  const now = new Date()
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  return date.toDateString() === now.toDateString() ? time : `${date.toLocaleDateString()} ${time}`
}

/** The window label (`2026-10-30 – 2026-11-05`). */
function rangeLabel(start: string, end: string): string {
  return start === '' || end === '' ? '—' : `${start} – ${end}`
}

/** The x-axis label of one bar. */
function barLabel(date: string, index: number, days: number): string {
  if (days <= 7) return date.slice(5)
  return index === 0 || index === days - 1 || index % 5 === 0 ? date.slice(5) : ''
}

/** One row's key identity (the id when present, else the display name). */
function keyIdOf(row: UsageRowWire): string {
  return row.keyId !== '' ? row.keyId : row.keyName
}

/** Offer the exported bytes as a browser download. */
function download(filename: string, body: string): void {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

/** The registered page. */
export function UsagePage({ locale, ...props }: UsagePageProps) {
  useSyncExternalStore(
    useCallback((listener: () => void) => locale.subscribe(listener), [locale]),
    useCallback(() => locale.getSnapshot(), [locale]),
  )
  return <UsageView {...props} t={locale.bind(NS)} />
}

/** The usage page. */
export function UsageView({ call, running, ui, t }: UsageViewProps) {
  const [snapshot, setSnapshot] = useState<UsageResultWire>()
  const [settingsFace, setSettingsFace] = useState<UsageSettingsWire>()
  const [period, setPeriod] = useUiField<UsagePeriod>(ui, 'period', 7, (value): value is UsagePeriod => value === 7 || value === 30)
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [notice, setNotice] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [tokenDraft, setTokenDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const { confirm: confirmClear, dialog: confirmDialog } = useConfirm()

  const load = useCallback(async (days?: UsagePeriod, force?: boolean) => {
    setLoading(true)
    setNotice(undefined)
    const args: Record<string, unknown> = {}
    if (days !== undefined) args.days = days
    if (force === true) args.refresh = true
    const outcome = await call('usage', args as never)
    const value = valueOf<UsageResultWire>(outcome)
    if (value === undefined) {
      setNotice(messageOf(outcome) ?? t('view.loadFailed'))
      setLoading(false)
      return
    }
    setSnapshot(value)
    setPeriod(value.period === 30 ? 30 : 7)
    setLoading(false)
  }, [call, t])

  const loadSettings = useCallback(async () => {
    const outcome = await call('settings', {})
    const value = valueOf<UsageSettingsWire>(outcome)
    if (value !== undefined) setSettingsFace(value)
  }, [call])

  useEffect(() => { void load() }, [load])
  useEffect(() => { void loadSettings() }, [loadSettings])

  const choosePeriod = useCallback((id: string) => {
    const next: UsagePeriod = id === '30' ? 30 : 7
    if (next === period) return
    setPeriod(next)
    void call('setSettings', { period: next })
    void load(next)
  }, [call, load, period])

  const refresh = useCallback(() => {
    void load(period, true)
  }, [load, period])

  const exportCsv = useCallback(async () => {
    const outcome = await call('exportUsage', { days: period, model, key: apiKey })
    const value = valueOf<UsageExportWire>(outcome)
    if (value === undefined) {
      setNotice(messageOf(outcome) ?? t('view.exportFailed'))
      return
    }
    download(value.filename, value.csv)
  }, [apiKey, call, model, period, t])

  const saveToken = useCallback(async () => {
    /* v8 ignore next -- the submit control is disabled while the field is empty */
    if (tokenDraft.trim() === '') return
    setSaving(true)
    const outcome = await call('setSettings', { platformToken: tokenDraft })
    if (outcome.status !== 'success') {
      setNotice(messageOf(outcome) ?? t('view.saveFailed'))
      setSaving(false)
      return
    }
    setTokenDraft('')
    setSaving(false)
    setSettingsOpen(false)
    await load(period, true)
    await loadSettings()
  }, [call, load, loadSettings, period, t, tokenDraft])

  const clearToken = useCallback(async () => {
    const clear = await confirmClear({
      title: t('view.clearConfirm'),
      body: t('view.clearBody'),
      confirmLabel: t('view.clearAction'),
      cancelLabel: t('view.keepEditing'),
      danger: true,
    })
    if (!clear) return
    setSaving(true)
    const outcome = await call('setSettings', { platformToken: '' })
    if (outcome.status !== 'success') {
      setNotice(messageOf(outcome) ?? t('view.saveFailed'))
      setSaving(false)
      return
    }
    setTokenDraft('')
    setSaving(false)
    await load(period, true)
    await loadSettings()
    setNotice(t('view.clearDone'))
  }, [call, confirmClear, load, loadSettings, period, t])

  const openSettings = useCallback(() => { setSettingsOpen(true) }, [])
  const toggleSettings = useCallback(() => { setSettingsOpen(open => !open) }, [])

  const state: UsageStatus | 'loading' = loading ? 'loading' : (snapshot?.status ?? 'failed')
  const showData = snapshot !== undefined && (snapshot.status === 'ready' || snapshot.status === 'stale')
  const configured = snapshot?.configured === true || settingsFace?.tokenSet === true
  const summary = snapshot?.summary ?? {}
  const days = snapshot?.days ?? []
  const allRows = snapshot?.rows ?? []
  const chartMax = Math.max(1, ...days.map(day => day.cost ?? 0))

  const modelOptions = [...new Set(allRows.map(row => row.model))].sort()
  const keyOptions = new Map<string, string>()
  for (const row of allRows) {
    const id = keyIdOf(row)
    if (id !== '' && !keyOptions.has(id)) keyOptions.set(id, row.keyName !== '' ? row.keyName : id)
  }
  const rows = allRows.filter(row => (model === '' || row.model === model) && (apiKey === '' || keyIdOf(row) === apiKey))

  const cards = [
    { id: 'balance', label: t('view.balance'), value: summary.balance === undefined ? t('view.unknown') : money(summary.balance), sub: t('view.balanceSub') },
    { id: 'cumulative', label: t('view.cumulative'), value: summary.cumulativeCost === undefined ? t('view.unknown') : money(summary.cumulativeCost), sub: t('view.cumulativeSub') },
    { id: 'month', label: t('view.month'), value: summary.monthCost === undefined ? t('view.unknown') : money(summary.monthCost), sub: t('view.monthSub') },
    { id: 'window', label: t('view.windowCost'), value: summary.windowCost === undefined ? t('view.unknown') : money(summary.windowCost), sub: t('view.windowCostSub') },
    { id: 'tokens', label: t('view.tokens'), value: summary.windowTokens === undefined ? t('view.unknown') : compact(summary.windowTokens), sub: t('view.tokensSub') },
    { id: 'requests', label: t('view.requests'), value: summary.windowRequests === undefined ? t('view.unknown') : summary.windowRequests.toLocaleString(undefined), sub: t('view.requestsSub') },
  ]

  const canExport = showData && !running

  return (
    <div className={css.page} data-usage-page data-usage-state={state}>
      <TabBar
        tabs={[
          { id: '7', label: t('view.period7'), anchor: { 'data-usage-period': '7' } },
          { id: '30', label: t('view.period30'), anchor: { 'data-usage-period': '30' } },
        ]}
        active={String(period)}
        onSelect={(id) => { choosePeriod(id) }}
        data-usage-toolbar
        tools={(
          <>
            <button
              type="button"
              className={css.button}
              onClick={toggleSettings}
              aria-expanded={settingsOpen}
              data-usage-action="settings"
            >
              {t('view.tokenSettings')}
            </button>
            <button
              type="button"
              className={css.button}
              onClick={refresh}
              disabled={running}
              data-usage-action="refresh"
            >
              {t('view.refresh')}
            </button>
            <button
              type="button"
              className={`${css.button} ${css.primary}`}
              onClick={() => { void exportCsv() }}
              disabled={!canExport}
              data-usage-action="export"
            >
              {t('view.export')}
            </button>
          </>
        )}
      />
      <div className={css.scroll}>
        <div className={css.body}>
          <div className={css.head}>
            <div className={css.headTitle}>
              <h1>{t('view.title')}</h1>
              <span className={css.range} data-usage-range>
                {snapshot === undefined ? '' : rangeLabel(snapshot.window.start, snapshot.window.end)}
              </span>
            </div>
            <span className={css.updated} data-usage-updated>
              {snapshot?.fetchedAt === undefined ? '' : `${t('view.updated')} ${updatedLabel(snapshot.fetchedAt)}`}
            </span>
          </div>

          {settingsOpen ? (
            <section className={css.settings} data-usage-settings>
              <div className={css.settingsHead}>
                <h2>{t('view.settingsTitle')}</h2>
                <span className={css.tokenState} data-usage-token-state={configured ? 'set' : 'missing'}>
                  {configured ? t('view.tokenSet') : t('view.tokenMissing')}
                </span>
              </div>
              <form className={css.tokenForm} onSubmit={(event) => { event.preventDefault(); void saveToken() }}>
                <label htmlFor="usage-token">{t('view.tokenLabel')}</label>
                <input
                  id="usage-token"
                  type="password"
                  autoComplete="off"
                  value={tokenDraft}
                  onChange={(event) => { setTokenDraft(event.target.value) }}
                  placeholder={t('view.tokenPlaceholder')}
                  data-usage-token
                />
                <button type="submit" className={`${css.button} ${css.primary}`} disabled={saving || tokenDraft.trim() === ''} data-usage-action="save-token">
                  {saving ? t('view.saving') : t('view.saveToken')}
                </button>
                {configured ? (
                  <button type="button" className={css.button} disabled={saving} onClick={() => { void clearToken() }} data-usage-action="clear-token">
                    {t('view.clearToken')}
                  </button>
                ) : null}
              </form>
              <p className={css.hint}>{t('view.tokenHint')} {t('view.keepEmpty')}</p>
            </section>
          ) : null}

          {state === 'loading' ? <p className={css.notice} data-usage-loading>{t('view.loading')}</p> : null}

          {state === 'unconfigured' ? (
            <section className={`${css.notice} ${css.unconfigured}`} data-usage-unconfigured>
              <p>{t('view.unconfigured')}</p>
              <button type="button" className={`${css.button} ${css.primary}`} onClick={openSettings} data-usage-action="configure">
                {t('view.configure')}
              </button>
            </section>
          ) : null}

          {state === 'failed' ? (
            <section className={`${css.notice} ${css.error}`} data-usage-error>
              <span>{notice ?? snapshot?.message ?? t('view.loadFailed')}</span>
              <span>
                <button type="button" className={css.button} onClick={() => { void load(period, true) }} data-usage-retry>{t('view.retry')}</button>
                <button type="button" className={css.button} onClick={openSettings} data-usage-error-settings>{t('view.tokenSettings')}</button>
              </span>
            </section>
          ) : null}

          {state === 'stale' ? (
            <section className={`${css.notice} ${css.stale}`} data-usage-stale>
              <strong>{t('view.staleTitle')}</strong>
              <span>{snapshot?.message ?? t('view.stale')}</span>
            </section>
          ) : null}

          <NoticeLayer
            label={t('view.notices')}
            items={notice !== undefined && state !== 'failed' ? [{
              id: 'usage',
              tone: 'error',
              text: notice,
              anchor: { 'data-usage-notice': '' },
              onDismiss: () => { setNotice(undefined) },
              dismissLabel: t('view.dismiss'),
            }] : []}
          />

          {showData ? (
            <>
              <section className={css.stats} data-usage-stats>
                {cards.map(card => (
                  <div key={card.id} className={`${css.stat} ${card.id === 'balance' ? css.balance : ''}`} data-usage-card={card.id}>
                    <div className={css.statLabel}>{card.label}</div>
                    <div className={css.statValue} data-usage-value={card.id}>{card.value}</div>
                    <div className={css.statSub}>{card.sub}</div>
                  </div>
                ))}
              </section>

              <section className={css.panel} data-usage-chart-panel>
                <div className={css.panelHead}>
                  <h2>{t('view.dailyCost')}</h2>
                  <span className={css.unit}>{t('view.dailyCostUnit')}</span>
                  <span className={css.chartMax} data-usage-chart-max>{t('view.chartMax', { value: money(chartMax) })}</span>
                  <span className={css.spacer} />
                  <span className={css.note}>{t('view.dailyCostNote')}</span>
                </div>
                <div className={css.chartWrap} data-usage-chart>
                  {days.map((day, index) => (
                    <div
                      key={day.date}
                      className={css.barCol}
                      title={`${day.date} · ${money(day.cost ?? 0)}`}
                      tabIndex={0}
                      role="img"
                      aria-label={`${day.date} · ${money(day.cost ?? 0)}`}
                      data-usage-bar={day.date}
                    >
                      <div
                        className={css.bar}
                        style={{ height: `${String(Math.max(0, ((day.cost ?? 0) / chartMax) * 100))}%` }}
                      />
                      {barLabel(day.date, index, period) === '' ? null : <span className={css.barLabel}>{barLabel(day.date, index, period)}</span>}
                    </div>
                  ))}
                </div>
              </section>

              <section className={css.panel} data-usage-table-panel>
                <div className={css.panelHead}>
                  <h2>{t('view.modelKey')}</h2>
                  <span className={css.unit}>{t('view.modelKeyUnit')}</span>
                  <span className={css.spacer} />
                </div>
                <div className={css.tools}>
                  <select
                    className={css.select}
                    value={model}
                    onChange={(event) => { setModel(event.target.value) }}
                    aria-label={t('view.allModels')}
                    data-usage-filter="model"
                  >
                    <option value="">{t('view.allModels')}</option>
                    {modelOptions.map(option => <option key={option} value={option}>{option}</option>)}
                  </select>
                  <select
                    className={css.select}
                    value={apiKey}
                    onChange={(event) => { setApiKey(event.target.value) }}
                    aria-label={t('view.allKeys')}
                    data-usage-filter="key"
                  >
                    <option value="">{t('view.allKeys')}</option>
                    {[...keyOptions.entries()].map(([id, label]) => <option key={id} value={id}>{label}</option>)}
                  </select>
                </div>
                <div className={css.tableWrap}>
                  <table data-usage-table>
                    <thead>
                      <tr>
                        <th>{t('view.model')}</th>
                        <th>{t('view.apiKey')}</th>
                        <th className={css.num}>{t('view.tableTokens')}</th>
                        <th className={css.num}>{t('view.tableRequests')}</th>
                        <th className={css.num}>{t('view.tableCost')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.length === 0 ? (
                        <tr><td colSpan={5} className={css.emptyCell} data-usage-empty>{t('view.noRows')}</td></tr>
                      ) : rows.map(row => (
                        <tr key={`${row.model}\u0000${keyIdOf(row)}`} data-usage-row={`${row.model}:${keyIdOf(row)}`}>
                          <td className={css.model}>{row.model}</td>
                          <td><span className={css.keyChip}>{row.keyName !== '' ? row.keyName : keyIdOf(row) !== '' ? keyIdOf(row) : t('view.unknown')}</span></td>
                          <td className={css.num}>{row.tokens === undefined ? t('view.unknown') : compact(row.tokens)}</td>
                          <td className={css.num}>{row.requests === undefined ? t('view.unknown') : row.requests.toLocaleString(undefined)}</td>
                          <td className={css.num}>{row.cost === undefined ? t('view.unknown') : money(row.cost)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className={css.account} data-usage-account>
                  <span>{t('view.balance')} <b>{summary.balance === undefined ? t('view.unknown') : money(summary.balance)}</b></span>
                  <span>{t('view.cumulative')} <b>{summary.cumulativeCost === undefined ? t('view.unknown') : money(summary.cumulativeCost)}</b></span>
                  <span>{t('view.month')} <b>{summary.monthCost === undefined ? t('view.unknown') : money(summary.monthCost)}</b></span>
                  <span className={css.spacer} />
                  <a href="https://platform.deepseek.com/usage" target="_blank" rel="noreferrer">{t('view.console')}</a>
                  <a href="https://api-docs.deepseek.com" target="_blank" rel="noreferrer">{t('view.docs')}</a>
                </div>
              </section>
            </>
          ) : null}
        </div>
      </div>
      {confirmDialog}
    </div>
  )
}
