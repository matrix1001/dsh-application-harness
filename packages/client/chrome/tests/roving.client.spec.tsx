// @vitest-environment jsdom
/**
 * The shared exclusive-choice keyboard model: the roles and state a `tablist`
 * or `radiogroup` promises, the single Tab stop, arrow/Home/End movement with
 * focus (not merely selection), and the modifier-key guard. The views keep
 * their own markup; this suite pins the contract they all consume.
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useState } from 'react'
import { useRovingGroup } from '../src/roving.ts'

afterEach(cleanup)

function Group({ role }: { role: 'tab' | 'radio' }) {
  const [active, setActive] = useState('a')
  const ids = ['a', 'b', 'c']
  const roving = useRovingGroup({ ids, active, onSelect: setActive, role })
  return (
    <div {...roving.groupProps} aria-label="group">
      {ids.map(id => (
        <button key={id} type="button" {...roving.itemProps(id)} ref={roving.itemRef(id)}>{id}</button>
      ))}
    </div>
  )
}

function buttons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button'))
}

describe('useRovingGroup', () => {
  it('declares the tablist role, one Tab stop and aria-selected', () => {
    render(<Group role="tab" />)
    expect(document.querySelector('[role="tablist"]')).not.toBeNull()
    expect(buttons().map(button => button.getAttribute('role'))).toEqual(['tab', 'tab', 'tab'])
    expect(buttons().map(button => button.tabIndex)).toEqual([0, -1, -1])
    expect(buttons()[0]!.getAttribute('aria-selected')).toBe('true')
    expect(buttons()[1]!.getAttribute('aria-selected')).toBe('false')
  })

  it('declares the radiogroup role and aria-checked instead', () => {
    render(<Group role="radio" />)
    expect(document.querySelector('[role="radiogroup"]')).not.toBeNull()
    expect(buttons().map(button => button.getAttribute('role'))).toEqual(['radio', 'radio', 'radio'])
    expect(buttons()[0]!.getAttribute('aria-checked')).toBe('true')
    expect(buttons()[1]!.getAttribute('aria-checked')).toBe('false')
  })

  it('moves selection AND focus with the arrows, wrapping at both ends', () => {
    render(<Group role="tab" />)
    buttons()[0]!.focus()
    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(buttons()[1])
    expect(buttons()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(buttons()[0]!.tabIndex).toBe(-1)
    expect(buttons()[1]!.tabIndex).toBe(0)
    fireEvent.keyDown(buttons()[1]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons()[0])
    // Wrap: left from the first lands on the last.
    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(buttons()[2])
  })

  it('jumps to the ends with Home and End', () => {
    render(<Group role="radio" />)
    buttons()[1]!.focus()
    fireEvent.keyDown(buttons()[1]!, { key: 'End' })
    expect(document.activeElement).toBe(buttons()[2])
    fireEvent.keyDown(buttons()[2]!, { key: 'Home' })
    expect(document.activeElement).toBe(buttons()[0])
    expect(buttons()[0]!.getAttribute('aria-checked')).toBe('true')
  })

  it('leaves modifier combinations to their owner', () => {
    render(<Group role="tab" />)
    buttons()[0]!.focus()
    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowRight', ctrlKey: true })
    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowRight', altKey: true })
    expect(document.activeElement).toBe(buttons()[0])
    expect(buttons()[0]!.getAttribute('aria-selected')).toBe('true')
  })
})

describe('useRovingGroup edges', () => {
  it('keeps a Tab stop when the active id is not in the list', () => {
    function Stale() {
      const roving = useRovingGroup({ ids: ['a', 'b'], active: 'gone', onSelect: () => {}, role: 'tab' })
      return (
        <div {...roving.groupProps}>
          {['a', 'b'].map(id => <button key={id} type="button" {...roving.itemProps(id)} ref={roving.itemRef(id)}>{id}</button>)}
        </div>
      )
    }
    render(<Stale />)
    expect(buttons().map(button => button.tabIndex)).toEqual([0, -1])
    expect(buttons()[0]!.getAttribute('aria-selected')).toBe('false')
  })

  it('ignores arrows and Home/End when the group has no items', () => {
    function Empty() {
      const roving = useRovingGroup({ ids: [], active: '', onSelect: () => {}, role: 'radio' })
      return (
        <div {...roving.groupProps}>
          <button type="button" {...roving.itemProps('ghost')}>ghost</button>
        </div>
      )
    }
    render(<Empty />)
    const ghost = buttons()[0]!
    ghost.focus()
    fireEvent.keyDown(ghost, { key: 'Home' })
    fireEvent.keyDown(ghost, { key: 'End' })
    fireEvent.keyDown(ghost, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(ghost)
  })

  it('takes the vertical orientation on the group', () => {
    function Vertical() {
      const roving = useRovingGroup({ ids: ['a', 'b'], active: 'a', onSelect: () => {}, role: 'radio', orientation: 'vertical' })
      return <div {...roving.groupProps}>{['a', 'b'].map(id => <button key={id} type="button" {...roving.itemProps(id)} ref={roving.itemRef(id)}>{id}</button>)}</div>
    }
    render(<Vertical />)
    expect(document.querySelector('[role="radiogroup"]')!.getAttribute('aria-orientation')).toBe('vertical')
    fireEvent.keyDown(buttons()[0]!, { key: 'ArrowDown' })
    expect(document.activeElement).toBe(buttons()[1])
  })
})
