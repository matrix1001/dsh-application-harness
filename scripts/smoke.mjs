#!/usr/bin/env node
/**
 * Keyless composition smoke: boot one example cordis.yml through the harness
 * Loader with the driver row appended, exercise the runtime through a human
 * read, an AI read (direct or through the tool face in tooled mode), and an
 * application-to-application read. The driver owns the leg/history assertions
 * and exits non-zero on any failure.
 *
 * Usage:
 *   node scripts/smoke.mjs applications [--tooled]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const [exampleDir, tooled] = [process.argv[2], process.argv.includes('--tooled')]
if (!exampleDir) throw new Error('usage: smoke.mjs <examples-dir> [--tooled]')

const sourceDir = resolve(repoRoot, 'examples', exampleDir)
const config = resolve(sourceDir, tooled ? 'tooled.cordis.yml' : 'cordis.yml')
if (!existsSync(config)) throw new Error(`no composition at ${config}`)
const loader = resolve(repoRoot, 'node_modules/@deepseek-ai/cordis/bin.js')
if (!existsSync(loader)) throw new Error(`cordis loader missing at ${loader}`)
const tsxEntry = resolve(repoRoot, 'node_modules/tsx/dist/esm/index.mjs')
const driver = resolve(repoRoot, 'examples/applications/tests/smoke-driver.ts')

const work = mkdtempSync(join(repoRoot, 'tmp/smoke-work-'))
try {
  cpSync(sourceDir, work, { recursive: true })
  if (tooled) {
    writeFileSync(resolve(work, 'cordis.base.yml'), readFileSync(resolve(sourceDir, 'cordis.yml'), 'utf8'))
    const rows = readFileSync(config, 'utf8').trimEnd().replaceAll('./cordis.yml', './cordis.base.yml')
    writeFileSync(resolve(work, 'cordis.yml'), `${rows}\n- id: smoke-driver\n  name: '${driver}'\n`)
  } else {
    const rows = readFileSync(config, 'utf8').trimEnd()
    writeFileSync(resolve(work, 'cordis.yml'), `${rows}\n- id: smoke-driver\n  name: '${driver}'\n`)
  }
  let output
  try {
    output = execFileSync(process.execPath, ['--expose-internals', '--import', tsxEntry, loader], {
      env: { ...process.env, DSH_SMOKE_TOOLED: tooled ? '1' : undefined },
      cwd: work,
      encoding: 'utf8',
      timeout: 90_000,
    })
  } catch (error) {
    console.error('smoke stdout:', error.stdout)
    console.error('smoke stderr:', error.stderr)
    throw error
  }
  console.log(output.trim())
  const summary = output.split('\n').reverse().find((line) => line.startsWith('smoke driver: '))
  if (summary === undefined) throw new Error(`the smoke driver printed no summary; boot output was:\n${output}`)
  const report = JSON.parse(summary.slice('smoke driver: '.length))
  if (!Array.isArray(report.legs) || report.legs.length < 3) {
    throw new Error(`the smoke driver recorded ${String(report.legs?.length)} leg(s); expected at least 3: ${summary}`)
  }
  for (const leg of report.legs) {
    if (leg.status !== 'success') throw new Error(`leg ${leg.leg} did not succeed: ${JSON.stringify(leg)}`)
  }
  if (!report.legs.some((leg) => leg.leg.startsWith('notes/list (human)'))) throw new Error(`no human notes leg: ${summary}`)
  if (!report.legs.some((leg) => leg.leg.includes('notes') && leg.leg.includes('ai') || leg.leg.includes('tools'))) throw new Error(`no agent notes leg: ${summary}`)
  if (!report.legs.some((leg) => leg.leg.includes('smoke-peer'))) throw new Error(`no application-originated leg: ${summary}`)
  if (typeof report.history !== 'number' || report.history < 3) throw new Error(`the runtime history holds ${String(report.history)} record(s); expected at least 3: ${summary}`)
  console.log(`smoke OK: ${exampleDir}${tooled ? ' (tooled)' : ''} — ${String(report.legs.length)} leg(s) through ctx.applications, ${String(report.history)} history record(s)`)
} finally {
  rmSync(work, { recursive: true, force: true })
}
