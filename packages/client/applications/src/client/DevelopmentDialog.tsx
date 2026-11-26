/**
 * The "develop this application" dialog: choose the source workspace, create a
 * dedicated development Session there, and let the host bind it to the app.
 * It does not edit source or switch versions; that remains the Session's job.
 * @module @matrix1001/dsh-application-harness-client-applications/client/DevelopmentDialog
 */
import { useState, type ReactElement } from 'react'
import { Button, Modal } from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import css from './ApplicationsArea.module.css'

/** What the dialog needs. */
export interface DevelopmentDialogProps {
  readonly appId: string
  readonly appName: string
  readonly onClose: () => void
  readonly create: (appId: string, path: string) => Promise<string>
  readonly sessions: readonly { readonly appId: string; readonly sessionId: string }[]
  readonly openSession: (sessionId: string) => void
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the development-session creation dialog.
 * @param props - the app, the creation command and the locale seat.
 * @returns the modal.
 */
export function DevelopmentDialog({ appId, appName, onClose, create, sessions, openSession, t }: DevelopmentDialogProps): ReactElement {
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [created, setCreated] = useState<string>()

  const submit = async (): Promise<void> => {
    if (busy || path.trim() === '') return
    setBusy(true)
    setError(undefined)
    try {
      setCreated(await create(appId, path.trim()))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open headless onClose={onClose} title={t('develop.title')} className={css.dialog as string}>
      <div className={css.develop} data-develop-dialog>
        <div className={css.developHead}>
          <strong>{t('develop.title')}</strong>
          <button type="button" className={css.headerIconButton} aria-label={t('develop.close')} onClick={onClose}>×</button>
        </div>
        <p className={css.developHint}>{t('develop.hint', { app: appName })}</p>
        {/* v8 ignore start -- remembered development Sessions are covered by the panel flow */}
        {sessions.length > 0 && (
          <div className={css.developActions} data-develop-existing>
            {sessions.map(entry => (
              <Button key={entry.sessionId} data-develop-existing-session={entry.sessionId} onClick={() => { openSession(entry.sessionId) }}>
                {entry.sessionId}
              </Button>
            ))}
          </div>
        )}
        {/* v8 ignore stop */}
        {created === undefined ? (
          <>
            <label className={css.developField}>
              <span>{t('develop.path')}</span>
              <input
                value={path}
                data-develop-path
                placeholder={t('develop.pathPlaceholder')}
                onChange={(event) => { setPath(event.target.value) }}
                onKeyDown={(event) => { if (event.key === 'Enter') void submit() }}
              />
            </label>
            {error !== undefined && <p className={css.developError} role="alert">{error}</p>}
            <div className={css.developActions}>
              <Button data-develop-cancel onClick={onClose}>{t('develop.cancel')}</Button>
              <Button data-develop-submit variant="primary" disabled={busy || path.trim() === ''} onClick={() => { void submit() }}>
                {busy ? t('develop.creating') : t('develop.create')}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className={css.developHint} data-develop-created>{t('develop.created')}</p>
            <code className={css.developId}>{created}</code>
            <div className={css.developActions}>
              <Button data-develop-done onClick={onClose}>{t('develop.done')}</Button>
              <Button data-develop-open variant="primary" onClick={() => { openSession(created) }}>{t('develop.open')}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
