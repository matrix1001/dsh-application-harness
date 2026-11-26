/**
 * Script-plane tests for the platform package-set gate (`node --test`, NOT
 * vitest — vitest collects `packages/star/star/tests/star` only).
 *
 * The checked-in tree can only exhibit the in-sync case, so the version rules
 * are exercised with injected store entries and manifest readers: after a
 * platform upgrade the pnpm store still holds the previous line's directories,
 * and a name-only match would keep a removed or renamed package green forever
 * (the exact failure this gate exists to catch).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installed, storeEntryVersion } from '../verify-platform-package-set.mjs'

/** The current declared line, as the real gate reads it. */
const LINE = '0.2.3-alpha.2'

test('reads the version out of a pnpm store directory name', () => {
  assert.equal(storeEntryVersion(`@deepseek-ai+dsh-tool@${LINE}_abc123`), LINE)
  assert.equal(storeEntryVersion('@deepseek-ai+dsh-tool@0.2.2-rc.5_abc123'), '0.2.2-rc.5')
  assert.equal(storeEntryVersion('@deepseek-ai+dsh-tool'), undefined)
})

test('a store entry from an older platform line does not satisfy the reference', () => {
  const stale = ['@deepseek-ai+dsh-gone@0.2.2-rc.5_hash']
  assert.equal(installed('/repo', '@deepseek-ai/dsh-gone', () => false, stale, () => undefined, LINE), 'missing')
  assert.equal(
    installed('/repo', '@deepseek-ai/dsh-gone', () => false, [...stale, `@deepseek-ai+dsh-gone@${LINE}_hash`], () => undefined, LINE),
    'store',
  )
})

test('a hoisted package must carry the declared version', () => {
  assert.equal(installed('/repo', '@deepseek-ai/dsh-tool', () => true, [], () => LINE, LINE), 'hoisted')
  assert.equal(installed('/repo', '@deepseek-ai/dsh-tool', () => true, [], () => '0.2.2-rc.5', LINE), 'missing')
  assert.equal(
    installed('/repo', '@deepseek-ai/dsh-tool', () => true, [`@deepseek-ai+dsh-tool@${LINE}_h`], () => '0.2.2-rc.5', LINE),
    'store',
  )
})

test('the umbrella CLI is checked at the declared version too', () => {
  assert.equal(installed('/repo', '@deepseek-ai/dsh', () => true, [], () => LINE, LINE), 'hoisted')
  assert.equal(installed('/repo', '@deepseek-ai/dsh', () => true, [], () => '0.2.2-rc.5', LINE), 'missing')
})
