/**
 * The host-side "seen" record for the first-run permission card.
 *
 * This is a notification record, not authorization: `grants.json` stays the
 * only source of what is allowed, and this file only remembers that the human
 * already answered (or postponed) the card for one application at one
 * capability-set fingerprint. A new capability changes the fingerprint and the
 * card may appear again; an unchanged one does not.
 *
 * The directions are deliberately fail-open: a missing, corrupt, or
 * unknown-version file is the empty record (the card may reappear), and a
 * failed write rejects so the card can say the answer was not saved. Nothing
 * here ever widens a grant.
 * @module @matrix1001/dsh-application-harness-host-bridge/onboarding
 */

import { isPlainRecord, readVersionedJson, writeVersionedJson } from './platform-files.ts'
import type { OnboardingState } from './types.ts'

/** The schema version of the stored record (a future shape is refused, then treated as empty). */
export const ONBOARDING_VERSION = 1

/**
 * The persisted onboarding record: one entry per application, keyed by appId,
 * remembering the capability-set fingerprint and when it was answered.
 *
 * Reads are cached in memory after the first load; marks are serialized so two
 * concurrent answers cannot overwrite each other's entries.
 */
export class OnboardingFileStore {
  private state: OnboardingState | undefined
  private chain: Promise<void> = Promise.resolve()

  /**
   * @param path - the JSON file holding the record.
   * @param report - where a read failure is reported (the card still works empty).
   */
  constructor(
    private readonly path: string,
    private readonly report: (problem: string) => void = () => {},
  ) {}

  /**
   * Read the record. A missing file is empty; a corrupt/unknown file is
   * reported and also answered as empty (fail-open).
   * @returns the current record.
   */
  async load(): Promise<OnboardingState> {
    if (this.state !== undefined) return this.state
    try {
      const stored = await readVersionedJson(
        this.path,
        ONBOARDING_VERSION,
        'onboarding record',
        parseOnboarding,
      )
      this.state = stored === undefined ? { apps: {} } : stored
    } catch (error) {
      this.report(`the onboarding record ${this.path} cannot be read; treating it as empty: ${String(error)}`)
      this.state = { apps: {} }
    }
    return this.state
  }

  /**
   * Record one application's current fingerprint. Marks are serialized; the
   * write is atomic; a failed write rejects and leaves the previous record in
   * force (the caller must not present it as saved).
   * @param appId - the application that was answered.
   * @param fingerprint - its current capability-set fingerprint.
   * @returns the record after the write.
   */
  async mark(appId: string, fingerprint: string): Promise<OnboardingState> {
    let result: OnboardingState = { apps: {} }
    const run = async (): Promise<void> => {
      const current = await this.load()
      const next: OnboardingState = {
        apps: { ...current.apps, [appId]: { fingerprint, seenAt: new Date().toISOString() } },
      }
      await writeVersionedJson(this.path, ONBOARDING_VERSION, { apps: next.apps })
      this.state = next
      result = next
    }
    // Serialize marks, and keep the chain usable after a failed write.
    const attempt = this.chain.then(run, run)
    this.chain = attempt.catch(() => undefined)
    await attempt
    return result
  }
}

/** Validate one stored onboarding document (after the version envelope). */
function parseOnboarding(document: Record<string, unknown>): OnboardingState {
  if (!isPlainRecord(document.apps)) throw new Error('the onboarding record carries no apps object')
  const apps: OnboardingState['apps'] = {}
  for (const [appId, raw] of Object.entries(document.apps)) {
    if (!isPlainRecord(raw) || typeof raw.fingerprint !== 'string' || typeof raw.seenAt !== 'string') {
      throw new Error(`the onboarding record for ${appId} is malformed`)
    }
    apps[appId] = { fingerprint: raw.fingerprint, seenAt: raw.seenAt }
  }
  return { apps }
}
