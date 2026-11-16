import { describe, expect, it, vi } from 'vitest'
import { readGitEvidence, readOptionalEvidence, readTaskEvidence } from '../src/evidence.ts'
import { NOW, failed, ok, peerTable, workspace } from './helpers.ts'

const ws = workspace({ taskProjectId: 'p1' })
const status = { branch: 'main', files: [{ path: 'src/a.ts', additions: 3, deletions: 1 }] }
const log = { commits: [{ hash: 'a', subject: 'one', time: '2026-11-01T00:00:00Z' }, { hash: 'b', subject: 'two', time: '2026-11-02T00:00:00Z' }, { bad: true }] }

describe('optional Git evidence', () => {
  it('reads status, log and diff and keeps the bounded summary', async () => {
    const peer = peerTable({ status: ok(status), log: ok(log), listTasks: ok({ tasks: [{ completedAt: null }, { completedAt: 1 }] }) })
    const git = await readGitEvidence(peer, ws, '2026-10-07', '2026-11-05')
    expect(git).toEqual({
      available: true,
      branch: 'main',
      clean: false,
      changedFiles: 1,
      commits: 2,
      recent: [{ hash: 'a', subject: 'one', date: '2026-11-01T00:00:00Z' }, { hash: 'b', subject: 'two', date: '2026-11-02T00:00:00Z' }],
      diff: { files: 1, additions: 3, deletions: 1 },
    })
    expect(peer.calls.map(call => call.op)).toEqual(['status', 'log'])
    expect(peer.calls[0]!.args).toMatchObject({ path: ws.root })
    expect(peer.calls[1]!.args).toMatchObject({ path: ws.root, limit: 50 })
  })

  it('omits unbounded dates and tolerates partial failures', async () => {
    const peer = peerTable({
      status: failed('no git'),
      log: ok({ commits: [] }),
    })
    const git = await readGitEvidence(peer, ws, '', '')
    expect(git.available).toBe(true)
    expect(git.error).toContain('no git')
    expect(git.diff).toBeUndefined()
  })

  it('surfaces malformed and failed peer answers without throwing', async () => {
    let call = 0
    const peer = peerTable({
      status: () => { call += 1; return call === 1 ? ok('not an object') : ok({ files: [] }) },
      log: ok('not an object'),
    })
    const malformed = await readGitEvidence(peer, ws, '', '')
    expect(malformed.available).toBe(false)
    expect(malformed.error).toContain('status returned no object')
    expect(malformed.error).toContain('log')
    call = 0
    const clean = await readGitEvidence(peerTable({ status: ok({ files: [] }), log: ok({ commits: [] }) }), ws, '', '')
    expect(clean.clean).toBe(true)
    const thrown = peerTable({ status: new Error('peer exploded'), log: new Error('log exploded') })
    expect((await readGitEvidence(thrown, ws, '', '')).error).toContain('peer exploded')
  })

  it('keeps a commit without a date and omits line stats when the files carry none', async () => {
    const peer = peerTable({
      status: ok({ files: [{ path: 'a' }, { path: 'b', additions: 'x' }] }),
      log: ok({ commits: [{ hash: 'a', subject: 'no date' }] }),
    })
    const git = await readGitEvidence(peer, ws, '', '')
    expect(git.recent).toEqual([{ hash: 'a', subject: 'no date' }])
    expect(git.diff).toEqual({ files: 2 })
  })

  it('drops commits outside the requested range and malformed commit lists', async () => {
    const peer = peerTable({
      status: ok({ files: [] }),
      log: ok({ commits: [{ hash: 'old', subject: 'old', time: '2025-01-01T00:00:00Z' }, { hash: 'new', subject: 'new', time: '2027-01-01T00:00:00Z' }] }),
    })
    const git = await readGitEvidence(peer, ws, '2026-10-07', '2026-11-05')
    expect(git.recent).toBeUndefined()
    const malformed = await readGitEvidence(peerTable({ status: ok({ files: [] }), log: ok({ commits: 'x' }) }), ws, '', '')
    expect(malformed.recent).toBeUndefined()
  })

  it('honours cancellation between reads', async () => {
    const peer = peerTable({ status: ok(status), log: ok(log) })
    const aborted = new AbortController()
    aborted.abort()
    await expect(readGitEvidence(peer, ws, '', '', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
    const mid = new AbortController()
    const aborting = peerTable({
      status: ok(status),
      log: () => { mid.abort(); return ok({ commits: [] }) },
    })
    await expect(readGitEvidence(aborting, ws, '', '', mid.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reads the bound tasks project or reports why it could not', async () => {
    const peer = peerTable({ listTasks: ok([{ completedAt: null }, { completedAt: 2 }]) })
    expect(await readTaskEvidence(peer, 'p1')).toEqual({ available: true, projectId: 'p1', total: 2, open: 1 })
    expect(await readTaskEvidence(peer, undefined)).toBeUndefined()
    expect(await readTaskEvidence(peerTable({ listTasks: failed('no tasks') }), 'p1')).toMatchObject({ available: false, error: 'no tasks' })
    expect((await readOptionalEvidence(peer, ws, '', '')).tasks).toMatchObject({ available: true })
    expect((await readOptionalEvidence(undefined, ws, '', '')).git.available).toBe(false)
    const aborted = new AbortController()
    aborted.abort()
    await expect(readTaskEvidence(peer, 'p1', aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('notifies a cancelled peer outcome as an error, not a throw', async () => {
    const peer = peerTable({ status: { callId: 'x', status: 'cancelled' } })
    const git = await readGitEvidence(peer, ws, '', '')
    expect(git.available).toBe(false)
    expect(git.error).toContain('cancelled')
    const spy = vi.fn()
    expect(spy).not.toHaveBeenCalled()
    expect(NOW).toBeGreaterThan(0)
  })
})

describe('optional evidence edge cases', () => {
  it('turns a non-Error throw into a readable reason', async () => {
    const throwing = (async () => { throw 'plain failure' }) as unknown as import('../src/evidence.ts').PeerCall
    const git = await readGitEvidence(throwing, ws, '', '')
    expect(git.available).toBe(false)
    expect(git.error).toContain('plain failure')
  })
})
