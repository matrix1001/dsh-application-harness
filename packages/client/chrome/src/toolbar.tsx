/**
 * The shared toolbar row: the one flex row applications use for filters,
 * segments and their primary action. It owns only the row's alignment, gap and
 * optional wrapping; the controls and their order stay the application's, so
 * a narrow page can still make its own choice about which controls collapse.
 * @module @matrix1001/dsh-application-harness-client-chrome/toolbar
 */
import type { ReactNode } from 'react'
import css from './shell.module.css'

/** Props of one toolbar row. */
export interface ToolbarProps {
  /** The controls, in reading order. */
  readonly children: ReactNode
  /** Allow the row to wrap (the default is a single row that clips nothing). */
  readonly wrap?: boolean
  /** Vertical alignment of the children. */
  readonly align?: 'start' | 'center'
  /** Extra class merged onto the row. */
  readonly className?: string | undefined
  /** Arbitrary `data-*` attributes forwarded to the root. */
  [dataAttr: `data-${string}`]: unknown
}

/**
 * Render one toolbar row.
 * @param props - the children, the wrap/align choice and passthrough.
 * @returns the toolbar row.
 */
export function Toolbar({ children, wrap = false, align = 'center', className, ...rest }: ToolbarProps): ReactNode {
  return (
    <div
      className={[css.toolbar, wrap ? css.toolbarWrap : undefined, align === 'start' ? css.toolbarStart : undefined, className].filter(Boolean).join(' ')}
      data-toolbar
      {...rest}
    >
      {children}
    </div>
  )
}
