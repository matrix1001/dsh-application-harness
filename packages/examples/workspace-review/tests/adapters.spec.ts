import { chmod, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_SESSION_BYTES, discoverSource, isEmptySession, isTestCommand, parseClaudeRecords, parseCodexRecords,
  parseDshRecords, parseSessionFile, parseSessionText, redactSecrets, sourceRootFor, timestampOf,
} from '../src/adapters.ts'
import { NOW, tempDir, writeFixture, writeJsonl } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

const meta = { path: '/sessions/one.jsonl', hash: 'hash', fallbackNativeId: 'file-one', redact: true }

describe('timestamp, redaction and test detection', () => {
  it('reads milliseconds, seconds and ISO strings, rejecting zero/garbage', () => {
    expect(timestampOf(1_700_000_000_000)).toBe(1_700_000_000_000)
    expect(timestampOf(1_700_000_000)).toBe(1_700_000_000_000)
    expect(timestampOf('2026-11-05T00:00:00.000Z')).toBe(Date.parse('2026-11-05T00:00:00.000Z'))
    expect(timestampOf('nope')).toBeUndefined()
    expect(timestampOf(0)).toBeUndefined()
    expect(timestampOf(-1)).toBeUndefined()
    expect(timestampOf(undefined)).toBeUndefined()
  })

  it('redacts likely credentials and recognizes test commands', () => {
    const text = redactSecrets('sk-abcdefgh12345678 ghp_abcdefgh1234 github_pat_abcdefgh12345678 AKIA1234567890ABCDEF Bearer abcdefgh1234 api_key=abcdef paint=blue')
    expect(text).not.toContain('sk-abcdefgh12345678')
    expect(text).not.toContain('ghp_abcdefgh1234')
    expect(text).not.toContain('github_pat_abcdefgh12345678')
    expect(text).not.toContain('AKIA1234567890ABCDEF')
    expect(text).not.toContain('Bearer abcdefgh1234')
    expect(text).not.toContain('api_key=abcdef')
    expect(text).toContain('paint=blue')
    for (const command of ['pnpm test', 'npm run test', 'vitest run', 'jest', 'pytest -q', 'playwright test', 'go test ./...', 'cargo test', 'mvn test', 'gradle test', 'make test', 'tsc --noEmit']) {
      expect(isTestCommand(command), command).toBe(true)
    }
    expect(isTestCommand('pnpm build')).toBe(false)
  })

  it('maps agents to the configured roots', () => {
    const roots = { dsh: '/d', claudeCode: '/c', codex: '/x' }
    expect(sourceRootFor(roots, 'dsh')).toBe('/d')
    expect(sourceRootFor(roots, 'claude-code')).toBe('/c')
    expect(sourceRootFor(roots, 'codex')).toBe('/x')
  })
})

describe('DSH adapter', () => {
  const records = [
    { type: 'session', id: 'dsh-1', createdAt: NOW, cwd: '/work/alpha', parentSession: 'parent-1', delegationDepth: 1 },
    { type: 'session/title', data: { title: 'Build the thing' } },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'user/message', data: { content: [{ type: 'text', text: '  Do the work sk-abcdefgh12345678  ' }], source: { kind: 'user' } } },
    { type: 'user/message', data: { content: 'runtime context', source: { kind: 'runtime-context' } } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Working on it' }], source: { kind: 'model', model: 'model-x' } } } },
    { type: 'tool/call', data: { name: 'bash', callId: 'c1', arguments: JSON.stringify({ command: 'pnpm test', file_path: 'src/a.ts' }) } },
    { type: 'tool/result', data: { message: { isError: false, toolCallId: 'c1' } } },
    { type: 'tool/call', data: { name: 'edit', callId: 'c2', arguments: { file_path: 'src/b.ts' } } },
    { type: 'tool/result', data: { message: { isError: true, toolCallId: 'c2' } } },
    { type: 'tool/call', data: { name: 'bash', callId: 'c3', arguments: '{"cmd":["pytest","-q"]}' } },
    { type: 'tool/result', data: { message: { isError: true, toolCallId: 'c3' } } },
    { type: 'compaction/start', data: {} },
    { type: 'subagent/descriptor', data: {} },
    { type: 'subagent/catalog', data: { childId: 'child-1', name: 'reviewer' } },
    { type: 'subagent/catalog', data: { childId: 'child-2' } },
    { type: 'subagent/catalog', data: { name: 'no-child' } },
    { type: 'working-directory/change', data: { cwd: '/work/alpha/sub' } },
    { type: 'turn/end', data: { turn: 1 } },
    { type: 'model/selection', data: { model: 'model-y' } },
    { type: 'unknown/event', data: {} },
    'not a record',
    { type: 'session_event', event: { type: 'assistant/message', data: { message: { content: 'Wrapped answer' } } } },
  ]

  it('normalizes messages, tools, tests, files, flags and parent links', () => {
    const summary = parseDshRecords(records, meta)
    expect(summary).toMatchObject({
      agent: 'dsh',
      nativeId: 'dsh-1',
      cwd: '/work/alpha/sub',
      title: 'Build the thing',
      model: 'model-y',
      parentNativeId: 'parent-1',
      turnCount: 1,
      userTurns: 1,
      toolCalls: 3,
      flags: { compacted: true, hasSubagents: true },
      subagentNames: { 'child-1': 'reviewer' },
    })
    expect(summary.tools).toEqual(['bash', 'edit'])
    expect(summary.filesTouched).toEqual(['src/a.ts', 'src/b.ts'])
    expect(summary.commands).toEqual(['pnpm test', 'pytest -q'])
    expect(summary.tests).toEqual([{ command: 'pnpm test', status: 'passed' }, { command: 'pytest -q', status: 'failed' }])
    expect(summary.excerpt).toContain('Wrapped answer')
    expect(JSON.stringify(summary)).not.toContain('sk-abcdefgh12345678')
  })

  it('marks an open turn as interrupted', () => {
    const summary = parseDshRecords([{ type: 'turn/start', data: { turn: 1 } }, { type: 'user/message', data: { content: 'x' } }], meta)
    expect(summary.flags.interrupted).toBe(true)
    expect(summary.turnCount).toBe(1)
  })

  it('parses a wrapped event/data record and JSON document input', () => {
    const text = JSON.stringify([{ type: 'session', id: 'json-1', createdAt: NOW, cwd: '/work/alpha' }, { type: 'user/message', data: { content: 'from json' } }])
    const summary = parseSessionText('dsh', text, { ...meta, path: '/sessions/one.json' })
    expect(summary.nativeId).toBe('json-1')
    expect(summary.userTurns).toBe(1)
  })

  it('treats empty sessions as empty and preserves records with assistant output', () => {
    const bare = parseDshRecords([{ type: 'session', id: 'x', createdAt: NOW, cwd: '/work' }], meta)
    expect(isEmptySession(bare)).toBe(true)
    const answered = parseDshRecords([{ type: 'assistant/message', data: { message: { content: 'done' } } }], meta)
    expect(isEmptySession(answered)).toBe(false)
  })
})

describe('Claude Code adapter', () => {
  const records = [
    { type: 'summary', summary: 'Claude title', sessionId: 'claude-1' },
    { type: 'system', subtype: 'compact_boundary', sessionId: 'claude-1', timestamp: '2026-11-05T10:00:00.000Z' },
    { type: 'system', subtype: 'api_error', sessionId: 'claude-1' },
    { type: 'user', sessionId: 'claude-1', cwd: '/work/beta', isSidechain: true, parentSessionId: 'parent-claude', timestamp: '2026-11-05T10:01:00.000Z', message: { content: '  <system-reminder>ignore me</system-reminder> Do the Claude work  ' } },
    { type: 'assistant', sessionId: 'claude-1', timestamp: '2026-11-05T10:02:00.000Z', message: { model: 'claude-x', content: [{ type: 'text', text: 'Claude answer' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'pnpm test' } }] } },
    { type: 'user', sessionId: 'claude-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: false }] } },
    { type: 'assistant', sessionId: 'claude-1', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'Edit', input: { file_path: 'src/claude.ts' } }] } },
    { type: 'user', sessionId: 'claude-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true }] } },
    { type: 'unknown', sessionId: 'claude-1' },
  ]

  it('normalizes Claude messages, sidechains, tools and results', () => {
    const summary = parseClaudeRecords(records, meta)
    expect(summary).toMatchObject({
      agent: 'claude-code',
      nativeId: 'claude-1',
      cwd: '/work/beta',
      title: 'Claude title',
      model: 'claude-x',
      parentNativeId: 'parent-claude',
      userTurns: 1,
      turnCount: 1,
      toolCalls: 2,
      flags: { compacted: true, interrupted: true, hasSubagents: true },
    })
    expect(summary.tools).toEqual(['Bash', 'Edit'])
    expect(summary.filesTouched).toEqual(['src/claude.ts'])
    expect(summary.tests).toEqual([{ command: 'pnpm test', status: 'passed' }])
    expect(summary.excerpt).toBe('Claude answer')
  })

  it('falls back to the file name and an assistant-only summary', () => {
    const summary = parseClaudeRecords([{ type: 'assistant', message: { content: 'only answer' } }], meta)
    expect(summary.nativeId).toBe('file-one')
    expect(summary.userTurns).toBe(0)
    expect(summary.title).toBe('only answer')
  })

  it('rejects an empty record set', () => {
    expect(() => parseClaudeRecords([], meta)).toThrow(/empty/)
  })
})

describe('Codex adapter', () => {
  const records = [
    { timestamp: '2026-11-05T10:00:00.000Z', type: 'session_meta', payload: { id: 'codex-1', cwd: '/work/gamma', timestamp: '2026-11-05T10:00:00.000Z', parent_session_id: 'parent-codex', source: { subagent: {} } } },
    { type: 'turn_context', payload: { cwd: '/work/gamma/sub', model: 'gpt-codex' } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'event user' } },
    { type: 'event_msg', payload: { type: 'agent_message', message: 'event answer' } },
    { type: 'event_msg', payload: { type: 'turn_aborted' } },
    { type: 'event_msg', payload: { type: 'context_compacted' } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'response user' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'response answer' }] } },
    { type: 'response_item', payload: { type: 'function_call', name: 'shell', call_id: 'fc1', arguments: JSON.stringify({ command: ['bash', '-lc', 'pytest -q'] }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'fc1', output: 'Exit code: 1' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'fc2', input: '*** Update File: src/codex.ts\n*** Add File: src/new.ts' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'fc2', output: 'Exit code: 0' } },
    { type: 'response_item', payload: { type: 'local_shell_call', action: { command: ['echo', 'hi'] } } },
    { type: 'compacted' },
    { type: 'unknown' },
  ]

  it('normalizes Codex meta, response messages, tools, patches and failures', () => {
    const summary = parseCodexRecords(records, meta)
    expect(summary).toMatchObject({
      agent: 'codex',
      nativeId: 'codex-1',
      cwd: '/work/gamma/sub',
      model: 'gpt-codex',
      parentNativeId: 'parent-codex',
      userTurns: 1,
      turnCount: 1,
      toolCalls: 3,
      flags: { interrupted: true, compacted: true, hasSubagents: true },
    })
    expect(summary.excerpt).toBe('response answer')
    expect(summary.filesTouched).toEqual(['src/codex.ts', 'src/new.ts'])
    expect(summary.commands).toEqual(['bash -lc pytest -q', 'echo hi'])
    expect(summary.tests).toEqual([{ command: 'bash -lc pytest -q', status: 'failed' }])
  })

  it('uses event messages when no response messages exist and tolerates missing fields', () => {
    const summary = parseCodexRecords([
      { type: 'event_msg', payload: { type: 'user_message', message: 'event user' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'event answer' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'missing', output: 'Error: no such command' } },
      { type: 'response_item', payload: { type: 'function_call', arguments: 'not json' } },
    ], meta)
    expect(summary.userTurns).toBe(1)
    expect(summary.excerpt).toBe('event answer')
    expect(summary.tools).toEqual(['tool'])
    expect(summary.flags.interrupted).toBeUndefined()
  })

  it('rejects an empty record set', () => {
    expect(() => parseCodexRecords([], meta)).toThrow(/empty/)
  })
})

describe('session file parsing and discovery', () => {
  it('reads, hashes and bounds a real file', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const path = await writeJsonl(dir, 'one/session.v3.jsonl', [{ type: 'session', id: 'file-session', createdAt: NOW, cwd: '/work/alpha' }, { type: 'user/message', data: { content: 'hello' } }])
    const summary = await parseSessionFile({ agent: 'dsh', path, mtimeMs: NOW, size: 10 }, { redactSecrets: false })
    expect(summary.nativeId).toBe('file-session')
    expect(summary.sourceHash).toHaveLength(64)
    await expect(parseSessionFile({ agent: 'dsh', path: dir, mtimeMs: NOW, size: 1 }, { redactSecrets: false })).rejects.toThrow(/not a file/)
    const huge = join(dir, 'huge.jsonl')
    await writeFixture(dir, 'huge.jsonl', 'x'.repeat(MAX_SESSION_BYTES + 1))
    await expect(parseSessionFile({ agent: 'dsh', path: huge, mtimeMs: NOW, size: MAX_SESSION_BYTES + 1 }, { redactSecrets: false })).rejects.toThrow(/larger/)
    await expect(parseSessionFile({ agent: 'dsh', path: join(dir, 'missing.jsonl'), mtimeMs: NOW, size: 1 }, { redactSecrets: false })).rejects.toThrow()
  })

  it('rejects empty and unparseable input', () => {
    expect(() => parseSessionText('dsh', '   ', meta)).toThrow(/empty/)
    expect(() => parseSessionText('claude-code', 'not json\n', meta)).toThrow(/no valid JSONL/)
    expect(() => parseSessionText('codex', '{bad json', { ...meta, path: '/x.json' })).toThrow(/not valid JSON/)
    expect(() => parseSessionText('claude-code', '"just a string"', { ...meta, path: '/x.json' })).toThrow(/no JSON records/)
  })

  it('discovers each source, newest DSH generation only, without following symlinks', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await writeJsonl(dir, 'project/session.v2.jsonl', [])
    const newest = await writeJsonl(dir, 'project/session.v3.jsonl', [])
    await writeJsonl(dir, 'project/session.jsonl', [])
    await writeJsonl(dir, 'project/extra.jsonl', [])
    await writeFixture(dir, 'project/readme.txt', 'x')
    await writeJsonl(dir, 'other/session.v2.jsonl', [])
    await symlink(newest, join(dir, 'project', 'link.jsonl'))

    const dsh = await discoverSource('dsh', dir)
    expect(dsh).toMatchObject({ agent: 'dsh', found: true })
    expect(dsh.files.map(file => file.path).sort()).toEqual([
      join(dir, 'project', 'extra.jsonl'),
      join(dir, 'project', 'session.v3.jsonl'),
      join(dir, 'other', 'session.v2.jsonl'),
    ].sort())

    const claude = await discoverSource('claude-code', dir)
    expect(claude.files).toHaveLength(5)
    const codex = await discoverSource('codex', dir)
    expect(codex.files).toHaveLength(5)

    expect(await discoverSource('dsh', join(dir, 'missing'))).toEqual({ agent: 'dsh', root: join(dir, 'missing'), found: false, files: [], errors: [], truncated: false })
    const file = await writeFixture(dir, 'single.jsonl', '{}')
    expect((await discoverSource('dsh', file)).files).toHaveLength(1)
    const unsupported = await writeFixture(dir, 'single.txt', 'x')
    expect((await discoverSource('dsh', unsupported)).errors[0]).toContain('unsupported')
    const notDirectory = await writeFixture(dir, 'plain.txt', 'x')
    chmod(notDirectory, 0o644)
    expect((await discoverSource('dsh', notDirectory)).files).toHaveLength(0)
  })

  it('marks a discovery that hit the file bound instead of silently cutting it', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    await Promise.all(Array.from({ length: 501 }, async (_unused, index) => await writeFixture(dir, `s${String(index)}.jsonl`, '{}')))
    const found = await discoverSource('codex', dir)
    expect(found.truncated).toBe(true)
    expect(found.files).toHaveLength(500)
  })

  it('reports a read error without aborting discovery', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    const nested = join(dir, 'locked')
    await writeJsonl(dir, 'locked/session.v2.jsonl', [])
    await chmod(nested, 0o000)
    const found = await discoverSource('dsh', dir)
    await chmod(nested, 0o755)
    expect(found.found).toBe(true)
    expect(found.errors.length).toBeGreaterThan(0)
  })
})
