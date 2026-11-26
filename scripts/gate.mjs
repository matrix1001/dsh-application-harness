#!/usr/bin/env node
/**
 * Named local quality gate. `release:check` remains the one-command contract;
 * this runner exposes the SAME checks as named steps so a developer can run one
 * stage (or a subset) without editing the chain, and prints a timing summary
 * instead of a wall of `&&`.
 *
 * Usage:
 *   node scripts/gate.mjs                 # every step, stop at the first failure
 *   node scripts/gate.mjs --only build,test
 *   node scripts/gate.mjs --list
 *   node scripts/gate.mjs --keep-going    # run every selected step, report failures
 * @module scripts/gate
 */
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const STEPS = [
  { name: 'typecheck', command: 'pnpm', args: ['run', 'typecheck'], description: 'host/client TypeScript + test-type pass' },
  { name: 'docs', command: 'pnpm', args: ['run', 'check:docs'], description: 'docs links, anchors, commands and budget' },
  { name: 'coverage', command: 'pnpm', args: ['run', 'test:coverage'], description: 'unit suite + per-file thresholds' },
  { name: 'build', command: 'pnpm', args: ['run', 'build'], description: 'host and browser artifacts' },
  { name: 'scripts', command: 'pnpm', args: ['run', 'test:scripts'], description: 'script self-tests' },
  { name: 'publint', command: 'pnpm', args: ['-r', 'exec', 'publint'], description: 'published package shape' },
  {
    name: 'contracts',
    commands: [
      ['scripts/verify-build-role.mjs'], ['scripts/verify-engines.mjs'], ['scripts/verify-node-line.mjs'], ['scripts/verify-version-sync.mjs'],
      ['scripts/verify-machinery-rows.mjs'], ['scripts/verify-platform-package-set.mjs'],
      ['scripts/verify-deployment-descriptor.mjs'], ['scripts/verify-layer-deps.mjs'],
      ['scripts/verify-example-compositions.mjs'],
      ['scripts/verify-inject-contract.mjs'], ['scripts/verify-client-peer-shape.mjs'],
      ['scripts/verify-client-factory.mjs'], ['scripts/verify-pack.mjs'], ['scripts/verify-runtime-deps.mjs'],
      ['scripts/verify-app-scale.mjs', '--strict'],
      ['scripts/verify-api-snapshot.mjs'],
      ['scripts/platform-line.mjs', '--check'],
      ['scripts/check-ignore-reasons.mjs'],
      ['scripts/check-client-ui-imports.mjs'],
      ['scripts/check-skills.mjs'],
      ['scripts/sync-platform-fixture.mjs', '--check'],
    ].map(args => ({ command: 'node', args })),
    description: 'repository contracts and packaging checks',
  },
  {
    name: 'platform',
    commands: [
      { command: 'node', args: ['scripts/launch-apps.mjs', '--check-only'] },
      { command: 'node', args: ['scripts/verify-platform-modules.mjs'] },
      { command: 'node', args: ['scripts/generate-bundle-patch.mjs', '--check'] },
    ],
    description: 'launch preflight, platform snapshot and generated patch',
  },
  {
    name: 'smoke',
    command: 'node',
    args: ['scripts/smoke.mjs', 'applications'],
    description: 'keyless composition smoke',
  },
  {
    name: 'smoke-tooled',
    command: 'node',
    args: ['scripts/smoke.mjs', 'applications', '--tooled'],
    description: 'keyless composition smoke with the agent tool face',
  },
]

/** Parse the small flag vocabulary; unknown flags fail loudly. */
function parseArgs(argv) {
  const options = { only: [], keepGoing: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--list') { options.list = true; continue }
    if (token === '--json') { options.json = true; continue }
    if (token === '--keep-going') { options.keepGoing = true; continue }
    if (token === '--only') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error('--only needs a comma-separated step list')
      options.only = value.split(',').map(entry => entry.trim()).filter(entry => entry !== '')
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${token}`)
  }
  return options
}

const options = parseArgs(process.argv.slice(2))
const known = new Set(STEPS.map(step => step.name))
for (const name of options.only) {
  if (!known.has(name)) throw new Error(`unknown gate step: ${name} (known: ${[...known].join(', ')})`)
}
if (options.list === true) {
  for (const step of STEPS) process.stdout.write(`${step.name.padEnd(14)} ${step.description}\n`)
  process.exit(0)
}
if (options.json === true) {
  const printable = STEPS.map(step => ({
    name: step.name,
    description: step.description,
    commands: (step.commands ?? [{ command: step.command, args: step.args }]).map(command => [command.command, ...command.args].join(' ')),
  }))
  process.stdout.write(`${JSON.stringify(printable)}\n`)
  process.exit(0)
}

const selected = options.only.length === 0 ? STEPS : STEPS.filter(step => options.only.includes(step.name))
const results = []
for (const [index, step] of selected.entries()) {
  process.stdout.write(`\n[gate] ${index + 1}/${selected.length} ${step.name} — ${step.description}\n`)
  const startedAt = Date.now()
  const commands = step.commands ?? [{ command: step.command, args: step.args }]
  let ok = true
  for (const command of commands) {
    const result = spawnSync(command.command, command.args, { cwd: ROOT, stdio: 'inherit' })
    if (result.status !== 0) { ok = false; break }
  }
  results.push({ name: step.name, ok, durationMs: Date.now() - startedAt })
  if (!ok && !options.keepGoing) break
}

process.stdout.write('\n[gate] summary\n')
for (const result of results) {
  process.stdout.write(`  ${result.ok ? 'PASS' : 'FAIL'} ${result.name.padEnd(14)} ${String(result.durationMs)} ms\n`)
}
const failed = results.filter(result => !result.ok)
process.exit(failed.length === 0 ? 0 : 1)
