/**
 * Script-plane tests for the framework-generation pins (`node --test`, NOT
 * vitest — vitest collects `packages/star/star/tests/star` only).
 *
 * The checked-in tree can only exhibit the in-sync case; the drift rules are
 * exercised on synthetic `inspect()` output. A platform bump moves the
 * framework packages (cordis, the loader family, cosmokit, schemastery) through
 * the pnpm workspace overrides, while the manifests are a manual surface — the
 * exact way the 0.2.3-alpha.2 bump left schemastery at 3.19.0 in nine packages
 * while the tests ran 3.20.0-alpha.1.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { problemsOf } from '../platform-line.mjs'

/** A line state with nothing but the rows a case exercises. */
function state(framework) {
  return {
    line: '0.2.3-alpha.2',
    pins: [],
    framework,
    engines: [],
    shellVersion: undefined,
    workspace: [],
    workspaceText: '',
    docs: [],
  }
}

test('an exact framework pin must equal the installed version', () => {
  const { problems } = problemsOf(state([
    { file: 'package.json', field: 'devDependencies', name: '@deepseek-ai/schemastery', value: '3.20.0-alpha.1', installed: '3.20.0-alpha.1' },
    { file: 'apps/notes/host/package.json', field: 'dependencies', name: '@deepseek-ai/schemastery', value: '3.19.0', installed: '3.20.0-alpha.1' },
  ]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /apps\/notes\/host\/package\.json dependencies\.@deepseek-ai\/schemastery = 3\.19\.0 \(installed 3\.20\.0-alpha\.1\)/u)
})

test('a framework range must be satisfied by the installed version', () => {
  const satisfied = problemsOf(state([
    { file: 'packages/typert/protocol/package.json', field: 'peerDependencies', name: '@deepseek-ai/cordis', value: '~4.2.0-alpha.1', installed: '4.2.0-alpha.1' },
  ]))
  assert.deepEqual(satisfied.problems, [])
  const unsatisfied = problemsOf(state([
    { file: 'packages/typert/protocol/package.json', field: 'peerDependencies', name: '@deepseek-ai/cordis', value: '~4.1.0', installed: '4.2.0-alpha.1' },
  ]))
  assert.equal(unsatisfied.problems.length, 1)
})

test('a framework pin whose package is not installed is a problem', () => {
  const { problems } = problemsOf(state([
    { file: 'package.json', field: 'devDependencies', name: '@deepseek-ai/cosmokit', value: '1.10.0-alpha.1', installed: undefined },
  ]))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /not installed/u)
})

test('a state without framework rows still checks the rest', () => {
  const { problems } = problemsOf({ ...state(undefined), pins: [{ file: 'package.json', field: 'devDependencies', name: '@deepseek-ai/dsh', value: '0.2.2-rc.5' }] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /@deepseek-ai\/dsh = 0\.2\.2-rc\.5/u)
})
