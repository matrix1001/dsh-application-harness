/**
 * The shared application world-view page chrome: `Section` (header + card
 * surface / bounded scroll) and `TabBar` (dsh-style view tab ring), plus the
 * narrowing primitives every view reads op results with (./narrow.ts). Every
 * application world view composes the same page language from the two
 * presentational components, plus the shared modal focus lifecycle
 * (`useModalFocus`, used by every dialog two or more views really share), the
 * shared markdown renderer (`renderMarkdown`, ./markdown.tsx — one parse and
 * render pass for the workbook note body and the info-hub release note, whose
 * real differences ride options rather than a second copy), and every
 * consuming client bundle inlines this
 * library's own copy ("silence means a private copy" — no cross-plugin
 * runtime identity to share), so disk-analysis, workbook and info-hub all read
 * the same Section grammar without a cross-bundle value import.
 */
import type { ReactNode, Ref } from 'react'
import css from './shell.module.css'
import { useRovingGroup } from './roving.ts'

export { finiteOr, isRecord, stringList, stringOr } from './narrow.ts'
export { safeHrefForExternal } from './safe-href.ts'
export { failureKindOf, hasAppCode, isPermissionKind, outcomeFailure, outcomeMessage, outcomeValue, type FailureDetail, type FailureKind } from './failure.ts'
export { Button, type ButtonProps } from './ui/Button.tsx'
export { Switch, type SwitchProps } from './ui/Switch.tsx'
export { Tooltip, type TooltipProps } from './ui/Tooltip.tsx'
export { Modal, type ModalProps } from './ui/Modal.tsx'
export { Menu, MenuItemButton, type MenuEntry, type MenuLabelEntry, type MenuItemEntry, type MenuSeparatorEntry } from './ui/Menu.tsx'
export { FenceCodeBlock, type FenceCodeBlockProps } from './ui/FenceCodeBlock.tsx'
export {
  IconAppsAddOutlineRegular, IconBranchOutlineRegular, IconChecklistOutlineRegular, IconCheckOutlineRegular,
  IconChevronDownOutlineRegular, IconChevronLeftOutlineRegular, IconChevronRightOutlineRegular, IconCodeOutlineRegular,
  IconCordisPluginOutlineRegular, IconEllipsisOutlineRegular, IconGaugeOutlineRegular, IconGlobeOutlineRegular,
  IconListPenOutlineRegular, IconNewChatOutlineRegular, IconPanelLeftOutlineRegular, IconPlusOutlineRegular,
  IconPinFillRegular, IconPinOutlineRegular, IconQueueOutlineRegular, IconRightUpOutlineRegular,
  IconSettingsOutlineRegular, IconWarningOutlineRegular, type IconProps,
} from './ui/icons.tsx'
export { renderMarkdown } from './markdown.tsx'
export type { MarkdownClassNames, MarkdownOptions } from './markdown.tsx'
export { focusablesOf, useModalFocus } from './modal-focus.ts'
export { useConfirm, type ConfirmController, type ConfirmOptions } from './confirm.tsx'
export { BusyBar, NoticeLayer, type NoticeAction, type NoticeItem } from './notices.tsx'
export { EmptyState, type EmptyStateProps } from './empty-state.tsx'
export { ReadFailure, type ReadFailureProps } from './read-failure.tsx'
export { LocalFailure, type LocalFailureProps } from './local-failure.tsx'
export { Field, type FieldProps } from './field.tsx'
export { Toolbar, type ToolbarProps } from './toolbar.tsx'
export {
  useRovingGroup,
  type RovingGroup, type RovingGroupOptions, type RovingItemProps, type RovingRole,
} from './roving.ts'
export { createSnapshotStore, type SnapshotSelectorHook, type SnapshotStore, type SnapshotStoreOptions } from './snapshot-store.ts'
export { useUiChoice, useUiField, useUiState, type ApplicationUiPatch, type ApplicationUiState, type ApplicationUiStore } from './view-state.ts'
export { useScrollMemory, type ScrollMemory, type ScrollMemoryOptions } from './scroll-memory.ts'
export {
  SettingRow, SettingsGroup, SettingsLayout,
  type SettingRowProps, type SettingsGroupProps, type SettingsLayoutProps,
} from './settings.tsx'
export { formatFullTimestamp, formatLocalDateTime } from './time.ts'
export type { TimeFormatOptions } from './time.ts'

/** Combine class parts, dropping empty/undefined entries. */
function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** Props of one shell Section: an optional header over a body. */
export interface SectionProps {
  /** Short section heading (13px/600). */
  title?: string
  /** Secondary line under the title (11px, muted). */
  caption?: string
  /** Right-aligned action node (e.g. a count, a refresh button). */
  action?: ReactNode
  /**
   * Render the body as a card surface. Default FALSE: an ordinary grouping
   * (a page header, a form band, a table region) is organized by its heading,
   * its spacing and the page's own rhythm — not by a floating card around it.
   * Set it where the body really is a bounded tool: a panel with its own
   * scrollbar, a repeated independent item, a detail pane, a state notice.
   */
  surface?: boolean
  /** Make the body a bounded scroll area (max-height + themed scrollbar); default false. */
  scroll?: boolean
  /** The scrolling body element, for a caller that binds its scroll position (`useScrollMemory`). */
  bodyRef?: Ref<HTMLDivElement> | undefined
  /** The section content. */
  children: ReactNode
  /** Extra class merged onto the section root (`undefined` allowed:
   * `exactOptionalPropertyTypes` + a CSS-module class map). */
  className?: string | undefined
  /** Arbitrary `data-*` attributes forwarded to the section root (test/locator anchors). */
  [dataAttr: `data-${string}`]: unknown
}

/** One tab of a world-view `TabBar`: an identity plus a short visible label. */
export interface AppTab {
  /** Stable tab id (the caller's active-tab key). */
  id: string
  /** The tab's visible label. */
  label: string
  /** An optional attention dot after the label (e.g. "there is something new");
   * `undefined` omits it. Purely presentational. */
  dot?: boolean | undefined
  /**
   * Per-tab `data-*` anchors, spread onto THIS tab's button. The ring root has
   * its own passthrough (`data-info-tabs` …); this is the per-tab half, so a
   * view whose tabs each carry their own identity (`data-disk-tab="changes"`)
   * can adopt the shared ring without renaming every locator. Chrome's own
   * semantics (role/aria-selected/tabIndex/handlers) are applied AFTER the
   * spread: an anchor can name a tab, never re-define it.
   */
  anchor?: Readonly<Record<string, string>> | undefined
  /**
   * An optional node rendered after the label INSIDE the tab (a count badge, an
   * icon). Chrome stays presentational — it does not interpret the node; the
   * view owns its own markup and styles.
   */
  suffix?: ReactNode
}

/** Props of one shell TabBar: the ordered tabs, the active id, and a select callback. */
export interface TabBarProps {
  /** An explicit accessible name; when omitted the tab labels name the group. */
  label?: string
  /**
   * The page's own tools (search box, primary action), rendered on the same row
   * as the tabs. This is what keeps an application's chrome at two rows: the
   * tabs and the tools share one 44px strip instead of stacking a toolbar under
   * the tabs and pushing the first data row down.
   */
  tools?: ReactNode
  /** The tabs in order; an empty array renders an empty tablist. */
  tabs: readonly AppTab[]
  /** The currently selected tab id (must match one of `tabs`). */
  active: string
  /** Called with the clicked tab's id. */
  onSelect: (id: string) => void
  /** Extra class merged onto the tablist root (`undefined` allowed:
   * `exactOptionalPropertyTypes` + a CSS-module class map). */
  className?: string | undefined
  /** Arbitrary `data-*` attributes forwarded to the tablist root (test/locator anchors). */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * A world-view page section: an optional header (title + caption + action)
 * over a body that is a card surface by default and a bounded scroll area when
 * `scroll` is set. A purely presentational component — no state, no run
 * semantics; the views own their content.
 * @param props - header facts, the body surface/bare switch, and the content.
 * @returns the section element.
 */
export function Section({ title, caption, action, surface = false, scroll = false, bodyRef, children, className, ...rest }: SectionProps) {
  const hasHeader = title !== undefined || caption !== undefined || action !== undefined
  return (
    <section className={cx(css.section, className)} {...rest}>
      {hasHeader && (
        <header className={css.header}>
          <div className={css.headTitle}>
            {title !== undefined && <h3 className={css.title}>{title}</h3>}
            {caption !== undefined && <span className={css.caption}>{caption}</span>}
          </div>
          {action !== undefined && <div className={css.action}>{action}</div>}
        </header>
      )}
      <div ref={bodyRef} className={cx(css.body, surface && css.surface, scroll && css.scroll)}>
        {children}
      </div>
    </section>
  )
}

/**
 * A dsh-style world-view tab ring: a `role="tablist"` of `role="tab"` buttons,
 * the active one marked and underlined. Presentational — the caller owns the
 * selected id and the page it renders. Mirrors the conversation view-ring
 * chrome so an application page reads like a session's paged views.
 * @param props - the ordered tabs, the active id, the select callback, and the
 *   class/data passthrough.
 * @returns the tablist element.
 */
export function TabBar({ tabs, active, onSelect, className, tools, label, ...rest }: TabBarProps) {
  const roving = useRovingGroup({ ids: tabs.map(tab => tab.id), active, onSelect, role: 'tab' })
  const list = (
    <div className={cx(css.tabBar, className)} aria-label={label ?? tabs.map(tab => tab.label).join(' / ')} {...roving.groupProps} {...rest}>
      {tabs.map(tab => (
        <button
          key={tab.id}
          type="button"
          {...tab.anchor}
          {...roving.itemProps(tab.id)}
          ref={roving.itemRef(tab.id)}
          className={cx(css.tab, tab.id === active && css.tabActive)}
        >
          {tab.label}
          {tab.suffix}
          {tab.dot === true ? <span className={css.tabDot} aria-hidden="true" /> : null}
        </button>
      ))}
    </div>
  )
  // The DOM stays exactly as it was when a page passes no tools: adding a
  // wrapper unconditionally would move every existing `[data-*]` tablist one
  // level deeper for callers that never asked for the row.
  if (tools === undefined) return list
  return (
    <div className={css.tabRow}>
      {list}
      <div className={css.tabTools}>{tools}</div>
    </div>
  )
}
