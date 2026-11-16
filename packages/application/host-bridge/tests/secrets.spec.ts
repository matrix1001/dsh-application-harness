import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppSecretStore } from '../src/secrets.ts'

const dirs: string[] = []
async function tempPath(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), 'tmp/secret-test-'))
  dirs.push(dir)
  return join(dir, 'secrets.json')
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }) }))
})

describe('AppSecretStore', () => {
  it('starts empty, writes, persists and deletes secrets', async () => {
    const path = await tempPath()
    const store = new AppSecretStore(path)
    await store.load()
    expect(store.has('notes', 'token')).toBe(false)
    expect(store.get('notes', 'token')).toBeUndefined()
    await store.set('notes', 'token', 'secret')
    expect(((await stat(path)).mode & 0o077)).toBe(0)
    expect(store.has('notes', 'token')).toBe(true)
    expect(store.get('notes', 'token')).toBe('secret')
    expect(store.names('notes')).toEqual(['token'])
    const reloaded = new AppSecretStore(path)
    await reloaded.load()
    expect(reloaded.get('notes', 'token')).toBe('secret')
    expect(await reloaded.delete('notes', 'token')).toBe(true)
    expect(await reloaded.delete('notes', 'token')).toBe(false)
    expect(reloaded.names('notes')).toEqual([])
    await reloaded.set('tasks', 'token', 'x')
    await reloaded.removeApp('tasks')
    expect(reloaded.names('tasks')).toEqual([])
  })

  it('rejects invalid names/values and keeps the previous value on a failed write', async () => {
    const path = await tempPath()
    const store = new AppSecretStore(path)
    await store.load()
    await expect(store.set('', 'x', 'y')).rejects.toThrow(/must not be empty/u)
    await expect(store.set('notes', '', 'y')).rejects.toThrow(/must not be empty/u)
    await expect(store.set('notes', 'x', '')).rejects.toThrow(/must not be empty/u)
    await store.set('notes', 'x', 'one')
    // A path whose parent is a file cannot be written.
    const blocker = join(path, '..', 'blocked')
    await mkdir(blocker)
    const broken = new AppSecretStore(blocker)
    await expect(broken.set('notes', 'x', 'two')).rejects.toBeTruthy()
    expect(store.get('notes', 'x')).toBe('one')
  })

  it('fails closed on corrupt or unsupported files', async () => {
    const path = await tempPath()
    await writeFile(path, 'not json')
    await expect(new AppSecretStore(path).load()).rejects.toThrow(/valid JSON/u)
    await writeFile(path, JSON.stringify({ version: 2, apps: {} }))
    await expect(new AppSecretStore(path).load()).rejects.toThrow(/unsupported shape/u)
    await writeFile(path, JSON.stringify({ version: 1, apps: [] }))
    await expect(new AppSecretStore(path).load()).rejects.toThrow(/unsupported shape/u)
    const good = new AppSecretStore(path)
    await writeFile(path, JSON.stringify({ version: 1, apps: { notes: { token: 'x' } } }))
    await good.load()
    expect(await readFile(path, 'utf8')).toContain('token')
  })
})

describe('secret store edge branches', () => {
  it('reports non-ENOENT read failures, keeps sibling fields and ignores missing apps', async () => {
    const path = await tempPath()
    await mkdir(path)
    await expect(new AppSecretStore(path).load()).rejects.toBeTruthy()
    const store = new AppSecretStore(path.replace(/secrets\.json$/u, 'other.json'))
    await store.load()
    await store.set('notes', 'a', '1')
    await store.set('notes', 'b', '2')
    expect(await store.delete('notes', 'a')).toBe(true)
    expect(store.has('notes', 'b')).toBe(true)
    await store.removeApp('missing')
    expect(store.names('notes')).toEqual(['b'])
  })
})
