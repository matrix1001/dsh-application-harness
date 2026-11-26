/**
 * The shared versioned-JSON primitive: the missing/corrupt/version directions
 * and the atomic write every host-side record relies on.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isPlainRecord, readVersionedJson, writeVersionedJson } from '../src/platform-files.ts'

describe('the versioned-JSON primitive', () => {
  let root: string
  let path: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'application-harness-platform-files-'))
    path = join(root, 'record.json')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('answers undefined for a missing file and round-trips a written body', async () => {
    expect(await readVersionedJson(path, 1, 'record', (document) => document.value)).toBeUndefined()

    await writeVersionedJson(path, 1, { value: 'hello' })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ schemaVersion: 1, value: 'hello' })
    expect(await readVersionedJson(path, 1, 'record', (document) => document.value)).toBe('hello')
  })

  it('rejects a file that cannot be read, is not JSON, is not an object, or names another schema', async () => {
    await expect(readVersionedJson(root, 1, 'record', () => 1)).rejects.toThrow(/cannot be read/)

    writeFileSync(path, '{')
    await expect(readVersionedJson(path, 1, 'record', () => 1)).rejects.toThrow(/not valid JSON/)

    writeFileSync(path, '[]')
    await expect(readVersionedJson(path, 1, 'record', () => 1)).rejects.toThrow(/not an object/)

    writeFileSync(path, JSON.stringify({ schemaVersion: 2 }))
    await expect(readVersionedJson(path, 1, 'record', () => 1)).rejects.toThrow(/names schema 2/)
  })

  it('lets the caller validate the body and propagates its refusal', async () => {
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, value: 7 }))
    await expect(readVersionedJson(path, 1, 'record', (document) => {
      if (typeof document.value !== 'string') throw new Error('the record value is not a string')
      return document.value
    })).rejects.toThrow(/not a string/)
  })

  it('refuses to overwrite a record this process could not read, except for an explicit repair', async () => {
    writeFileSync(path, '{')
    await expect(readVersionedJson(path, 1, 'record', () => 1)).rejects.toThrow(/not valid JSON/)
    await expect(writeVersionedJson(path, 1, { value: 'clobber' })).rejects.toThrow(/refusing to overwrite/u)
    expect(readFileSync(path, 'utf8')).toBe('{')
    await writeVersionedJson(path, 1, { value: 'repaired' }, { allowAfterReadFailure: true })
    expect(JSON.parse(readFileSync(path, 'utf8')).value).toBe('repaired')
  })

  it('rejects when the write cannot reach the file', async () => {
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'x')
    await expect(writeVersionedJson(join(file, 'record.json'), 1, { value: 1 })).rejects.toThrow()
  })

  it('classifies plain records only', () => {
    expect(isPlainRecord({})).toBe(true)
    expect(isPlainRecord(Object.create(null))).toBe(true)
    expect(isPlainRecord([])).toBe(false)
    expect(isPlainRecord(null)).toBe(false)
    expect(isPlainRecord('x')).toBe(false)
  })
})
