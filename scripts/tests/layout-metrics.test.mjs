/**
 * Script-plane tests for the layout budget.
 *
 * The budget's value is that it is a NUMBER the lane can fail on: 200px on a
 * desktop viewport, 260 narrow, 24/16 page inset. These fixtures pin the
 * boundary (exactly at the limit passes, one pixel over fails) and the two
 * "we measured nothing" cases, because a missing measurement must never read as
 * a pass — that is how the old pages drifted 190px without anyone noticing.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LAYOUT_BUDGET, judgeLayout, judgeMatrix, summarizeFonts, viewportClassOf } from '../layout-metrics.mjs'

test('the viewport classes split at the agreed breakpoint', () => {
  assert.equal(viewportClassOf(1440), 'desktop')
  assert.equal(viewportClassOf(720), 'desktop')
  assert.equal(viewportClassOf(719), 'narrow')
  assert.equal(LAYOUT_BUDGET.firstContent.desktop, 200)
  assert.equal(LAYOUT_BUDGET.firstContent.narrow, 260)
})

test('exactly at the budget passes, one pixel over fails', () => {
  const at = judgeLayout({ app: 'workbook', viewport: 1440, firstContentY: 200, pageInline: 24 })
  assert.equal(at.ok, true)
  const over = judgeLayout({ app: 'workbook', viewport: 1440, firstContentY: 201, pageInline: 24 })
  assert.equal(over.ok, false)
  assert.match(over.findings[0], /201px, budget 200px/)
})

test('a narrow viewport gets the phone budget', () => {
  const phone = judgeLayout({ app: 'disk-analysis', viewport: 390, firstContentY: 250, pageInline: 16 })
  assert.equal(phone.ok, true)
  const tooLow = judgeLayout({ app: 'disk-analysis', viewport: 390, firstContentY: 261, pageInline: 16 })
  assert.equal(tooLow.ok, false)
})

test('a wrong page inset is reported, not rounded away', () => {
  const wrong = judgeLayout({ app: 'info-hub', viewport: 1440, firstContentY: 120, pageInline: 22 })
  assert.equal(wrong.ok, false)
  assert.match(wrong.findings[0], /page inset 22px, expected 24px/)
})

test('no measurement is a failure, never a skip', () => {
  const nothing = judgeLayout({ app: 'git-read', viewport: 1024, firstContentY: undefined, pageInline: undefined })
  assert.equal(nothing.ok, false)
  assert.equal(nothing.findings.length, 2)
})

test('a matrix is as green as its worst sample', () => {
  const green = judgeMatrix([
    { app: 'workbook', viewport: 1440, firstContentY: 190, pageInline: 24 },
    { app: 'git-read', viewport: 1440, firstContentY: 180, pageInline: 24 },
  ])
  assert.equal(green.ok, true)
  const red = judgeMatrix([
    { app: 'workbook', viewport: 1440, firstContentY: 190, pageInline: 24 },
    { app: 'git-read', viewport: 1440, firstContentY: 240, pageInline: 24 },
  ])
  assert.equal(red.ok, false)
  assert.equal(red.results.filter(result => !result.ok).length, 1)
})

test('the font histogram separates the scale from its strays', () => {
  const summary = summarizeFonts([
    { size: 13, count: 54 },
    { size: 12, count: 103 },
    { size: 14, count: 2 },
    { size: 10, count: 1 },
  ])
  assert.equal(summary.total, 160)
  assert.equal(summary.withinScale.body, 54)
  assert.equal(summary.withinScale.meta, 103)
  assert.deepEqual(summary.offScale, [{ size: 14, count: 2 }, { size: 10, count: 1 }])
})
