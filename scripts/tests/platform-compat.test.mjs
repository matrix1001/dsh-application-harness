/**
 * Script-plane tests for `scripts/platform-compat.mjs`: selection, the
 * package-hit index, and the output tail. The command runner itself is the
 * gate's own commands; these tests pin the report's shape, not the platform.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CHECKS, outputTail, packageHits, selectChecks } from '../platform-compat.mjs'

test('selectChecks defaults to every check and --skip-heavy drops build/test', () => {
  assert.equal(selectChecks(undefined).length, CHECKS.length)
  const fast = selectChecks(undefined, true)
  assert.deepEqual(fast.map((check) => check.name), ['line', 'snapshot', 'modules', 'package-set', 'engines', 'symbols', 'launch', 'smoke', 'smoke-tooled'])
})

test('selectChecks honors an explicit list and an empty selection', () => {
  assert.deepEqual(selectChecks('line,build').map((check) => check.name), ['line', 'build'])
  assert.deepEqual(selectChecks('nope').map((check) => check.name), [])
})

test('packageHits ranks the packages a failing output names', () => {
  const hits = packageHits([
    'packages/client/applications/src/index.ts(3,1): error TS1',
    'packages/client/applications/src/views.ts(8,1): error TS2',
    'packages/application/runtime/src/index.ts(1,1): error TS3',
    'node_modules/@deepseek-ai/dsh-llm/lib/index.js',
  ].join('\n'))
  assert.deepEqual(hits.slice(0, 2), [
    { package: 'packages/client/applications', hits: 2 },
    { package: 'packages/application/runtime', hits: 1 },
  ])
})

test('outputTail keeps the failing tail and the short passing head', () => {
  const long = `${'x'.repeat(30000)}FAIL`
  assert.equal(outputTail(long, true).length, 24000)
  assert.match(outputTail(long, true), /FAIL$/u)
  assert.equal(outputTail('short', false), 'short')
})
