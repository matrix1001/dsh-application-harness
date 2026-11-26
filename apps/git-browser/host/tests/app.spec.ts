/**
 * The git-browser application's call surface: every op through its declaration
 * with an injected, scripted process runner. The runner is the seam the
 * platform subprocess service implements in production; here it makes every
 * branch of the app's own policy (classification, caps, degradation) reachable
 * without depending on the machine's git state.
 */
import { describe, expect, it } from 'vitest'
import { AppError } from '@matrix1001/dsh-application-harness-runtime'
import type { OperationContext } from '@matrix1001/dsh-application-harness-runtime'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { gitBrowserDeclaration } from '../src/app.ts'
import type {
  GitCommandResult, GitCommandRunner, GitRunContext,
} from '../src/subprocess.ts'

type Handler = (argv: readonly string[], ctx: GitRunContext) => GitCommandResult | Promise<GitCommandResult>

/** One scripted runner plus the argv arrays it received. */
interface Scripted {
  runner: GitCommandRunner
  calls: string[][]
}

/** Build a runner that answers each call through `handler` and records the argv. */
function scripted(handler: Handler): Scripted {
  const calls: string[][] = []
  return {
    calls,
    runner: {
      run: async (argv, ctx, _command) => {
        calls.push([...argv])
        return await handler(argv, ctx)
      },
    },
  }
}

/** One git result, defaulting to a clean successful exit. */
function result(overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return { code: 0, signal: null, stdout: '', stderr: '', truncated: false, durationMs: 1, ...overrides }
}

/** A successful result carrying stdout. */
function ok(stdout: string, overrides: Partial<GitCommandResult> = {}): GitCommandResult {
  return result({ stdout, ...overrides })
}

/** The operation context the app's runner seam needs (the runtime supplies the real one). */
const CTX = {
  signal: new AbortController().signal,
  process: {
    run: async <T,>(_descriptor: { readonly command: string }, work: () => T | Promise<T>): Promise<T> => await work(),
  },
} as unknown as OperationContext

/** Call one op through the declaration. */
async function call(scriptedRunner: Scripted, op: string, args: unknown): Promise<JsonValue> {
  const declaration = gitBrowserDeclaration({ run: scriptedRunner.runner })
  return await declaration.ops[op]!.execute(args as JsonValue, CTX)
}

/** Run one call expected to fail and return its stable code. */
async function failureCode(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    return (error as AppError).code
  }
  throw new Error('expected the call to fail')
}

const STATUS_STDOUT = [
  '# branch.oid abc',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
  '1 M. N... 100644 100644 100644 aaa bbb a.txt',
  '1 .M N... 100644 100644 100644 aaa bbb b.txt',
  '1 MM N... 100644 100644 100644 aaa bbb both.txt',
  '1 M. N... 100644 100644 100644 aaa bbb logo.png',
  '? untracked.txt',
  '',
].join('\0')

describe('the declaration', () => {
  it('names generation 2, no durable data, the process capability and four read-only ops', () => {
    const declaration = gitBrowserDeclaration({ run: scripted(() => result()).runner })
    expect(declaration.id).toBe('git-browser')
    expect(declaration.name).toBe('git-browser')
    expect(declaration.version).toBe('0.1.1-dev.0')
    expect(declaration.generation).toBe(2)
    expect(declaration.data).toEqual({ kind: 'none' })
    expect(declaration.capabilities).toEqual(['process'])
    expect(Object.keys(declaration.ops).sort()).toEqual(['diff', 'log', 'show', 'status'])
    for (const [name, op] of Object.entries(declaration.ops)) {
      expect(op.description, name).not.toBe('')
      expect(op.effect, name).toBe('read')
      expect(op.exposure, name).toEqual({ ai: 'open', peers: 'open' })
    }
    for (const name of ['status', 'diff', 'log', 'show']) {
      expect(Object.keys(declaration.ops[name]!.params).length, name).toBeGreaterThan(0)
    }
  })
})

describe('status', () => {
  it('resolves the root, parses every record, attaches per-side stats and reads the last commit', async () => {
    const fake = scripted((argv) => {
      if (argv.includes('status')) return ok(STATUS_STDOUT)
      if (argv.includes('rev-parse')) return ok('/srv/repo\n')
      if (argv.includes('log')) return ok('abc123\x1fAda\x1f2026-09-14T15:03:00+08:00\x1ffeat: workbench')
      if (argv.includes('--numstat')) {
        return argv.includes('--cached')
          ? ok('3\t1\ta.txt\0-\t-\tlogo.png\0')
          : ok('0\t2\tb.txt\0')
      }
      return result({ code: 1, stderr: 'unexpected' })
    })
    expect(await call(fake, 'status', { path: '  /srv/repo  ' })).toEqual({
      root: '/srv/repo',
      branch: 'main',
      detached: false,
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      files: [
        { path: 'a.txt', status: 'M', staged: true, additions: 3, deletions: 1 },
        { path: 'b.txt', status: 'M', staged: false, additions: 0, deletions: 2 },
        { path: 'both.txt', status: 'M', staged: true },
        { path: 'both.txt', status: 'M', staged: false },
        { path: 'logo.png', status: 'M', staged: true },
        { path: 'untracked.txt', status: '?', staged: false },
      ],
      lastCommit: { hash: 'abc123', author: 'Ada', time: '2026-09-14T15:03:00+08:00', subject: 'feat: workbench' },
    })
    expect(fake.calls).toHaveLength(5)
    expect(fake.calls[0]![2]).toBe('-C')
    expect(fake.calls[0]![3]).toBe('/srv/repo')
    expect(fake.calls[3]![0]).toBe('--no-pager')
  })

  it('degrades a failed/truncated auxiliary read instead of failing the status', async () => {
    const fake = scripted((argv) => {
      if (argv.includes('status')) return ok('# branch.head (detached)\0? u.txt\0')
      if (argv.includes('--numstat')) {
        return argv.includes('--cached') ? result({ code: 1, stderr: 'boom' }) : result({ truncated: true })
      }
      if (argv.includes('log')) return result({ code: 1, stderr: 'no commits yet' })
      if (argv.includes('rev-parse')) return result({ code: 1, stderr: 'no root' })
      return result()
    })
    expect(await call(fake, 'status', { path: '/srv/repo' })).toEqual({
      root: '/srv/repo',
      branch: null,
      detached: true,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [{ path: 'u.txt', status: '?', staged: false }],
    })
  })

  it('falls back to the requested path when git prints an empty root', async () => {
    const fake = scripted((argv) => {
      if (argv.includes('status')) return ok('? u.txt\0')
      if (argv.includes('--numstat')) return ok('')
      if (argv.includes('log')) return result({ truncated: true })
      if (argv.includes('rev-parse')) return ok('  \n')
      return result()
    })
    const value = await call(fake, 'status', { path: '/srv/repo' }) as { root: string }
    expect(value.root).toBe('/srv/repo')
  })

  it('refuses a capped status stream with output-too-large', async () => {
    const fake = scripted(() => result({ truncated: true }))
    expect(await failureCode(() => call(fake, 'status', { path: '/srv/repo' }))).toBe('output-too-large')
  })

  it('classifies a missing path, a non-repository and an unknown failure', async () => {
    const pathMissing = scripted(() => result({ code: 128, stderr: "fatal: cannot change to '/nope': No such file or directory" }))
    expect(await failureCode(() => call(pathMissing, 'status', { path: '/nope' }))).toBe('path-not-found')

    const notRepo = scripted(() => result({ code: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git' }))
    expect(await failureCode(() => call(notRepo, 'status', { path: '/tmp' }))).toBe('not-a-repo')

    const emptyStderr = scripted(() => result({ code: 1, stderr: '  ' }))
    expect(await failureCode(() => call(emptyStderr, 'status', { path: '/srv/repo' }))).toBe('git-failed')

    const unknown = scripted(() => result({ code: 1, stderr: 'fatal: something else' }))
    expect(await failureCode(() => call(unknown, 'status', { path: '/srv/repo' }))).toBe('git-failed')
  })

  it('refuses an invalid path before spawning anything', async () => {
    const fake = scripted(() => ok(''))
    expect(await failureCode(() => call(fake, 'status', { path: '   ' }))).toBe('invalid-args')
    expect(await failureCode(() => call(fake, 'status', { path: '/srv\0repo' }))).toBe('invalid-args')
    expect(await failureCode(() => call(fake, 'status', { path: 7 }))).toBe('invalid-args')
    expect(fake.calls).toEqual([])
  })
})

const SIMPLE_PATCH = [
  'diff --git a/a.txt b/a.txt',
  'index 111..222 100644',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@ -1,3 +1,4 @@',
  ' one',
  '-two',
  '+two changed',
  '+three',
  ' four',
  '',
].join('\n')

describe('diff', () => {
  it('returns the file patch and the staged argv for both sides', async () => {
    const fake = scripted(() => ok(SIMPLE_PATCH))
    expect(await call(fake, 'diff', { path: '/srv/repo', file: 'a b.txt', staged: true })).toEqual({
      patch: SIMPLE_PATCH,
      truncated: false,
      binary: false,
    })
    expect(fake.calls[0]).toContain('--cached')
    expect(fake.calls[0]!.slice(-2)).toEqual(['--', 'a b.txt'])

    const unstaged = scripted(() => ok(SIMPLE_PATCH))
    await call(unstaged, 'diff', { path: '/srv/repo', file: '-leading.txt' })
    expect(unstaged.calls[0]).not.toContain('--cached')
    expect(unstaged.calls[0]!.at(-1)).toBe('-leading.txt')
  })

  it('marks binary and truncated patches instead of failing', async () => {
    const binary = scripted(() => ok('Binary files a/logo.png and b/logo.png differ\n'))
    expect(await call(binary, 'diff', { path: '/srv/repo', file: 'logo.png' })).toEqual({
      patch: 'Binary files a/logo.png and b/logo.png differ\n',
      truncated: false,
      binary: true,
    })

    const huge = scripted(() => ok(Array.from({ length: 2001 }, (_, index) => `+line ${String(index)}`).join('\n')))
    const bounded = await call(huge, 'diff', { path: '/srv/repo', file: 'a.txt' }) as { patch: string; truncated: boolean }
    expect(bounded.truncated).toBe(true)
    expect(bounded.patch.split('\n')).toHaveLength(2000)

    const capped = scripted(() => result({ stdout: SIMPLE_PATCH, truncated: true }))
    expect(await call(capped, 'diff', { path: '/srv/repo', file: 'a.txt' })).toMatchObject({ truncated: true })
  })

  it('fails with git\'s class and refuses an unsafe file', async () => {
    const missing = scripted(() => result({ code: 128, stderr: "fatal: cannot change to '/nope': No such file or directory" }))
    expect(await failureCode(() => call(missing, 'diff', { path: '/nope', file: 'a.txt' }))).toBe('path-not-found')

    const fake = scripted(() => ok(''))
    expect(await failureCode(() => call(fake, 'diff', { path: '/srv/repo', file: '../etc/passwd' }))).toBe('invalid-args')
    expect(await failureCode(() => call(fake, 'diff', { path: '/srv/repo', file: '/etc/passwd' }))).toBe('invalid-args')
    expect(await failureCode(() => call(fake, 'diff', { path: '/srv/repo' }))).toBe('invalid-args')
    expect(fake.calls).toEqual([])
  })
})

describe('log', () => {
  const TWO_COMMITS = [
    'a1\x1fAda\x1f2026-09-14T15:03:00+08:00\x1ffeat: one',
    'b2\x1fGrace\x1f2026-09-13T09:00:00+08:00\x1ffix: two',
  ].join('\n')

  it('defaults to HEAD and 50 commits, and honours an explicit ref/limit', async () => {
    const fake = scripted(() => ok(TWO_COMMITS))
    expect(await call(fake, 'log', { path: '/srv/repo' })).toEqual({
      commits: [
        { hash: 'a1', author: 'Ada', time: '2026-09-14T15:03:00+08:00', subject: 'feat: one' },
        { hash: 'b2', author: 'Grace', time: '2026-09-13T09:00:00+08:00', subject: 'fix: two' },
      ],
    })
    expect(fake.calls[0]).toContain('--max-count=50')
    expect(fake.calls[0]!.at(-1)).toBe('HEAD')

    const explicit = scripted(() => ok(''))
    await call(explicit, 'log', { path: '/srv/repo', limit: 1000, ref: ' main ' })
    expect(explicit.calls[0]).toContain('--max-count=100')
    expect(explicit.calls[0]!.at(-1)).toBe('main')

    const blankRef = scripted(() => ok(''))
    await call(blankRef, 'log', { path: '/srv/repo', ref: '  ', limit: 'many' })
    expect(blankRef.calls[0]).toContain('--max-count=50')
    expect(blankRef.calls[0]!.at(-1)).toBe('HEAD')
  })

  it('reports an unborn HEAD as an empty history', async () => {
    const fake = scripted(() => result({ code: 128, stderr: "fatal: your current branch 'main' does not have any commits yet" }))
    expect(await call(fake, 'log', { path: '/srv/repo' })).toEqual({ commits: [] })
  })

  it('refuses an invalid or capped history', async () => {
    const badRev = scripted(() => result({ code: 128, stderr: "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree." }))
    expect(await failureCode(() => call(badRev, 'log', { path: '/srv/repo', ref: 'nope' }))).toBe('invalid-rev')

    const noRev = scripted(() => result({ code: 128, stderr: 'fatal: something else' }))
    expect(await failureCode(() => call(noRev, 'log', { path: '/srv/repo' }))).toBe('git-failed')

    const capped = scripted(() => result({ truncated: true }))
    expect(await failureCode(() => call(capped, 'log', { path: '/srv/repo' }))).toBe('output-too-large')

    const fake = scripted(() => ok(''))
    expect(await failureCode(() => call(fake, 'log', { path: '/srv/repo', ref: '--upload-pack=evil' }))).toBe('invalid-rev')
    expect(fake.calls).toEqual([])
  })
})

const SHOW_HEADER = 'abc123\x1fAda\x1f2026-09-14T15:03:00+08:00\x1ffeat: workbench\x1eBody line one.\nBody line two.\n'

describe('show', () => {
  it('returns the commit header, file statistics and patch', async () => {
    const fake = scripted((argv) => {
      if (argv.includes('--numstat')) return ok('3\t1\ta.txt\0')
      if (argv.includes('--unified=3')) return ok(SIMPLE_PATCH)
      return ok(SHOW_HEADER)
    })
    expect(await call(fake, 'show', { path: '/srv/repo', rev: 'abc123' })).toEqual({
      commit: {
        hash: 'abc123',
        author: 'Ada',
        time: '2026-09-14T15:03:00+08:00',
        subject: 'feat: workbench',
        body: 'Body line one.\nBody line two.',
      },
      files: [{ path: 'a.txt', additions: 3, deletions: 1, binary: false }],
      patch: SIMPLE_PATCH,
      truncated: false,
      binary: false,
    })
    expect(fake.calls).toHaveLength(3)
    expect(fake.calls[0]!.at(-1)).toBe('abc123')
    expect(fake.calls[0]!.at(-2)).toBe('--end-of-options')
  })

  it('marks a binary commit and a truncated/over-cap patch', async () => {
    const binary = scripted((argv) => {
      if (argv.includes('--numstat')) return ok('-\t-\tlogo.png\0')
      if (argv.includes('--unified=3')) return ok('Binary files a/logo.png and b/logo.png differ\n')
      return ok(SHOW_HEADER)
    })
    expect(await call(binary, 'show', { path: '/srv/repo', rev: 'abc123' })).toMatchObject({
      binary: true,
      files: [{ path: 'logo.png', additions: null, deletions: null, binary: true }],
      truncated: false,
    })

    const numstatCapped = scripted((argv) => {
      if (argv.includes('--numstat')) return result({ stdout: '1\t0\ta.txt\0', truncated: true })
      if (argv.includes('--unified=3')) return ok(SIMPLE_PATCH)
      return ok(SHOW_HEADER)
    })
    expect(await call(numstatCapped, 'show', { path: '/srv/repo', rev: 'abc123' })).toMatchObject({ truncated: true })

    const patchCapped = scripted((argv) => {
      if (argv.includes('--numstat')) return ok('1\t0\ta.txt\0')
      if (argv.includes('--unified=3')) return result({ stdout: SIMPLE_PATCH, truncated: true })
      return ok(SHOW_HEADER)
    })
    expect(await call(patchCapped, 'show', { path: '/srv/repo', rev: 'abc123' })).toMatchObject({ truncated: true })

    const huge = scripted((argv) => {
      if (argv.includes('--numstat')) return ok('1\t0\ta.txt\0')
      if (argv.includes('--unified=3')) return ok(Array.from({ length: 2001 }, () => '+x').join('\n'))
      return ok(SHOW_HEADER)
    })
    const bounded = await call(huge, 'show', { path: '/srv/repo', rev: 'abc123' }) as { patch: string; truncated: boolean }
    expect(bounded.truncated).toBe(true)
    expect(bounded.patch.split('\n')).toHaveLength(2000)
  })

  it('refuses a capped header and every unsafe revision', async () => {
    const cappedHeader = scripted(() => result({ truncated: true }))
    expect(await failureCode(() => call(cappedHeader, 'show', { path: '/srv/repo', rev: 'abc' }))).toBe('output-too-large')

    const badRev = scripted(() => result({ code: 128, stderr: "fatal: ambiguous argument 'nope': unknown revision or path not in the working tree." }))
    expect(await failureCode(() => call(badRev, 'show', { path: '/srv/repo', rev: 'nope' }))).toBe('invalid-rev')

    const fake = scripted(() => ok(SHOW_HEADER))
    expect(await failureCode(() => call(fake, 'show', { path: '/srv/repo' }))).toBe('invalid-rev')
    expect(await failureCode(() => call(fake, 'show', { path: '/srv/repo', rev: ' --output=/tmp/x ' }))).toBe('invalid-rev')
    expect(fake.calls).toEqual([])
  })
})

describe('safety', () => {
  it('never lets an argument become an option or a shell word', async () => {
    const fake = scripted((argv) => {
      if (argv.includes('status')) return ok('')
      if (argv.includes('--numstat')) return ok('')
      if (argv.includes('log')) return ok('')
      if (argv.includes('rev-parse')) return ok('/srv/repo\n')
      return result()
    })
    await call(fake, 'status', { path: '/srv/repo with space' })
    expect(fake.calls[0]![3]).toBe('/srv/repo with space')
    expect(fake.calls[0]).not.toContain('sh')
    for (const argv of fake.calls) expect(argv[0]).toBe('--no-pager')

    const fileFake = scripted(() => ok(''))
    await call(fileFake, 'diff', { path: '/srv/repo', file: '中文 名称.txt', staged: 1 })
    expect(fileFake.calls[0]!.at(-1)).toBe('中文 名称.txt')
    expect(fileFake.calls[0]).not.toContain('--cached')
    expect(fileFake.calls[0]!.slice(-2)).toEqual(['--', '中文 名称.txt'])
  })
})
