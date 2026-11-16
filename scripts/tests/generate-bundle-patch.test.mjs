/**
 * The bundle-patch generator's overlay half: the web overlay's machinery rows
 * are generated from the bundle patch, so the two cannot drift. The bundle no
 * longer replaces the platform sidebar, so the overlay carries no replacement
 * directive; the drift check itself is the remaining contract.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, generateOverlay } from '../generate-bundle-patch.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const PATCH_PATH = join(ROOT, 'packages', 'bundle', 'app-harness', 'cordis.patch.yml')
const OVERLAY_PATH = join(ROOT, 'examples', 'web-application', 'cordis.yml')

test('the overlay carries the machinery rows and no sidebar replacement', () => {
  const overlay = generateOverlay(generate())
  assert.match(overlay, /# --- machinery rows \(generated from packages\/bundle\/app-harness\/cordis\.patch\.yml/u)
  assert.doesNotMatch(overlay, /ui-sidebar/u)
  assert.doesNotMatch(overlay, /client-app-sidebar/u)
  // The checked-in overlay is exactly what the generator produces.
  assert.equal(overlay, readFileSync(OVERLAY_PATH, 'utf8'))
})

test('the generated regions are the files on disk (drift fails the --check gate)', () => {
  const generated = generate()
  assert.equal(generated, readFileSync(PATCH_PATH, 'utf8'))
  assert.equal(generateOverlay(generated), readFileSync(OVERLAY_PATH, 'utf8'))
})
