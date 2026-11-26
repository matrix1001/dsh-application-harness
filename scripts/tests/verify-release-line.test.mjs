/**
 * The release-line gate's judgment: a release is blocked while the checkout
 * version is unpublished, the declaration line is behind it, or the snapshot
 * commit is not the checkout HEAD. The CLI's registry/git collection is not
 * exercised here; these cases pin the decision table.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateRelease } from '../verify-release-line.mjs'

const good = {
  checkoutVersion: '0.2.2-rc.2',
  published: 'published',
  declaredLine: '0.2.2-rc.2',
  lockCommit: 'e8f7b93a3449',
  head: 'e8f7b93a3449',
  lockError: undefined,
}

test('an agreed checkout/declaration/snapshot line passes', () => {
  assert.deepEqual(evaluateRelease(good), [])
})

test('an unpublished checkout version blocks the release', () => {
  const problems = evaluateRelease({ ...good, published: 'missing' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not published to npm/u)
})

test('an unqueried registry fails closed', () => {
  assert.match(evaluateRelease({ ...good, published: 'unknown' })[0], /fail closed/u)
})

test('a declaration line behind the checkout blocks the release', () => {
  const problems = evaluateRelease({ ...good, declaredLine: '0.2.2-rc.1' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /platform-line --set 0\.2\.2-rc\.2/u)
})

test('a snapshot from another commit blocks the release', () => {
  const problems = evaluateRelease({ ...good, lockCommit: 'fcc0ad462172' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /platform-line --snapshot/u)
})
