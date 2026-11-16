/**
 * Script-plane tests for `scripts/platform-line.mjs`: the line surface is
 * every manifest pin, every `engines.dsh`, the workspace's cache-age and
 * override entries, the typert shell version, and the snapshot lock. The
 * negative cases matter most — a mixed line, a section that only LOOKS like a
 * pin, and a rewrite that must refuse to paper over either.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  docWarnings, inspect, parseWorkspace, problemsOf, readSnapshotLock, rewriteLine,
} from '../platform-line.mjs'

const OLD = '0.2.2-rc.1'
const NEXT = '0.2.2-rc.2'

/** Run `body` with a fresh fixture root. */
function withFixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-line-'))
  try {
    writeFixture(root)
    return body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Write a JSON file, creating parents. */
function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

/** A compact but complete line surface. */
function writeFixture(root) {
  writeJson(join(root, 'package.json'), {
    name: 'fixture',
    private: true,
    devDependencies: {
      '@deepseek-ai/dsh': OLD,
      '@deepseek-ai/dsh-llm': OLD,
      '@deepseek-ai/cordis': '4.1.0',
      '@deepseek-ai/schemastery': '3.19.0',
    },
  })
  writeJson(join(root, 'packages/application/x/package.json'), {
    name: '@matrix1001/dsh-application-harness-x',
    version: '0.1.0-dev.0',
    peerDependencies: {
      '@deepseek-ai/dsh-llm': OLD,
      '@matrix1001/dsh-application-harness-runtime': 'workspace:*',
    },
    engines: { dsh: `>=${OLD} <0.3.0-0` },
  })
  writeJson(join(root, 'packages/typert/protocol/package.json'), {
    name: '@deepseek-ai/dsh-typert-protocol',
    version: OLD,
    dependencies: { '@deepseek-ai/dsh-brand': OLD, zod: '^4.4.3' },
  })
  writeJson(join(root, 'scripts/platform-src-lock.json'), {
    declaredLine: OLD,
    tag: `dsh-v${OLD}`,
    commit: 'fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159',
    sourceMode: 'tag',
    commitsAhead: 0,
    targets: [],
    platformModules: { source: 'packages/client/web/src/platform.ts', modules: [] },
  })
  mkdirSync(join(root, 'packages/bundle/app-harness'), { recursive: true })
  writeFileSync(join(root, 'packages/bundle/app-harness/deployment.yml'), `platform:\n  declaredLine: ${OLD}\n  executionSource: checkout | registry\n`)
  writeFileSync(join(root, 'pnpm-workspace.yaml'), [
    'packages:',
    "  - 'packages/*/*'",
    '',
    'allowBuilds:',
    '  "@deepseek-ai/dsh-subprocess-local": false',
    '  koffi: false',
    '',
    'minimumReleaseAgeExclude:',
    `  - '@deepseek-ai/dsh-llm@${OLD}'`,
    `  - '@deepseek-ai/dsh-brand@${OLD}'`,
    "  - '@deepseek-ai/cordis@4.1.0'",
    '',
    'overrides:',
    `  "@deepseek-ai/dsh-llm": ${OLD}`,
    `  "@deepseek-ai/dsh-subprocess-local": ${OLD}`,
    '  "@deepseek-ai/cordis": 4.1.0',
    '',
    'public-hoist-pattern:',
    '  - "@deepseek-ai/*"',
    '',
  ].join('\n'))
  writeFileSync(join(root, 'README.md'), `需要 DSH \`>=${OLD} <0.3.0-0\` 与 Node.js。\n`)
  mkdirSync(join(root, 'docs/architecture'), { recursive: true })
  writeFileSync(join(root, 'docs/architecture/12-开发安装与发布.md'), `| 平台线 | \`engines.dsh: >=${OLD} <0.3.0-0\` |\n`)
}

test('a consistent surface has no problems, and the allowBuilds boolean is not a pin', () => withFixture((root) => {
  const state = inspect(root)
  assert.equal(state.line, OLD)
  assert.equal(state.pins.length, 4)
  assert.equal(state.engines.length, 1)
  assert.equal(state.shellVersion, OLD)
  // Two cache-age entries + two overrides; the allowBuilds boolean is skipped.
  assert.equal(state.workspace.length, 4)
  assert.deepEqual(state.workspace.map((entry) => entry.name), [
    '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-subprocess-local',
  ])
  const { problems, warnings } = problemsOf(state)
  assert.deepEqual(problems, [])
  assert.equal(warnings.length, 0)
}))

test('a mixed pin is a problem that names its site', () => withFixture((root) => {
  writeJson(join(root, 'packages/application/x/package.json'), {
    name: '@matrix1001/dsh-application-harness-x',
    version: '0.1.0-dev.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.2-rc.2' },
    engines: { dsh: `>=${OLD} <0.3.0-0` },
  })
  const { problems } = problemsOf(inspect(root))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /packages\/application\/x\/package\.json peerDependencies\.@deepseek-ai\/dsh-llm/u)
}))

test('an engines range that covers but does not name the line is a problem', () => withFixture((root) => {
  writeJson(join(root, 'packages/application/x/package.json'), {
    name: '@matrix1001/dsh-application-harness-x',
    version: '0.1.0-dev.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': OLD },
    engines: { dsh: '>=0.2.2-rc.0 <0.3.0-0' },
  })
  const { problems } = problemsOf(inspect(root))
  assert.equal(problems.length, 1)
  assert.match(problems[0], /does not name the declared line/u)
}))

test('the shell version and a stale lock line are both problems', () => withFixture((root) => {
  writeJson(join(root, 'packages/typert/protocol/package.json'), {
    name: '@deepseek-ai/dsh-typert-protocol',
    version: '0.2.1',
    dependencies: { '@deepseek-ai/dsh-brand': OLD },
  })
  const lock = JSON.parse(readFileSync(join(root, 'scripts/platform-src-lock.json'), 'utf8'))
  lock.declaredLine = '0.2.1'
  writeJson(join(root, 'scripts/platform-src-lock.json'), lock)
  const { problems } = problemsOf(inspect(root))
  assert.ok(problems.some((problem) => /typert\/protocol.*does not follow/u.test(problem)))
  assert.ok(problems.some((problem) => /platform-src-lock\.json records line/u.test(problem)))
}))

test('--dry-run reports every site and writes nothing', () => withFixture((root) => {
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  const result = rewriteLine(root, NEXT, { dryRun: true, install: false, verifyRegistry: false })
  assert.equal(result.ok, true)
  assert.equal(result.changed, true)
  assert.ok(result.changes.length >= 8)
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), before)
  assert.equal(readFileSync(join(root, 'packages/bundle/app-harness/deployment.yml'), 'utf8').includes(OLD), true)
}))

test('--set moves every plane and keeps unrelated entries byte-identical', () => withFixture((root) => {
  const result = rewriteLine(root, NEXT, { install: false, verifyRegistry: false })
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.equal(result.changed, true)

  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  assert.equal(rootManifest.devDependencies['@deepseek-ai/dsh'], NEXT)
  assert.equal(rootManifest.devDependencies['@deepseek-ai/cordis'], '4.1.0')

  const row = JSON.parse(readFileSync(join(root, 'packages/application/x/package.json'), 'utf8'))
  assert.equal(row.peerDependencies['@deepseek-ai/dsh-llm'], NEXT)
  assert.equal(row.peerDependencies['@matrix1001/dsh-application-harness-runtime'], 'workspace:*')
  assert.equal(row.engines.dsh, `>=${NEXT} <0.3.0-0`)

  const shell = JSON.parse(readFileSync(join(root, 'packages/typert/protocol/package.json'), 'utf8'))
  assert.equal(shell.version, NEXT)
  assert.equal(shell.dependencies['@deepseek-ai/dsh-brand'], NEXT)

  assert.match(readFileSync(join(root, 'packages/bundle/app-harness/deployment.yml'), 'utf8'), new RegExp(`declaredLine: ${NEXT}`, 'u'))

  const workspace = readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8')
  assert.match(workspace, new RegExp(`- '@deepseek-ai/dsh-llm@${NEXT}'`, 'u'))
  assert.match(workspace, new RegExp(`"@deepseek-ai/dsh-subprocess-local": ${NEXT}`, 'u'))
  assert.match(workspace, /"@deepseek-ai\/cordis": 4\.1\.0/u)
  assert.match(workspace, /"@deepseek-ai\/dsh-subprocess-local": false/u)
  assert.match(workspace, /# none|public-hoist-pattern:/u)

  assert.equal(readSnapshotLock(root).declaredLine, OLD)
  assert.ok(result.warnings.some((warning) => warning.includes('platform-src-lock.json still records')))
  assert.ok(result.warnings.some((warning) => warning.includes('README.md')))
}))

test('--set refuses to move on top of a mixed line', () => withFixture((root) => {
  writeJson(join(root, 'packages/application/x/package.json'), {
    name: '@matrix1001/dsh-application-harness-x',
    version: '0.1.0-dev.0',
    peerDependencies: { '@deepseek-ai/dsh-llm': '0.2.2-rc.2' },
    engines: { dsh: `>=${OLD} <0.3.0-0` },
  })
  const result = rewriteLine(root, NEXT, { install: false, verifyRegistry: false })
  assert.equal(result.ok, false)
  assert.equal(result.changed, false)
  assert.match(result.problems[0], /peerDependencies/u)
}))

test('--set refuses an invalid target before touching anything', () => withFixture((root) => {
  const result = rewriteLine(root, 'not-a-version', { install: false, verifyRegistry: false })
  assert.equal(result.ok, false)
  assert.equal(result.changed, false)
  assert.equal(readFileSync(join(root, 'package.json'), 'utf8').includes(OLD), true)
}))

test('parseWorkspace only reads the two pin sections', () => {
  const entries = parseWorkspace([
    'allowBuilds:',
    '  "@deepseek-ai/dsh-llm": false',
    'overrides:',
    `  "@deepseek-ai/dsh-llm": ${OLD}`,
    'public-hoist-pattern:',
    `  - '@deepseek-ai/dsh-brand@${OLD}'`,
    '',
  ].join('\n'))
  assert.deepEqual(entries.map((entry) => [entry.kind, entry.name, entry.version]), [['override', '@deepseek-ai/dsh-llm', OLD]])
})

test('docWarnings reports the previous rc and leaves the current line alone', () => withFixture((root) => {
  const warnings = docWarnings(root, NEXT)
  assert.equal(warnings.length, 2)
  assert.ok(warnings.every((warning) => warning.found === OLD))
}))
