import { execFileSync } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  MAX_SOURCE_FILES, clip, discoverSource, parseClaudeRecords, parseCodexRecords, parseDshRecords, parseSessionText,
} from '../src/adapters.ts'
import { NOW, tempDir, writeFixture, writeJsonl } from './helpers.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
const meta = { path: '/sessions/edge.jsonl', hash: 'hash', fallbackNativeId: 'fallback', redact: false }

describe('adapter edge cases', () => {
  it('covers clip boundaries and DSH missing/optional fields', () => {
    expect(clip('short', 10)).toBe('short')
    expect(clip('a long value', 5)).toBe('a lo…')
    const summary = parseDshRecords([
      { type: 'session' },
      { type: 'session/title', data: {} },
      { type: 'turn/start', data: {} },
      { type: 'turn/end', data: {} },
      { type: 'user/message', data: { content: [], source: { kind: 'user' } } },
      { type: 'user/message', data: { content: '', source: { kind: 'user' } } },
      { type: 'assistant/message', data: { message: {} } },
      { type: 'assistant/message', data: { message: 'not a record' } },
      { type: 'tool/call', data: {} },
      { type: 'tool/result', data: {} },
      { type: 'model/selection', data: {} },
      {},
      { type: 3 },
      { type: 'user/message', data: { content: 'plain', source: { kind: 'user' } } },
    ], meta)
    expect(summary.nativeId).toBe('fallback')
    expect(summary.tools).toEqual(['tool'])
    expect(summary.userTurns).toBe(1)
    expect(summary.flags.interrupted).toBeUndefined()
  })

  it('caps recent texts and test commands, and handles duplicate/unknown call results', () => {
    const users = Array.from({ length: 22 }, (_, index) => ({ type: 'user/message', data: { content: `user ${String(index)}` } }))
    const assistants = Array.from({ length: 22 }, (_, index) => ({ type: 'assistant/message', data: { message: { content: `answer ${String(index)}` } } }))
    const duplicateTests = [
      { type: 'tool/call', data: { name: 'bash', callId: 'a', arguments: '{"command":"pnpm test"}' } },
      { type: 'tool/result', data: { message: { toolCallId: 'a', isError: false } } },
      { type: 'tool/call', data: { name: 'bash', callId: 'b', arguments: '{"command":"pnpm test"}' } },
      { type: 'tool/result', data: { message: { isError: true } } },
      { type: 'tool/result', data: { callId: 'unknown' } },
      { type: 'tool/result', data: {} },
    ]
    const manyTests = Array.from({ length: 60 }, (_, index) => ({
      type: 'tool/call',
      data: { name: 'bash', arguments: JSON.stringify({ command: `pytest test_${String(index)}.py` }) },
    }))
    const summary = parseDshRecords([...users, ...assistants, ...duplicateTests, ...manyTests, { type: 'tool/result', data: { message: { toolCallId: 'a' } } }], meta)
    expect(summary.userTurns).toBe(22)
    expect(summary.turnCount).toBe(0)
    expect(summary.tests).toHaveLength(50)
    expect(summary.tests[0]).toMatchObject({ command: 'pnpm test', status: 'passed' })
    expect((summary as { tags?: unknown }).tags).toBeUndefined()
  })

  it('covers tool input file/command shapes', () => {
    const summary = parseDshRecords([
      { type: 'tool/call', data: { name: 'edit', arguments: { files: ['a.ts', 4, 'b.ts'] } } },
      { type: 'tool/call', data: { name: 'bash', arguments: { command: [1, 2] } } },
      { type: 'tool/call', data: { name: 'shell', arguments: { command: ['echo', 'ok'] } } },
      { type: 'tool/call', data: { name: 'patch', arguments: { patch: '*** Update File: \n*** Add File: new.ts' } } },
    ], meta)
    expect(summary.filesTouched).toEqual(['a.ts', 'b.ts', 'new.ts'])
    expect(summary.commands).toEqual(['echo ok'])
  })

  it('covers Claude content variants and tool-call forms', () => {
    const summary = parseClaudeRecords([
      { type: 'user' },
      { type: 'assistant' },
      'not a record',
      { type: 'assistant', message: { model: 'm', content: [
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hi' } },
        { type: 'tool-call', name: 'Edit', arguments: '{"file_path":"x.ts"}', id: 'call-1' },
        { type: 'text' },
        { type: 'tool_use', input: {} },
        { type: 'text', name: 'not-a-tool' },
        { type: 'tool_use', name: 'Read', input: {} },
        'string block',
        3,
      ] } },
      { type: 'user', message: { content: 3 } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call-1', is_error: true }] } },
      { isSidechain: true },
      {},
    ], meta)
    expect(summary.filesTouched).toEqual(['x.ts'])
    expect(summary.tools).toEqual(['Bash', 'Edit', 'Read'])
    expect(summary.keyTurns.length).toBeLessThanOrEqual(4)
    // A harness-level summary does not carry an arbitrary tags field.
    expect((summary as unknown as { tags?: unknown }).tags).toBeUndefined()
  })

  it('covers Codex missing payload fields, alternate messages and non-string output', () => {
    const summary = parseCodexRecords([
      { type: 'session_meta', payload: { parentSessionId: 'parent', timestamp: NOW } },
      { type: 'session_meta', payload: {} },
      { type: 'session_meta', payload: { source: { subagent: {} } } },
      'not a record',
      { type: 'turn_context', payload: {} },
      { type: 'event_msg', payload: {} },
      { type: 'event_msg', payload: { type: 'error' } },
      { type: 'event_msg', payload: { type: 'agent_message' } },
      { type: 'event_msg', payload: { type: 'user_message' } },
      { type: 'response_item', payload: { type: 'message', role: 'system', content: 'ignore' } },
      { type: 'response_item', payload: { type: 'message', content: '' } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'user text' }] } },
      { type: 'response_item', payload: { type: 'function_call', arguments: { command: ['pytest'] } } },
      { type: 'response_item', payload: { type: 'custom_tool_call', input: { note: 'x' } } },
      { type: 'response_item', payload: { type: 'local_shell_call' } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 3 } },
      { type: 'response_item', payload: { type: 'function_call_output', output: 'Error: nope' } },
      { type: 'response_item', payload: { type: 'local_shell_call_output', output: 3, call_id: 'x' } },
      { type: 'compacted' },
      {},
      { type: 1 },
    ], meta)
    expect(summary.parentNativeId).toBe('parent')
    expect(summary.userTurns).toBe(1)
    expect(summary.flags.interrupted).toBe(true)
    expect(summary.flags.compacted).toBe(true)
    expect(summary.agent).toBe('codex')
  })

  it('parses a plain JSON object, blank lines and each adapter through parseSessionText', () => {
    expect(parseSessionText('dsh', '{"type":"session","id":"one"}', { ...meta, path: '/x.json' }).nativeId).toBe('one')
    expect(parseSessionText('dsh', '{"events":[{"type":"session","id":"events"}]}', { ...meta, path: '/x.json' }).nativeId).toBe('events')
    expect(parseSessionText('dsh', '{"events":"nope"}', { ...meta, path: '/x.json' }).nativeId).toBe('fallback')
    expect(parseSessionText('dsh', '\n{\"type\":\"session\",\"id\":\"blank\"}\n\n', meta).nativeId).toBe('blank')
    expect(parseSessionText('dsh', '\n\n{"type":"session","id":"two"}\n', meta).nativeId).toBe('two')
    expect(parseSessionText('claude-code', '\n{"type":"assistant","message":{"content":"hi"}}\n\n', meta).nativeId).toBe('fallback')
    expect(parseSessionText('codex', '{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}', meta).nativeId).toBe('fallback')
    expect(() => parseSessionText('dsh', 'oops\n', meta)).toThrow(/no valid JSONL/)
  })

  it('walks nested directories, stops at the depth limit and reports a non-directory root', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    let nested = dir
    for (let index = 0; index < 10; index += 1) {
      nested = join(nested, `d${String(index)}`)
      await mkdir(nested)
    }
    await writeJsonl(nested, 'deep.jsonl', [])
    const shallow = await discoverSource('dsh', dir)
    expect(shallow.found).toBe(true)
    const fifo = join(dir, 'pipe')
    execFileSync('mkfifo', [fifo])
    const notDirectory = await discoverSource('dsh', fifo)
    expect(notDirectory.found).toBe(true)
    expect(notDirectory.files).toEqual([])
    expect(notDirectory.errors[0]).toContain('not a directory')
  }, 10_000)

  it('caps the number of discovered files', async () => {
    const { dir, cleanup } = await tempDir()
    cleanups.push(cleanup)
    for (let index = 0; index < MAX_SOURCE_FILES + 5; index += 1) {
      await writeFixture(dir, `f-${String(index)}.jsonl`, '')
    }
    const found = await discoverSource('dsh', dir)
    expect(found.files).toHaveLength(MAX_SOURCE_FILES)
  }, 20_000)
})
