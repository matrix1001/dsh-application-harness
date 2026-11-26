/** A fenced code block with the one local copy control. */
import { useState } from 'react'
import css from './ui.module.css'

export interface FenceCodeBlockProps {
  readonly lang?: string | undefined
  readonly code: string
  readonly streaming?: boolean
  readonly labels: { readonly copyLabel: string; readonly copiedLabel: string }
}

export function FenceCodeBlock({ code, labels }: FenceCodeBlockProps) {
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => { setCopied(false) }, 1200)
    }).catch(() => undefined)
  }
  return (
    <div className={css.fence}>
      <pre><code>{code}</code></pre>
      <button type="button" className={css.fenceCopy} onClick={copy}>{copied ? labels.copiedLabel : labels.copyLabel}</button>
    </div>
  )
}
