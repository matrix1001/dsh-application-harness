/**
 * The execution-line gate's judgment lives in six seams: the prerelease-aware
 * version ordering, the three-line classifier (declared pin vs live execution
 * vs registry dist-tags), the registry candidate set, the mixed-line summary
 * that names the packages off the majority executed version, the exit-code
 * rule, and the projection reader with its dangling-entry report. Shapes that
 * made them worth a direct test rather than only the `--self-test` fixtures:
 *
 *   - the declared line can itself be an **alpha** (the 2026-09-17 bump moves
 *     us onto 0.1.6-alpha.1), so the registry candidate set must include the
 *     `alpha` dist-tag — otherwise every package reads `unsupported` against a
 *     registry that simply was not asked about the line we track;
 *   - a live profile can resolve its packages to **more than one** platform
 *     version (the 2026-09-17 survey found three client packages resolving back
 *     into this repo through the profile's module fallback). That is a report,
 *     not a verdict — the per-package classifications carry the alarm;
 *   - the final 2026-09-17 review reproduced the first two as **self-proving
 *     green**: the candidate set and the exit-code rule lived inside untestable
 *     code (an unexported function / `main()`), so reverting either left every
 *     test green. `pickRegistryLine` and `exitCodeFor` are their seams;
 *   - platform 0.1.6-alpha.2 made the on-disk chain a **legacy projection**
 *     (runtime resolution is the launcher default), so a surviving link whose
 *     target is gone became the normal way for the chain to break — and
 *     `existsSync` follows symlinks, which made that shape invisible.
 *     `executedVersion` is the seam, with the root list injectable.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { classify, compareVersions, executedVersion, exitCodeFor, pickRegistryLine, summarizeExecutedLines, unmeasuredVerdict } from '../verify-execution-line.mjs'

/** Build one projection layer holding `entries`: a package name mapped either
 * to a version (a real directory with a package.json) or to `undefined` (the
 * dangling shape: the link survives, its target does not). */
function layer(dir, entries) {
  const root = join(dir, 'node_modules', '@deepseek-ai')
  mkdirSync(root, { recursive: true })
  for (const [name, version] of Object.entries(entries)) {
    const entry = join(root, name)
    if (version === undefined) {
      symlinkSync(join(dir, 'gone', name), entry)
      continue
    }
    mkdirSync(entry, { recursive: true })
    writeFileSync(join(entry, 'package.json'), JSON.stringify({ name: `@deepseek-ai/${name}`, version }))
  }
  return root
}

test('the registry line covers the declared alpha line', () => {
  // Declaring an alpha line must still be comparable: executed == declared == registry.
  assert.equal(classify({ name: 'x', declared: '0.1.6-alpha.1', executed: '0.1.6-alpha.1', registry: '0.1.6-alpha.1' }).verdict, 'ok')
  // A newer alpha *inside* the tracked line is the port signal (`behind`), and
  // the alpha tag being a registry candidate does not blind the gate to an
  // unpublished build: executed > registry stays `unsupported`.
  assert.equal(classify({ name: 'x', declared: '0.1.6-alpha.1', executed: '0.1.6-alpha.2', registry: '0.1.6-alpha.2' }).verdict, 'behind')
  assert.equal(classify({ name: 'x', declared: '0.1.6-alpha.1', executed: '0.1.6-alpha.2', registry: '0.1.6-alpha.1' }).verdict, 'unsupported')
})

test('compareVersions orders the alpha line the bump rests on', () => {
  // Both sides of the 2026-09-17 move: a later alpha of the new line outranks
  // the old rc line, and within one core version alpha ranks below rc.
  assert.ok(compareVersions('0.1.6-alpha.1', '0.1.6-alpha.2') < 0)
  assert.ok(compareVersions('0.1.6-alpha.1', '0.1.6-rc.1') < 0)
  assert.ok(compareVersions('0.1.5-rc.1', '0.1.6-alpha.1') < 0)
})

test('pickRegistryLine takes the max over latest/next/alpha', () => {
  // The load-bearing case of the 2026-09-17 bump: with all three tags present
  // the answer is the alpha line, not the newest `next`. Reverting the
  // candidate set to [latest, next] must turn this assertion red — that is the
  // self-proof the final review found missing.
  assert.equal(
    pickRegistryLine({ latest: '0.1.5-rc.1', next: '0.1.5-rc.2', alpha: '0.1.6-alpha.1' }),
    '0.1.6-alpha.1',
  )
  // The two-tag shape: without an alpha tag, `next` outranks `latest`.
  assert.equal(pickRegistryLine({ latest: '0.1.5-rc.1', next: '0.1.5-rc.2' }), '0.1.5-rc.2')
  // The unknown line, in every shape it arrives: an empty dist-tags object, the
  // absent key, a registry that only carries non-candidate or non-string tags
  // (the fetch path funnels `response.json()`'s missing field and every network
  // failure through here too). Never a default version.
  assert.equal(pickRegistryLine({}), undefined)
  assert.equal(pickRegistryLine(undefined), undefined)
  assert.equal(pickRegistryLine({ beta: '0.1.6-beta.1', latest: 42, alpha: null }), undefined)
})

test('exitCodeFor is red only on a downgrade or a mixed declaration', () => {
  const zero = { ok: 0, ahead: 0, behind: 0, unsupported: 0, 'n/s': 0, fail: 0 }
  assert.equal(exitCodeFor(zero, []), 0)
  assert.equal(exitCodeFor({ ...zero, fail: 1 }, []), 1)
  assert.equal(exitCodeFor(zero, [{ name: 'x', versions: ['0.1.5-rc.1', '0.1.6-alpha.1'] }]), 1)
  // The report-only signals never flip the exit code: `behind` is a port
  // deadline and `ahead` the inherent checkout lead.
  assert.equal(exitCodeFor({ ...zero, ahead: 3, behind: 70 }, []), 0)
})

test('a broken projection entry and an absent one are different verdicts', () => {
  // Both leave the row without an executed version, and both are outside the
  // ahead/behind judgment — but they are not the same fact, and one count hid
  // how many rows this gate cannot speak for (2026-09-23). `no-evidence`: the
  // chain carried an entry whose target is gone. `n/s`: nothing on disk
  // mentioned the package at all.
  assert.equal(unmeasuredVerdict({ dangling: ['legacy-link-projection'] }), 'no-evidence')
  assert.equal(unmeasuredVerdict({ dangling: [] }), 'n/s')
  assert.equal(unmeasuredVerdict(undefined), 'n/s')
  // Neither verdict can fail the gate: only a downgrade or a mixed declaration
  // does (a broken projection is a fact about this machine's DSH_HOME, not
  // about the declaration line).
  for (const verdict of ['no-evidence', 'n/s']) {
    assert.equal(exitCodeFor({ fail: 0, [verdict]: 7 }, []), 0)
  }
})

test('summarizeExecutedLines names the packages off the majority line', () => {
  const rows = [
    { name: 'a', verdict: 'ok', executed: '0.1.6-alpha.1' },
    { name: 'b', verdict: 'ok', executed: '0.1.6-alpha.1' },
    { name: 'c', verdict: 'behind', executed: '0.1.5-rc.1' },
    { name: 'd', verdict: 'n/s' },
  ]
  const summary = summarizeExecutedLines(rows)
  assert.equal(summary.line, '0.1.6-alpha.1')
  assert.deepEqual(summary.deviating, [{ version: '0.1.5-rc.1', names: ['c'] }])
  assert.equal(summarizeExecutedLines([{ name: 'a', verdict: 'ok', executed: '0.1.6-alpha.1' }]), undefined)
})

test('executedVersion reports a broken projection instead of skipping it', () => {
  // Platform 0.1.6-alpha.2 made runtime resolution the default, so this disk
  // chain is a legacy projection and can dangle. `existsSync` follows symlinks,
  // so a link whose target is gone is indistinguishable from an absent layer —
  // before the dangling report it fell through in silence and the NEXT layer
  // answered for a broken chain (or the row read `n/s` and passed). Reverting
  // the report must turn this red.
  const root = mkdtempSync(join(tmpdir(), 'exec-line-'))
  try {
    const first = layer(join(root, 'a'), { 'dsh-client-store': undefined })
    const second = layer(join(root, 'b'), { 'dsh-client-store': '0.1.6-alpha.2', 'dsh-llm': '0.1.6-alpha.2' })
    const third = layer(join(root, 'c'), { 'dsh-client-store': undefined })
    const roots = [[first, 'profile-local'], [second, 'profile-local-shadow'], [third, 'legacy-link-projection']]

    // The answer still comes from the first layer that resolves, and the broken
    // entries it had to pass over are named. `third` is deliberately NOT
    // reported: the chain stops at the hit, so a layer behind it is never
    // consulted and is not part of this row's provenance.
    assert.deepEqual(executedVersion('@deepseek-ai/dsh-client-store', roots), {
      version: '0.1.6-alpha.2',
      from: 'profile-local-shadow',
      dangling: ['profile-local'],
    })
    // A healthy chain reports no dangling layers.
    assert.deepEqual(executedVersion('@deepseek-ai/dsh-llm', roots), {
      version: '0.1.6-alpha.2',
      from: 'profile-local-shadow',
      dangling: [],
    })
    // Every entry broken: the row is unmeasured, not silently `undefined` —
    // the caller must be able to say "the chain is broken" rather than "the
    // package is not on the chain".
    assert.deepEqual(executedVersion('@deepseek-ai/dsh-client-store', [[third, 'legacy-link-projection']]), {
      dangling: ['legacy-link-projection'],
    })
    // No entry at all (the runtime-mode profile, or a package nested deeper in
    // the CLI tree) stays `undefined`.
    assert.equal(executedVersion('@deepseek-ai/dsh-absent', roots), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
