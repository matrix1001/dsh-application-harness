/**
 * The shell-level status control: one always-present anchor with a disclosure
 * panel. Shared by the application header and the management header so a
 * connection, permission or degraded notice stays reachable in both modes.
 *
 * The anchor never disappears (a control that blinks in and out while the host
 * works is harder to find than one that is always there): with no actionable
 * notice it is a quiet neutral dot, and the panel says there is nothing to
 * handle. Only an error/warning turns it into the warning icon and count. An
 * in-progress (`info`) notice is shown in the panel when it is open, but it is
 * not a problem, so it never paints the anchor as a warning.
 *
 * The panel is not a menu: the button is a disclosure (`aria-expanded`/
 * `aria-controls`) and the panel a labelled region.
 * @module @matrix1001/dsh-application-harness-client-applications/client/StatusControl
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconWarningOutlineRegular } from '@matrix1001/dsh-application-harness-client-chrome'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AreaNotice } from './notices.ts'
import css from './ApplicationsArea.module.css'

/** The props of one status disclosure. */
export interface StatusControlProps {
  readonly notices: readonly AreaNotice[]
  /** A unique panel id per header so the app and management headers never collide. */
  readonly panelId: string
  readonly t: TranslateNS<'applications'>
}

/**
 * Render the always-present status disclosure.
 * @param props - the notices, the panel id and the dictionary.
 * @returns the status control element.
 */
export function StatusControl({ notices, panelId, t }: StatusControlProps): ReactNode {
  const [open, setOpen] = useState(false)
  const wrap = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return undefined
    const onPointerDown = (event: PointerEvent): void => {
      if (wrap.current?.contains(event.target as Node) === true) return
      setOpen(false)
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  // Only an answer the human has to act on may paint the anchor as a warning.
  // Progress describes work in flight, not a problem.
  const actionable = notices.filter(notice => notice.tone !== 'info')
  const count = actionable.length
  const tone = actionable.some(notice => notice.tone === 'error')
    ? 'error'
    : count > 0 ? 'warning' : 'neutral'
  const label = count === 0 ? t('notices.normal') : `${t('notices.label')} (${String(count)})`
  return (
    <div className={css.statusWrap} ref={wrap}>
      <button
        type="button"
        className={css.headerIconButton}
        data-app-status
        data-tone={tone}
        aria-label={label}
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => { setOpen(value => !value) }}
      >
        {count === 0
          ? <span className={css.statusAnchor} data-app-status-anchor aria-hidden="true" />
          : <IconWarningOutlineRegular size={16} />}
        {count > 0 && <span className={css.headerCount} data-app-status-count>{count}</span>}
      </button>
      <div
        id={panelId}
        className={css.statusPanel}
        data-shell-notices
        data-open={open ? 'true' : 'false'}
        role="region"
        aria-label={t('notices.label')}
      >
        {notices.length === 0 && (
          <p className={css.statusEmpty} data-shell-notices-empty>{t('notices.empty')}</p>
        )}
        {notices.map(notice => (
          <div
            key={notice.id}
            className={css.statusItem}
            data-tone={notice.tone}
            role={notice.tone === 'error' ? 'alert' : 'status'}
            {...notice.anchor}
          >
            <span className={css.statusText}>{notice.text}</span>
            {notice.detail !== undefined && (
              <details className={css.statusDetail}>
                <summary>{t('manage.diagnostic')}</summary>
                <span>{notice.detail}</span>
              </details>
            )}
            <span className={css.statusActions}>
              {(notice.actions ?? []).map(action => (
                <button
                  key={action.label}
                  type="button"
                  className={css.statusAction}
                  {...action.anchor}
                  onClick={() => { setOpen(false); action.onClick() }}
                >{action.label}</button>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
