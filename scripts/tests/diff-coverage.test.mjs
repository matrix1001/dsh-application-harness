import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { countLocations, judgeDiff, parseAddedLines } from '../check-diff-coverage.mjs'

const diff = [
  'diff --git a/packages/x/src/a.ts b/packages/x/src/a.ts',
  '--- a/packages/x/src/a.ts',
  '+++ b/packages/x/src/a.ts',
  '@@ -1,2 +1,3 @@',
  '@@ -20,0 +22,2 @@',
  'diff --git a/docs/readme.md b/docs/readme.md',
  '+++ b/docs/readme.md',
  '@@ -1,0 +2 @@',
].join('\n')

/** One entry with statements on 1..3 and a branch on 3. */
function entry() {
  return {
    s: { 0: 1, 1: 0, 2: 0 },
    statementMap: { 0: { start: { line: 1, column: 0 } }, 1: { start: { line: 2, column: 0 } }, 2: { start: { line: 3, column: 0 } } },
    f: {},
    fnMap: {},
    b: { 0: [1, 0] },
    branchMap: { 0: { type: 'if', loc: { start: { line: 3, column: 0 } }, locations: [{ start: { line: 3, column: 0 } }, { start: { line: 4, column: 0 } }] } },
  }
}

describe('diff coverage', () => {
  it('parses added line numbers per file and drops file-level hunks', () => {
    const files = parseAddedLines(diff)
    assert.deepEqual([...files.get('packages/x/src/a.ts')].sort((a, b) => a - b), [1, 2, 3, 22, 23])
    assert.deepEqual([...files.get('docs/readme.md')], [2])
  })

  it('counts only locations that start on a changed line', () => {
    const counts = countLocations(entry(), new Set([1, 2]))
    assert.deepEqual(counts, { covered: 1, total: 2 })
  })

  it('fails the aggregate when changed locations are uncovered', () => {
    const report = { '/repo/packages/x/src/a.ts': entry() }
    const { problems, covered, total } = judgeDiff(report, new Map([['packages/x/src/a.ts', new Set([2, 3])]]), '/repo', 90)
    // Statements on 2 and 3 are uncovered; the first branch path on line 3 is covered.
    assert.equal(covered, 1)
    assert.equal(total, 3)
    assert.ok(problems.some(problem => problem.includes('changed lines: 33.33% < 90%')))
  })

  it('fails a changed file with no covered location even when the aggregate passes', () => {
    const report = { '/repo/packages/x/src/a.ts': entry() }
    const { problems } = judgeDiff(report, new Map([['packages/x/src/a.ts', new Set([2])]]), '/repo', 90)
    assert.ok(problems.some(problem => problem.includes('none covered')))
  })

  it('ignores changed files outside the coverage report', () => {
    const { problems, total } = judgeDiff({}, new Map([['packages/x/src/a.ts', new Set([1])]]), '/repo', 90)
    assert.equal(total, 0)
    assert.equal(problems.length, 0)
  })
})
