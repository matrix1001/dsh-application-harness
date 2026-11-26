import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { meets, totalsOf, judge } from '../check-coverage-policy.mjs'

/** One istanbul entry: line 10 covered, line 12 not, one branch path uncovered. */
function entry() {
  return {
    s: { 0: 1, 1: 0 },
    statementMap: { 0: { start: { line: 10, column: 0 } }, 1: { start: { line: 12, column: 0 } } },
    f: { 0: 1 },
    fnMap: { 0: { name: 'covered', loc: { start: { line: 10, column: 0 } } } },
    b: { 0: [1, 0] },
    branchMap: { 0: { type: 'if', loc: { start: { line: 14, column: 0 } }, locations: [{ start: { line: 14, column: 0 } }, { start: { line: 16, column: 0 } }] } },
  }
}

describe('coverage policy', () => {
  it('counts lines, statements, functions and branch paths', () => {
    const totals = totalsOf(entry())
    assert.deepEqual(totals.lines, { covered: 1, total: 2 })
    assert.deepEqual(totals.statements, { covered: 1, total: 2 })
    assert.deepEqual(totals.functions, { covered: 1, total: 1 })
    assert.deepEqual(totals.branches, { covered: 1, total: 2 })
  })

  it('meets a percentage and treats an empty metric as met', () => {
    assert.equal(meets({ covered: 1, total: 2 }, 50), true)
    assert.equal(meets({ covered: 1, total: 2 }, 51), false)
    assert.equal(meets({ covered: 0, total: 0 }, 100), true)
  })

  it('fails a contract file below per-file 100%', () => {
    const { problems } = judge({ '/repo/packages/application/x/src/a.ts': entry() }, '/repo')
    assert.ok(problems.some(problem => problem.includes('packages/application/x/src/a.ts: lines 50.00% < 100%')))
  })

  it('does not apply per-file 100% outside the contract scope', () => {
    const { problems } = judge({ '/repo/packages/client/x/src/a.ts': entry() }, '/repo')
    assert.equal(problems.some(problem => problem.includes('packages/client/x/src/a.ts')), false)
  })

  it('fails the aggregate floor when the tree is mostly uncovered', () => {
    const empty = { ...entry(), s: { 0: 0, 1: 0 }, f: { 0: 0 }, b: { 0: [0, 0] } }
    const { problems } = judge({ '/repo/packages/client/x/src/a.ts': empty }, '/repo')
    assert.ok(problems.some(problem => problem.startsWith('all files: lines ')))
  })
})
