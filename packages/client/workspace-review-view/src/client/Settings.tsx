/**
 * The workspace-review settings page: the source roots, redaction switch,
 * retention cap and AI switch the backend already exposes. The management
 * dialog renders this in its Settings tab; every edit is saved explicitly
 * through the same `call` face the page uses.
 * @module @matrix1001/dsh-application-harness-workspace-review-view/client/settings
 */
import { createElement, useCallback, useEffect, useState, type ReactNode } from 'react'
import { SettingRow, SettingsGroup, SettingsLayout } from '@matrix1001/dsh-application-harness-client-chrome'
import type { ApplicationSettingsProps } from '@matrix1001/dsh-application-harness-client-applications/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { NS, type WorkspaceReviewKey } from './locales.ts'
import css from './Settings.module.css'

/** The settings shape the application returns (mirrors the app's public view). */
interface ReviewSettings {
  sourceRoots: { dsh: string; claudeCode: string; codex: string }
  redactSecrets: boolean
  reviewRetention: number
  aiEnabled: boolean
}

/** Props of the settings page. */
export interface WorkspaceReviewSettingsProps extends ApplicationSettingsProps {
  readonly t: TranslateNS<typeof NS>
  readonly language?: string
}

/** Render the settings form. */
export function WorkspaceReviewSettings({ call, t }: WorkspaceReviewSettingsProps): ReactNode {
  const [settings, setSettings] = useState<ReviewSettings>()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const [saved, setSaved] = useState(false)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(async () => {
    try {
      const outcome = await call('settings', {})
      if (outcome.status === 'success') { setSettings(outcome.result as unknown as ReviewSettings); setError(undefined); setDirty(false); setSaved(false) }
      else if (outcome.status !== 'cancelled') setError(outcome.error?.message ?? t('settings.loadFailed' as WorkspaceReviewKey))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.loadFailed' as WorkspaceReviewKey))
    }
  }, [call, t])

  useEffect(() => { void load() }, [load])

  const save = async (): Promise<void> => {
    /* v8 ignore next -- the save button only renders once settings exist */
    if (settings === undefined) return
    setSaving(true); setSaved(false); setError(undefined)
    try {
      const outcome = await call('setSettings', { patch: settings } as never)
      if (outcome.status !== 'success') { setError(outcome.error?.message ?? t('settings.saveFailed' as WorkspaceReviewKey)); return }
      setSettings(outcome.result as unknown as ReviewSettings)
      setSaved(true)
      setDirty(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.saveFailed' as WorkspaceReviewKey))
    } finally {
      setSaving(false)
    }
  }

  if (settings === undefined) {
    return createElement('div', { className: css.settings, 'data-wr-settings-loading': true },
      createElement('p', null, error ?? t('settings.loading' as WorkspaceReviewKey)),
      error === undefined ? null : createElement('button', { type: 'button', className: css.save, onClick: () => { void load() }, 'data-wr-settings-retry': true }, t('settings.retry' as WorkspaceReviewKey)),
    )
  }

  const updateRoot = (key: keyof ReviewSettings['sourceRoots'], value: string): void => {
    /* v8 ignore next -- the updater only runs while settings is rendered */
    setSettings(current => current === undefined ? current : { ...current, sourceRoots: { ...current.sourceRoots, [key]: value } })
    setSaved(false)
    setDirty(true)
  }

  return (
    <SettingsLayout
      data-wr-settings
      status={saved ? <span className={css.saved} role="status" data-wr-settings-saved>{t('settings.saved' as WorkspaceReviewKey)}</span> : undefined}
      footer={(
        <button className={css.save} type="button" onClick={() => { void save() }} disabled={saving || !dirty} data-wr-settings-save>
          {saving ? t('settings.saving' as WorkspaceReviewKey) : t('settings.save' as WorkspaceReviewKey)}
        </button>
      )}
    >
      <SettingsGroup title={t('settings.title' as WorkspaceReviewKey)}>
        <SettingRow label={t('settings.dshRoot' as WorkspaceReviewKey)}>
          <input value={settings.sourceRoots.dsh} data-wr-setting="dsh" onChange={(event) => { updateRoot('dsh', event.target.value) }} />
        </SettingRow>
        <SettingRow label={t('settings.claudeRoot' as WorkspaceReviewKey)}>
          <input value={settings.sourceRoots.claudeCode} data-wr-setting="claudeCode" onChange={(event) => { updateRoot('claudeCode', event.target.value) }} />
        </SettingRow>
        <SettingRow label={t('settings.codexRoot' as WorkspaceReviewKey)}>
          <input value={settings.sourceRoots.codex} data-wr-setting="codex" onChange={(event) => { updateRoot('codex', event.target.value) }} />
        </SettingRow>
        <SettingRow label={t('settings.redact' as WorkspaceReviewKey)}>
          <input type="checkbox" checked={settings.redactSecrets} data-wr-setting="redact" onChange={(event) => { setSettings({ ...settings, redactSecrets: event.target.checked }); setSaved(false); setDirty(true) }} />
        </SettingRow>
        <SettingRow label={t('settings.retention' as WorkspaceReviewKey)}>
          <input type="number" min={1} max={20} value={settings.reviewRetention} data-wr-setting="retention" onChange={(event) => { setSettings({ ...settings, reviewRetention: Number(event.target.value) }); setSaved(false); setDirty(true) }} />
        </SettingRow>
        <SettingRow label={t('settings.ai' as WorkspaceReviewKey)}>
          <input type="checkbox" checked={settings.aiEnabled} data-wr-setting="ai" onChange={(event) => { setSettings({ ...settings, aiEnabled: event.target.checked }); setSaved(false); setDirty(true) }} />
        </SettingRow>
      </SettingsGroup>
      {error === undefined ? null : <p className={css.error} role="alert" data-wr-settings-error>{error}</p>}
    </SettingsLayout>
  )
}
