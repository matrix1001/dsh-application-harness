/** The localized app-conversation setup error: map the host's stable reason, never echo it raw. */
import { describe, expect, it } from 'vitest'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { setupErrorMessage } from '../src/client/ApplicationsArea.tsx'

const t = ((key: string): string => key) as TranslateNS<'applications'>

describe('app conversation setup errors', () => {
  it('maps missing, non-directory and relative paths to localized copy', () => {
    expect(setupErrorMessage(new Error('the application conversation workspace must already exist; choose an existing folder'), t))
      .toBe('conversation.setup.missing')
    expect(setupErrorMessage(new Error('the application conversation workspace must be a real directory, not a file or symlink'), t))
      .toBe('conversation.setup.notDirectory')
    expect(setupErrorMessage(new Error('the application conversation workspace path must be absolute'), t))
      .toBe('conversation.setup.absolute')
  })

  it('keeps an unknown reason behind the generic localized prefix', () => {
    expect(setupErrorMessage(new Error('boom'), t)).toBe('conversation.setup.failed')
    expect(setupErrorMessage('plain', t)).toBe('conversation.setup.failed')
  })
})
