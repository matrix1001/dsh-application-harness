#!/usr/bin/env node
/**
 * The one Playwright Chromium resolver the browser lanes share.
 *
 * Playwright keeps one browser directory per revision under the user's cache
 * (`chromium-<n>`), and dev machines carry several at once while CI installs
 * exactly the revision the pinned playwright wants — so "which chrome" is a
 * decision every lane has to make, and `DSH_E2E_CHROME` overrides the search on
 * machines where the browser lives elsewhere. The lanes each used to carry their
 * own copy of that decision and drifted (some returned `undefined` for the
 * caller to throw on, one shelled out to `ls`); this module is the single home.
 *
 * The refusals are deliberate: a missing cache and a cache without a usable
 * executable are different facts, and neither guesses a path.
 * @module
 */

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The per-revision executable, in preference order (linux x64, linux arm64, macOS). */
const LEAVES = [
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
]

/**
 * Resolve the Chromium executable: `DSH_E2E_CHROME` first, then the executable
 * of the newest playwright cache revision.
 * @param env - the environment to read (injectable for tests).
 * @returns the executable path.
 */
export async function resolveChrome(env = process.env) {
  if (env.DSH_E2E_CHROME !== undefined) return env.DSH_E2E_CHROME
  const cache = join(env.HOME ?? '', '.cache', 'ms-playwright')
  let entries = []
  try {
    entries = readdirSync(cache, { withFileTypes: true })
  } catch {
    throw new Error('playwright browser cache not found; set DSH_E2E_CHROME')
  }
  const candidates = entries
    .filter(entry => entry.isDirectory() && /^chromium-\d+$/.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)))
  for (const name of candidates) {
    for (const leaf of LEAVES) {
      const path = join(cache, name, leaf)
      if (existsSync(path)) return path
    }
  }
  throw new Error('no chromium executable found in the playwright cache; set DSH_E2E_CHROME')
}
