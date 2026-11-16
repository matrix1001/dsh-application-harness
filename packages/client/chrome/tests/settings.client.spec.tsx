// @vitest-environment jsdom
/**
 * The shared settings layout (`settings.tsx`): a titled group of label+control
 * rows whose accessibility comes from the row being the label itself, and an
 * action bar that is a SIBLING of the scrolling body — visible without
 * scrolling to the end, and never covering the last field.
 *
 * Purely presentational: every string here is one the caller already
 * localized, and the layout interprets none of them.
 */
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { SettingRow, SettingsGroup, SettingsLayout } from '../src/settings.tsx'

afterEach(() => { cleanup() })

describe('SettingsLayout', () => {
  it('keeps the action bar out of the scrolling body and beside its status', () => {
    const view = render(
      <SettingsLayout status={<span>unsaved</span>} footer={<button type="button">Save</button>} data-settings-test>
        <SettingsGroup title="Preferences">
          <SettingRow label="Default tag" hint="Used when a note is created">
            <input defaultValue="reading" />
          </SettingRow>
        </SettingsGroup>
      </SettingsLayout>,
    )
    const root = view.container.querySelector('[data-settings-page]') as HTMLElement
    const body = view.container.querySelector('[data-settings-body]') as HTMLElement
    const foot = view.container.querySelector('[data-settings-foot]') as HTMLElement
    expect(root.dataset.settingsTest).toBe('true')
    // The body scrolls; the bar is its SIBLING, not a child of it.
    expect(body.contains(foot)).toBe(false)
    expect(body.textContent).toContain('Default tag')
    expect(view.getByRole('button', { name: 'Save' })).toBeDefined()
    expect(foot.textContent).toContain('unsaved')
  })

  it('can be a page with a body and no action bar at all', () => {
    const view = render(<SettingsLayout><SettingsGroup title="Only"><SettingRow label="Row"><input /></SettingRow></SettingsGroup></SettingsLayout>)
    expect(view.container.querySelector('[data-settings-foot]')).toBeNull()
    expect(view.container.querySelector('[data-settings-body]')).not.toBeNull()
  })
})

describe('SettingRow', () => {
  it('names its control by being the label, and reports an error where it belongs', () => {
    const view = render(
      <SettingRow label="Refresh period" hint="How often sources are read" error="Must be at least 5 minutes">
        <select defaultValue="15"><option value="15">15</option></select>
      </SettingRow>,
    )
    // The implicit association: the control's accessible name is the row's
    // label text, with no id wiring between the two.
    expect(view.getByRole('combobox', { name: /Refresh period/u })).toBeDefined()
    // The hint is not part of the name (it sits outside the control's own text
    // node), and the error is an alert.
    expect(view.getByText('How often sources are read')).toBeDefined()
    expect(view.getByRole('alert').textContent).toBe('Must be at least 5 minutes')
    expect(view.container.querySelector('[data-setting-row]')).not.toBeNull()
  })

  it('renders without a hint or an error', () => {
    const view = render(<SettingRow label="Path"><input /></SettingRow>)
    expect(view.queryByRole('alert')).toBeNull()
    expect(view.getByRole('textbox', { name: /Path/u })).toBeDefined()
  })
})
