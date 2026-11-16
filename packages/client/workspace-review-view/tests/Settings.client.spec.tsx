// @vitest-environment jsdom
import { createElement } from 'react'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceReviewSettings } from '../src/client/Settings.tsx'
import { SETTINGS, failed, makeCall, ok, translator } from './view-harness.tsx'

afterEach(() => { cleanup() })

const t = translator() as never

function renderSettings(call = makeCall()) {
  render(createElement(WorkspaceReviewSettings, { call: call.call, t } as never))
  return call
}

describe('WorkspaceReviewSettings', () => {
  it('loads the settings, edits every field and saves the patch', async () => {
    const call = renderSettings()
    await waitFor(() => { expect(document.querySelector('[data-wr-settings]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-setting="dsh"]')!, { target: { value: '/new/dsh' } })
    fireEvent.change(document.querySelector('[data-wr-setting="claudeCode"]')!, { target: { value: '/new/claude' } })
    fireEvent.change(document.querySelector('[data-wr-setting="codex"]')!, { target: { value: '/new/codex' } })
    fireEvent.click(document.querySelector('[data-wr-setting="redact"]')!)
    fireEvent.change(document.querySelector('[data-wr-setting="retention"]')!, { target: { value: '5' } })
    fireEvent.click(document.querySelector('[data-wr-setting="ai"]')!)
    call.respond('setSettings', args => ok({ ...SETTINGS, ...(args.patch as object) }))
    fireEvent.change(document.querySelector('[data-wr-setting="dsh"]')!, { target: { value: '/tmp/dsh' } })
    fireEvent.click(document.querySelector('[data-wr-settings-save]')!)
    await waitFor(() => { expect(call.calls.some(entry => entry.op === 'setSettings')).toBe(true) })
    expect(document.querySelector('[data-wr-settings-saved]')).toBeTruthy()
  })

  it('reports a failed load and a failed save', async () => {
    const loadFailure = makeCall({ settings: () => failed('no settings') })
    renderSettings(loadFailure)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings-loading]')).toBeTruthy() })
    loadFailure.respond('settings', () => ok(SETTINGS))
    fireEvent.click(document.querySelector('[data-wr-settings-retry]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings]')).toBeTruthy() })
    cleanup()
    const call = makeCall({ setSettings: () => failed('save failed') })
    renderSettings(call)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-setting="dsh"]')!, { target: { value: '/tmp/dsh' } })
    fireEvent.click(document.querySelector('[data-wr-settings-save]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings-error]')).toBeTruthy() })
  })
})

describe('WorkspaceReviewSettings failures', () => {
  it('reports a rejected load and a rejected save', async () => {
    const loadFailure = makeCall({ settings: () => { throw new Error('load boom') } })
    renderSettings(loadFailure)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings-loading]')?.textContent).toContain('load boom') })
    cleanup()
    const saveFailure = makeCall({ setSettings: () => { throw new Error('save boom') } })
    renderSettings(saveFailure)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-setting="dsh"]')!, { target: { value: '/tmp/dsh' } })
    fireEvent.click(document.querySelector('[data-wr-settings-save]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings-error]')?.textContent).toContain('save boom') })
  })
})

describe('WorkspaceReviewSettings cancelled and non-Error failures', () => {
  it('keeps the loading state for a cancelled load and localizes a non-Error throw', async () => {
    const cancelled = makeCall({ settings: () => ({ callId: 'c', status: 'cancelled' }) })
    renderSettings(cancelled)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings-loading]')).toBeTruthy() })
    cleanup()
    const loadFailure = makeCall({ settings: () => { throw 'offline' } })
    renderSettings(loadFailure)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings-loading]')?.textContent).not.toBe('') })
    cleanup()
    const saveFailure = makeCall({ setSettings: () => { throw 'save offline' } })
    renderSettings(saveFailure)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings]')).toBeTruthy() })
    fireEvent.change(document.querySelector('[data-wr-setting="dsh"]')!, { target: { value: '/tmp/dsh' } })
    fireEvent.click(document.querySelector('[data-wr-settings-save]')!)
    await waitFor(() => { expect(document.querySelector('[data-wr-settings-error]')).toBeTruthy() })
  })
})
