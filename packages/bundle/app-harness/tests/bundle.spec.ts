import { describe, expect, it } from 'vitest'
import * as bundleModule from '../src/index.ts'

describe('application-harness bundle', () => {
  it('is a plugin-less entry: exports nothing plugin-shaped (no name, apply, or inject)', () => {
    // The bundle is patch-only — cordis.patch.yml rows own the surface, so a
    // composition that mounts the entry directly instead of through the patch
    // mounts nothing (the loader convention is served by the patch).
    const surface = bundleModule as unknown as Record<string, unknown>
    expect(surface.name).toBeUndefined()
    expect(surface.apply).toBeUndefined()
    expect(surface.inject).toBeUndefined()
    expect(surface.default).toBeUndefined()
    expect(Object.keys(surface)).toEqual([])
  })
})
