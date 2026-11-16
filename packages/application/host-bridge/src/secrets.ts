/**
 * Per-application secret storage, kept outside application business data.
 *
 * The file holds only names and values; callers never get a listing with values,
 * and the management surface can show "set / not set" without reading them.
 * Writes go through the store's atomic file primitive so a crash cannot leave a
 * torn JSON file. This class is deliberately host-only: the browser receives a
 * name/status projection, never a secret value.
 * @module @matrix1001/dsh-application-harness-host-bridge/secrets
 */

import { chmod, readFile } from 'node:fs/promises'
import { writeFileAtomic } from '@matrix1001/dsh-application-harness-store/atomic'

/** One persisted secret file. */
interface SecretFile {
  version: 1
  apps: Record<string, Record<string, string>>
}

function empty(): SecretFile { return { version: 1, apps: {} } }

/**
 * One application secret store.
 */
export class AppSecretStore {
  private readonly path: string
  private data: SecretFile = empty()
  private queue: Promise<unknown> = Promise.resolve()

  /** @param path - the secret file path (outside application data). */
  constructor(path: string) { this.path = path }

  /** Load the file; a missing file is an empty first run. */
  async load(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { this.data = empty(); return }
      throw error
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error('secrets: the secret file is not valid JSON') }
    if (typeof parsed !== 'object' || parsed === null || (parsed as { version?: unknown }).version !== 1
      || typeof (parsed as { apps?: unknown }).apps !== 'object' || (parsed as { apps?: unknown }).apps === null || Array.isArray((parsed as { apps?: unknown }).apps)) {
      throw new Error('secrets: the secret file has an unsupported shape')
    }
    this.data = parsed as SecretFile
  }

  /** Whether one secret exists. */
  has(appId: string, name: string): boolean {
    return this.data.apps[appId]?.[name] !== undefined
  }

  /** Read one secret value (host-only; never expose it to the browser). */
  get(appId: string, name: string): string | undefined {
    return this.data.apps[appId]?.[name]
  }

  /** Names only, for a management projection. */
  names(appId: string): string[] {
    return Object.keys(this.data.apps[appId] ?? {}).sort()
  }

  /** Write one secret. */
  async set(appId: string, name: string, value: string): Promise<void> {
    if (appId.trim() === '' || name.trim() === '') throw new Error('secrets: appId and name must not be empty')
    if (value === '') throw new Error('secrets: a secret value must not be empty')
    await this.mutate((next) => {
      next.apps[appId] = { ...(next.apps[appId] ?? {}), [name]: value }
    })
  }

  /** Delete one secret. */
  async delete(appId: string, name: string): Promise<boolean> {
    if (this.data.apps[appId]?.[name] === undefined) return false
    await this.mutate((next) => {
      /* v8 ignore next -- delete only runs for an app that exists */
      const app = { ...(next.apps[appId] ?? {}) }
      delete app[name]
      if (Object.keys(app).length === 0) delete next.apps[appId]
      else next.apps[appId] = app
    })
    return true
  }

  /** Delete every secret for one application. */
  async removeApp(appId: string): Promise<void> {
    if (this.data.apps[appId] === undefined) return
    await this.mutate((next) => { delete next.apps[appId] })
  }

  /** Serialize writes; a failed write never publishes its state. */
  private async mutate(change: (next: SecretFile) => void): Promise<void> {
    const run = async (): Promise<void> => {
      const next: SecretFile = { version: 1, apps: { ...this.data.apps } }
      change(next)
      await writeFileAtomic(this.path, JSON.stringify(next), 0o600)
      // Secret values stay owner-only even under a permissive umask.
      await chmod(this.path, 0o600)
      this.data = next
    }
    const pending = this.queue.then(run, run)
    this.queue = pending.then(() => undefined, () => undefined)
    await pending
  }
}
