/**
 * The shared settings page layout: a scrolling body of grouped rows and an
 * action bar that stays visible while it scrolls.
 *
 * Deliberately presentational and business-free — it takes ALREADY-LOCALIZED
 * text and the application's own controls, and owns nothing but the layout:
 * the application keeps reading, drafting, validating, saving and applying
 * (`S1`/`S3`: the platform's own `SettingsForm` exists, but it discards on
 * unmount and its model is built for a plugin settings scope, so it cannot
 * carry this framework's draft semantics; its CONTROLS and surface are what a
 * page reuses, through here).
 *
 * The three rules the layout exists to keep:
 *
 * - the body is the ONE scroller, and the action bar is a flex sibling — never
 *   a second scrollbar beside the dialog's, never a floating footer covering
 *   the last field;
 * - the bar is visible as soon as the page opens, however long the form is
 *   (`S1`: no scrolling to the end to find Save);
 * - a row is a label wrapping its control (the input's accessible name with no
 *   id wiring) laid out in two columns on a wide surface and one on a narrow
 *   one, while the hint and the error stay beside the field they belong to.
 * @module
 */

import type { ReactNode, Ref } from 'react'
import css from './settings.module.css'

/** Props of one settings page. */
export interface SettingsLayoutProps {
  /** The groups of rows, in reading order. */
  readonly children: ReactNode
  /** The scrolling body element, for a caller that binds its scroll position. */
  readonly bodyRef?: Ref<HTMLDivElement> | undefined
  /** The action bar under the scrolling body (the save action belongs here). */
  readonly footer?: ReactNode
  /**
   * The live line beside the actions: unsaved changes, a failure, the saved
   * confirmation. The application owns its words; the layout only keeps it
   * reachable.
   */
  readonly status?: ReactNode
  /** Extra class merged onto the layout root. */
  readonly className?: string | undefined
  /** Arbitrary `data-*` attributes forwarded to the root (locator anchors). */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * Lay out one settings page.
 * @param props - the rows, the action bar and its status line.
 * @returns the settings layout element.
 */
export function SettingsLayout({ children, bodyRef, footer, status, className, ...rest }: SettingsLayoutProps): ReactNode {
  return (
    <div className={[css.settings, className].filter(Boolean).join(' ')} data-settings-page {...rest}>
      <div className={css.settingsBody} ref={bodyRef} data-settings-body>{children}</div>
      {footer !== undefined && (
        <div className={css.settingsFoot} data-settings-foot>
          <span className={css.settingsStatus}>{status}</span>
          <span className={css.settingsActions}>{footer}</span>
        </div>
      )}
    </div>
  )
}

/** Props of one group of settings. */
export interface SettingsGroupProps {
  /** The group's heading (already localized). */
  readonly title: string
  /** The rows. */
  readonly children: ReactNode
  /** Arbitrary `data-*` attributes forwarded to the group. */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * One titled run of settings rows. A group is organized by its heading, the
 * spacing and one divider — never by a card around it (`S1`).
 * @param props - the heading and the rows.
 * @returns the group element.
 */
export function SettingsGroup({ title, children, ...rest }: SettingsGroupProps): ReactNode {
  return (
    <section className={css.group} data-settings-group {...rest}>
      <h4 className={css.groupTitle}>{title}</h4>
      <div className={css.rows}>{children}</div>
    </section>
  )
}

/** Props of one settings row. */
export interface SettingRowProps {
  /** The field's label (already localized); it names the row's control. */
  readonly label: string
  /** One line about what the field is for, under the label. */
  readonly hint?: string | undefined
  /**
   * A short state chip beside the label ("未设置", "已保存"). Kept OUT of the
   * label: a state appended to a long Chinese label wrapped the label to three
   * lines and pushed the control out of alignment (the credential row did).
   */
  readonly badge?: string | undefined
  /** The field's own error, under the control. Shown as an alert where it belongs. */
  readonly error?: string | undefined
  /** The control itself (an input, a select, a switch, a small group). */
  readonly children: ReactNode
  /** Arbitrary `data-*` attributes forwarded to the row. */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * One settings row: the label (and why) beside the control on a wide surface,
 * above it on a narrow one. The row IS the label, so the control's accessible
 * name needs no id wiring.
 * @param props - the label, its explanation, an error and the control.
 * @returns the row element.
 */
export function SettingRow({ label, hint, badge, error, children, ...rest }: SettingRowProps): ReactNode {
  return (
    <label className={css.row} data-setting-row {...rest}>
      <span className={css.rowInfo}>
        <span className={css.rowLabel}>
          {label}
          {badge !== undefined && <span className={css.rowBadge} data-setting-badge>{badge}</span>}
        </span>
        {hint !== undefined && <span className={css.rowHint}>{hint}</span>}
      </span>
      <span className={css.rowControl}>{children}</span>
      {error !== undefined && <span className={css.rowError} role="alert" data-setting-error>{error}</span>}
    </label>
  )
}
