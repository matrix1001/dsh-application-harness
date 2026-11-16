/**
 * Script-plane tests for the visual-scale gate.
 *
 * The gate's whole value is that it decides on a LINE of CSS, not on intent:
 * a literal size is refused, a token is allowed, an SVG label that is drawn in
 * the container's own units can say so, and a breakpoint outside the two agreed
 * values is reported rather than silently accepted. These fixtures pin exactly
 * those four decisions plus the two-level severity (hard failure vs migration
 * warning), because the gate runs inside `release:check` and a false positive
 * there blocks every unrelated change.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkStylesheet } from '../verify-app-scale.mjs'

test('a literal font-size is a hard failure', () => {
  const { fail } = checkStylesheet('.x {\n  font-size: 12px;\n}\n')
  assert.equal(fail.length, 1)
  assert.match(fail[0], /^2: literal font-size/)
})

test('a token font-size passes', () => {
  const { fail } = checkStylesheet('.x {\n  font-size: var(--app-font-meta);\n}\n')
  assert.deepEqual(fail, [])
})

test('literal gap variants are refused, tokens pass', () => {
  const failing = checkStylesheet('.x {\n  gap: 8px;\n  row-gap: 4px;\n  column-gap: 12px;\n}\n')
  assert.equal(failing.fail.length, 3)
  const passing = checkStylesheet('.x {\n  gap: var(--app-space-group);\n}\n')
  assert.deepEqual(passing.fail, [])
})

test('an em size is allowed (a label that scales with its container)', () => {
  const { fail } = checkStylesheet('.x {\n  font-size: 0.25em;\n}\n')
  assert.deepEqual(fail, [])
})

test('a scale-exempt line is skipped, and only that line', () => {
  const { fail } = checkStylesheet('.x {\n  font-size: 3.2px; /* scale-exempt */\n  gap: 10px;\n}\n')
  assert.equal(fail.length, 1)
  assert.match(fail[0], /^3: literal gap/)
})

test('line-height and odd breakpoints warn instead of failing', () => {
  const { fail, warn } = checkStylesheet('.x {\n  line-height: 18px;\n}\n@media (max-width: 719px) {\n  .y { color: red; }\n}\n')
  assert.deepEqual(fail, [])
  assert.equal(warn.length, 2)
  assert.match(warn[0], /literal line-height/)
  assert.match(warn[1], /breakpoint 719px/)
})

test('the two agreed breakpoints do not warn', () => {
  const { warn } = checkStylesheet('@media (max-width: 720px) {\n}\n@container (min-width: 1040px) {\n}\n')
  assert.deepEqual(warn, [])
})
