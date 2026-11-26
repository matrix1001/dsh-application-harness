/**
 * The three local session adapters and the read-only discovery around them.
 *
 * Every adapter reads whatever the agent wrote and normalizes it into one
 * bounded summary: counters, short text excerpts, file/command/test references
 * and flags. A full transcript, a tool's raw output, an image or a credential
 * never enters the stored record. Unknown events are ignored and a bad line is
 * counted rather than aborting the whole sync; a malformed file fails alone.
 *
 * Discovery never follows a symlink, never writes, and caps both how deep it
 * walks and how many files one source may contribute.
 * @module @matrix1001/dsh-application-harness-workspace-review/adapters
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { AgentKind, KeyTurn, SessionFlags, SessionTest } from './types.ts'

/** How deep one source walk may descend. */
export const MAX_WALK_DEPTH = 8
/** How many files one source may contribute. */
export const MAX_SOURCE_FILES = 500
/** How large one session file may be before it is refused as unsafe to load. */
export const MAX_SESSION_BYTES = 8 * 1024 * 1024
/** Bounds of the normalized text fields. */
export const MAX_TITLE = 160
export const MAX_EXCERPT = 600
export const MAX_TURN_TEXT = 500
export const MAX_FILES = 200
export const MAX_COMMANDS = 100
export const MAX_TESTS = 50
export const MAX_TOOLS = 20
export const MAX_KEY_TURNS = 4
export const MAX_RECENT_TEXTS = 20

/** One file a source walk found. */
export interface SourceFile {
  agent: AgentKind
  path: string
  mtimeMs: number
  size: number
}

/** One source's discovery result. */
export interface DiscoveredSource {
  agent: AgentKind
  root: string
  found: boolean
  files: SourceFile[]
  errors: string[]
  /** The walk hit a bound before visiting every candidate. */
  truncated?: boolean
}

/** The normalized output of one adapter, before durable ids are assigned. */
export interface ParsedSession {
  agent: AgentKind
  sourceId: AgentKind
  nativeId: string
  sourcePath: string
  sourceHash: string
  cwd: string
  startedAt: number
  endedAt?: number
  title: string
  model?: string
  parentNativeId?: string
  subagentNames?: Record<string, string>
  turnCount: number
  userTurns: number
  toolCalls: number
  tools: string[]
  filesTouched: string[]
  commands: string[]
  tests: SessionTest[]
  flags: SessionFlags
  excerpt: string
  keyTurns: KeyTurn[]
}

/** A session file that could not be normalized (the rest of the sync continues). */
export class SessionParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionParseError'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

/** Read a timestamp expressed as milliseconds, seconds or an ISO string. */
export function timestampOf(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value < 10_000_000_000 ? Math.round(value * 1000) : Math.round(value)
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** Collapse whitespace and bound one stored text field. */
export function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, Math.max(0, max - 1))}…`
}

const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{8,}\b/gu, '[redacted]'],
  [/\bgh[pousr]_[A-Za-z0-9]{8,}\b/gu, '[redacted]'],
  [/\bgithub_pat_[A-Za-z0-9_]{8,}\b/gu, '[redacted]'],
  [/\bAKIA[0-9A-Z]{16}\b/gu, '[redacted]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gu, 'Bearer [redacted]'],
  [/\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?[^\s"',;]{4,}/giu, '[redacted]'],
]

/** Redact likely credentials from a stored text field. */
export function redactSecrets(value: string): string {
  let text = value
  for (const [pattern, replacement] of SECRET_PATTERNS) text = text.replace(pattern, replacement)
  return text
}

function cleanUserText(value: string): string {
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, ' ')
    .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/gu, ' ')
    .trim()
}

function textOfContent(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const parts: string[] = []
  for (const block of value) {
    if (typeof block === 'string') { parts.push(block); continue }
    if (!isRecord(block)) continue
    const text = block.text
    if (typeof text === 'string') parts.push(text)
  }
  return parts.filter(part => part.trim() !== '').join('\n')
}

const COMMAND_KEYS = ['command', 'cmd', 'commandLine', 'script'] as const
const FILE_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'target_file', 'file', 'files'] as const

function addUnique(target: string[], value: string, max: number): void {
  if (value === '' || target.includes(value) || target.length >= max) return
  target.push(value)
}

function filesFromPatch(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(/^\*\*\* (?:Update|Add|Delete) File:[ \t]*(\S.*)$/gmu)) {
    const path = match[1]?.trim()
    /* v8 ignore next -- a regex match always captures a path */
    if (path !== undefined) found.push(path)
  }
  return found
}

function filesFromInput(input: unknown): string[] {
  if (!isRecord(input)) return []
  const found: string[] = []
  for (const key of FILE_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') found.push(value.trim())
    if (Array.isArray(value)) for (const item of value) if (typeof item === 'string' && item.trim() !== '') found.push(item.trim())
  }
  const patch = input.patch ?? input.input
  if (typeof patch === 'string') found.push(...filesFromPatch(patch))
  return found
}

function commandFromInput(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined
  for (const key of COMMAND_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim() !== '') return clip(value, 300)
    if (Array.isArray(value)) {
      const joined = value.filter((part): part is string => typeof part === 'string').join(' ')
      if (joined.trim() !== '') return clip(joined, 300)
    }
  }
  return undefined
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

/** Whether one command is recognizably a test run. */
export function isTestCommand(command: string): boolean {
  return /\b(?:vitest|jest|pytest|playwright\s+test|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|go\s+test|cargo\s+test|mvn\s+test|gradle\s+test|make\s+test)\b/u.test(command)
    || /\btsc\b[^\n]*--noEmit/u.test(command)
}

/** The parsed tool-call shape the adapters share. */
interface ToolCall {
  name: string
  input: unknown
  callId?: string
}

function toolCallsOfContent(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return []
  const calls: ToolCall[] = []
  for (const block of value) {
    if (!isRecord(block) || typeof block.name !== 'string') continue
    if (block.type !== 'tool_use' && block.type !== 'tool-call') continue
    const callId = typeof block.id === 'string' ? block.id : undefined
    calls.push({ name: block.name, input: block.type === 'tool_use' ? block.input : parseArguments(block.arguments), ...(callId === undefined ? {} : { callId }) })
  }
  return calls
}

/** The bounded, normalized summary builder shared by the three adapters. */
class SummaryBuilder {
  private readonly users: string[] = []
  private readonly assistants: string[] = []
  private readonly keyTurns: KeyTurn[] = []
  private readonly tools: string[] = []
  private readonly filesTouched: string[] = []
  private readonly commands: string[] = []
  private readonly tests: SessionTest[] = []
  private readonly testByCall = new Map<string, number>()
  private readonly flags: SessionFlags = {}
  private turnCountValue = 0
  private userTurns = 0
  private toolCalls = 0
  private startedAt: number | undefined
  private endedAt: number | undefined
  private firstUser = ''
  private titleOverride: string | undefined
  private nativeId = ''
  private cwd = ''
  private model: string | undefined
  private parentNativeId: string | undefined
  private readonly subagentNames = new Map<string, string>()

  constructor(
    private readonly agent: AgentKind,
    private readonly redact: boolean,
  ) {}

  private text(value: string): string {
    return this.redact ? redactSecrets(value) : value
  }

  private touch(at: number | undefined): void {
    if (at === undefined) return
    if (this.startedAt === undefined || at < this.startedAt) this.startedAt = at
    if (this.endedAt === undefined || at > this.endedAt) this.endedAt = at
  }

  setIdentity(input: { nativeId?: string; cwd?: string; model?: string; parentNativeId?: string; startedAt?: number }): void {
    if (input.nativeId !== undefined) this.nativeId = input.nativeId
    if (input.cwd !== undefined) this.cwd = input.cwd
    if (input.model !== undefined) this.model = input.model
    if (input.parentNativeId !== undefined) this.parentNativeId = input.parentNativeId
    this.touch(input.startedAt)
  }

  setTitle(title: string | undefined): void {
    if (title !== undefined && title.trim() !== '') this.titleOverride = this.text(clip(title, MAX_TITLE))
  }

  setTurnCount(count: number): void {
    this.turnCountValue = Math.max(this.turnCountValue, count)
  }

  flag(name: keyof SessionFlags): void {
    this.flags[name] = true
  }

  nameSubagent(childId: string, name: string): void {
    this.subagentNames.set(childId, this.text(name))
  }

  addUser(value: string, at: number | undefined, countTurn = true): void {
    const text = this.text(cleanUserText(value))
    /* v8 ignore next -- an empty user turn is filtered before the transcript */
    if (text === '') return
    this.touch(at)
    if (countTurn) this.turnCountValue += 1
    this.userTurns += 1
    this.users.push(clip(text, MAX_TURN_TEXT))
    if (this.users.length > MAX_RECENT_TEXTS) this.users.shift()
    if (this.firstUser === '') this.firstUser = text
    this.pushKeyTurn({ role: 'user', text: clip(text, MAX_TURN_TEXT) })
  }

  addAssistant(value: string, at: number | undefined): void {
    const text = this.text(value).trim()
    /* v8 ignore next -- an empty user turn is filtered before the transcript */
    if (text === '') return
    this.touch(at)
    this.assistants.push(clip(text, MAX_EXCERPT))
    if (this.assistants.length > MAX_RECENT_TEXTS) this.assistants.shift()
    this.pushKeyTurn({ role: 'assistant', text: clip(text, MAX_TURN_TEXT) })
  }

  addTool(call: ToolCall, at: number | undefined): void {
    this.touch(at)
    this.toolCalls += 1
    addUnique(this.tools, call.name, MAX_TOOLS)
    for (const file of filesFromInput(call.input)) addUnique(this.filesTouched, file, MAX_FILES)
    const command = commandFromInput(call.input)
    if (command !== undefined) {
      const safeCommand = this.text(command)
      addUnique(this.commands, safeCommand, MAX_COMMANDS)
      if (isTestCommand(safeCommand)) {
        const existing = this.tests.findIndex(test => test.command === safeCommand)
        if (existing >= 0) {
          /* v8 ignore next -- a test call without a call id is not linked */
          if (call.callId !== undefined) this.testByCall.set(call.callId, existing)
        } else if (this.tests.length < MAX_TESTS) {
          this.tests.push({ command: safeCommand, status: 'unknown' })
          if (call.callId !== undefined) this.testByCall.set(call.callId, this.tests.length - 1)
        }
      }
    }
  }

  toolResult(callId: string | undefined, failed: boolean): void {
    if (callId === undefined) return
    const index = this.testByCall.get(callId)
    if (index === undefined) return
    this.tests[index]!.status = failed ? 'failed' : 'passed'
    this.testByCall.delete(callId)
  }

  private pushKeyTurn(turn: KeyTurn): void {
    this.keyTurns.push(turn)
    while (this.keyTurns.length > MAX_KEY_TURNS) this.keyTurns.shift()
  }

  finish(input: { sourcePath: string; sourceHash: string; fallbackNativeId: string }): ParsedSession {
    const title = this.titleOverride
      ?? (this.firstUser !== '' ? clip(this.firstUser, MAX_TITLE) : clip(this.assistants.at(-1) ?? basename(input.sourcePath), MAX_TITLE))
    const excerpt = this.assistants.at(-1) ?? this.users.at(-1) ?? ''
    const nativeId = this.nativeId !== '' ? this.nativeId : input.fallbackNativeId
    const summary: ParsedSession = {
      agent: this.agent,
      sourceId: this.agent,
      nativeId,
      sourcePath: input.sourcePath,
      sourceHash: input.sourceHash,
      cwd: this.cwd,
      startedAt: this.startedAt ?? 0,
      title,
      turnCount: this.turnCountValue,
      userTurns: this.userTurns,
      toolCalls: this.toolCalls,
      tools: [...this.tools],
      filesTouched: [...this.filesTouched],
      commands: [...this.commands],
      tests: this.tests.map(test => ({ ...test })),
      flags: { ...this.flags },
      excerpt,
      keyTurns: this.keyTurns.map(turn => ({ ...turn })),
    }
    if (this.endedAt !== undefined) summary.endedAt = this.endedAt
    if (this.model !== undefined) summary.model = this.model
    if (this.parentNativeId !== undefined) summary.parentNativeId = this.parentNativeId
    if (this.subagentNames.size > 0) summary.subagentNames = Object.fromEntries(this.subagentNames)
    return summary
  }
}

/** Whether a normalized summary carries no user activity and no action. */
export function isEmptySession(session: ParsedSession): boolean {
  return session.userTurns === 0 && session.toolCalls === 0 && session.excerpt === '' && session.keyTurns.length === 0
}

export interface SessionRecordMeta {
  path: string
  hash: string
  fallbackNativeId: string
  redact: boolean
}

function headerTime(record: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const at = timestampOf(record[key])
    if (at !== undefined) return at
  }
  return undefined
}

/**
 * Normalize a DSH session JSONL file.
 * @param records - parsed JSONL records.
 * @param meta - source identity and redaction choice.
 * @returns the bounded summary.
 */
export function parseDshRecords(records: unknown[], meta: SessionRecordMeta): ParsedSession {
  const builder = new SummaryBuilder('dsh', meta.redact)
  const openTurns = new Set<number>()
  for (const raw of records) {
    if (!isRecord(raw)) continue
    const wrapped = isRecord(raw.event) ? raw.event : raw
    const type = stringOf(wrapped.type)
    if (type === undefined) continue
    const data = isRecord(wrapped.data) ? wrapped.data : {}
    const at = headerTime(wrapped, 'time', 'timestamp') ?? headerTime(raw, 'time', 'timestamp')
    if (type === 'session') {
      const parent = stringOf(raw.parentSession)
      builder.setIdentity({
        ...(stringOf(raw.id) === undefined ? {} : { nativeId: stringOf(raw.id)! }),
        ...(stringOf(raw.cwd) === undefined ? {} : { cwd: stringOf(raw.cwd)! }),
        ...(parent === undefined ? {} : { parentNativeId: parent }),
        ...(timestampOf(raw.createdAt) === undefined ? {} : { startedAt: timestampOf(raw.createdAt)! }),
      })
      if (raw.delegationDepth !== undefined && raw.delegationDepth !== 0) builder.flag('hasSubagents')
      continue
    }
    if (type === 'working-directory/change' && stringOf(data.cwd) !== undefined) builder.setIdentity({ cwd: stringOf(data.cwd)! })
    if (type === 'session/title') builder.setTitle(stringOf(data.title))
    if (type === 'turn/start') {
      const turn = typeof data.turn === 'number' ? data.turn : 0
      openTurns.add(turn)
      builder.setTurnCount(turn)
    }
    if (type === 'turn/end') {
      const turn = typeof data.turn === 'number' ? data.turn : 0
      openTurns.delete(turn)
    }
    if (type === 'user/message') {
      const source = isRecord(data.source) ? data.source : {}
      const kind = stringOf(source.kind)
      if (kind === 'runtime-context' || kind === 'plugin' || kind === 'system' || kind === 'tool') continue
      const text = textOfContent(data.content)
      if (text !== '') builder.addUser(text, at, false)
    }
    if (type === 'assistant/message') {
      const message = isRecord(data.message) ? data.message : {}
      const source = isRecord(message.source) ? message.source : {}
      if (stringOf(source.model) !== undefined) builder.setIdentity({ model: stringOf(source.model)! })
      const text = textOfContent(message.content)
      if (text !== '') builder.addAssistant(text, at)
    }
    if (type === 'tool/call') {
      builder.addTool({
        name: stringOf(data.name) ?? 'tool',
        input: parseArguments(data.arguments),
        ...(stringOf(data.callId) === undefined ? {} : { callId: stringOf(data.callId)! }),
      }, at)
    }
    if (type === 'tool/result') {
      const message = isRecord(data.message) ? data.message : {}
      const failed = message.isError === true || data.error !== undefined
      builder.toolResult(stringOf(message.toolCallId) ?? stringOf(data.callId), failed)
    }
    if (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end' || type === 'compaction/prune') builder.flag('compacted')
    if (type === 'subagent/catalog') {
      const childId = stringOf(data.childId)
      const name = stringOf(data.name)
      if (childId !== undefined && name !== undefined) builder.nameSubagent(childId, name)
    }
    if (type.startsWith('subagent/')) builder.flag('hasSubagents')
    if (type === 'model/selection' && stringOf(data.model) !== undefined) builder.setIdentity({ model: stringOf(data.model)! })
  }
  if (openTurns.size > 0) builder.flag('interrupted')
  return builder.finish({ sourcePath: meta.path, sourceHash: meta.hash, fallbackNativeId: meta.fallbackNativeId })
}

/**
 * Normalize a Claude Code session JSONL file.
 * @param records - parsed JSONL records.
 * @param meta - source identity and redaction choice.
 * @returns the bounded summary.
 */
export function parseClaudeRecords(records: unknown[], meta: SessionRecordMeta): ParsedSession {
  const builder = new SummaryBuilder('claude-code', meta.redact)
  for (const raw of records) {
    if (!isRecord(raw)) continue
    const type = stringOf(raw.type)
    if (type === undefined) continue
    const at = headerTime(raw, 'timestamp')
    const sessionId = stringOf(raw.sessionId)
    const cwd = stringOf(raw.cwd)
    const explicitParent = stringOf(raw.parentSessionId) ?? stringOf(raw.parent_session_id)
    builder.setIdentity({
      ...(sessionId === undefined ? {} : { nativeId: sessionId }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(explicitParent === undefined ? {} : { parentNativeId: explicitParent }),
      ...(at === undefined ? {} : { startedAt: at }),
    })
    if (raw.isSidechain === true) builder.flag('hasSubagents')
    if (type === 'summary') {
      builder.setTitle(stringOf(raw.summary))
      continue
    }
    if (type === 'system') {
      const subtype = stringOf(raw.subtype)
      if (subtype === 'compact_boundary') builder.flag('compacted')
      if (subtype === 'api_error') builder.flag('interrupted')
      continue
    }
    if (type === 'user') {
      const message = isRecord(raw.message) ? raw.message : {}
      const content = message.content
      const toolResults = Array.isArray(content)
        ? content.filter(block => isRecord(block) && block.type === 'tool_result')
        : []
      for (const block of toolResults) {
        /* v8 ignore next -- the filter above admits records only */
        if (!isRecord(block)) continue
        builder.toolResult(stringOf(block.tool_use_id), block.is_error === true)
      }
      if (toolResults.length === 0) {
        const text = textOfContent(content)
        if (text !== '') builder.addUser(text, at)
      }
      continue
    }
    if (type === 'assistant') {
      const message = isRecord(raw.message) ? raw.message : {}
      const model = stringOf(message.model)
      if (model !== undefined) builder.setIdentity({ model })
      const text = textOfContent(message.content)
      if (text !== '') builder.addAssistant(text, at)
      for (const call of toolCallsOfContent(message.content)) builder.addTool(call, at)
    }
  }
  if (records.length === 0) throw new SessionParseError(`the Claude Code session ${meta.path} is empty`)
  return builder.finish({ sourcePath: meta.path, sourceHash: meta.hash, fallbackNativeId: meta.fallbackNativeId })
}

function codexOutputStatus(output: string): boolean | undefined {
  const match = /\bExit code:\s*(-?\d+)\b/u.exec(output)
  if (match === null) return undefined
  return match[1] !== '0'
}

/**
 * Normalize a Codex rollout JSONL file.
 * @param records - parsed JSONL records.
 * @param meta - source identity and redaction choice.
 * @returns the bounded summary.
 */
export function parseCodexRecords(records: unknown[], meta: SessionRecordMeta): ParsedSession {
  const builder = new SummaryBuilder('codex', meta.redact)
  const eventUsers: Array<{ text: string; at: number | undefined }> = []
  const eventAssistants: Array<{ text: string; at: number | undefined }> = []
  const itemUsers: Array<{ text: string; at: number | undefined }> = []
  const itemAssistants: Array<{ text: string; at: number | undefined }> = []
  for (const raw of records) {
    if (!isRecord(raw)) continue
    const type = stringOf(raw.type)
    if (type === undefined) continue
    const payload = isRecord(raw.payload) ? raw.payload : {}
    const at = headerTime(raw, 'timestamp')
    if (type === 'session_meta') {
      const parent = stringOf(payload.parent_session_id) ?? stringOf(payload.parentSessionId)
      const source = isRecord(payload.source) ? payload.source : {}
      const subagent = source.subagent !== undefined || stringOf(source.kind) === 'subagent'
      builder.setIdentity({
        ...(stringOf(payload.id) === undefined ? {} : { nativeId: stringOf(payload.id)! }),
        ...(stringOf(payload.cwd) === undefined ? {} : { cwd: stringOf(payload.cwd)! }),
        ...(parent === undefined ? {} : { parentNativeId: parent }),
        /* v8 ignore next -- a timestamp fallback exists for a parsed record */
        ...((timestampOf(payload.timestamp) ?? at) === undefined ? {} : { startedAt: (timestampOf(payload.timestamp) ?? at)! }),
      })
      if (parent !== undefined || subagent) builder.flag('hasSubagents')
      continue
    }
    if (type === 'turn_context') {
      builder.setIdentity({
        ...(stringOf(payload.cwd) === undefined ? {} : { cwd: stringOf(payload.cwd)! }),
        ...(stringOf(payload.model) === undefined ? {} : { model: stringOf(payload.model)! }),
      })
      continue
    }
    if (type === 'event_msg') {
      const event = stringOf(payload.type)
      if (event === 'user_message') eventUsers.push({ text: stringOf(payload.message) ?? '', at })
      if (event === 'agent_message') eventAssistants.push({ text: stringOf(payload.message) ?? '', at })
      if (event === 'turn_aborted' || event === 'error') builder.flag('interrupted')
      if (event !== undefined && event.includes('compact')) builder.flag('compacted')
      continue
    }
    if (type === 'compacted') { builder.flag('compacted'); continue }
    if (type === 'response_item') {
      const item = stringOf(payload.type)
      if (item === 'message') {
        const role = stringOf(payload.role)
        const text = textOfContent(payload.content)
        if (text !== '') {
          if (role === 'user') itemUsers.push({ text, at })
          if (role === 'assistant') itemAssistants.push({ text, at })
        }
        continue
      }
      if (item === 'function_call' || item === 'custom_tool_call' || item === 'local_shell_call') {
        const action = isRecord(payload.action) ? payload.action : {}
        const rawInput = item === 'function_call' ? parseArguments(payload.arguments) : (payload.input ?? payload.action ?? {})
        const input = item === 'custom_tool_call' && typeof rawInput === 'string' ? { patch: rawInput } : rawInput
        builder.addTool({
          name: stringOf(payload.name) ?? (item === 'local_shell_call' ? 'shell' : 'tool'),
          input: action.command !== undefined ? action : input,
          ...(stringOf(payload.call_id) === undefined ? {} : { callId: stringOf(payload.call_id)! }),
        }, at)
        continue
      }
      /* v8 ignore next -- not every item is a tool-output item */
      if (item === 'function_call_output' || item === 'custom_tool_call_output' || item === 'local_shell_call_output') {
        const output = typeof payload.output === 'string' ? payload.output : ''
        const failed = codexOutputStatus(output)
        builder.toolResult(stringOf(payload.call_id), failed ?? /^\s*error\b/iu.test(output))
      }
    }
  }
  const users = itemUsers.length > 0 ? itemUsers : eventUsers
  const assistants = itemAssistants.length > 0 ? itemAssistants : eventAssistants
  for (const entry of users) builder.addUser(entry.text, entry.at)
  for (const entry of assistants) builder.addAssistant(entry.text, entry.at)
  if (records.length === 0) throw new SessionParseError(`the Codex session ${meta.path} is empty`)
  return builder.finish({ sourcePath: meta.path, sourceHash: meta.hash, fallbackNativeId: meta.fallbackNativeId })
}

function recordsFromText(text: string, path: string): unknown[] {
  const trimmed = text.trim()
  if (trimmed === '') throw new SessionParseError(`the session file ${path} is empty`)
  if (path.endsWith('.json')) {
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch (error) {
      throw new SessionParseError(`the session file ${path} is not valid JSON: ${String((error as Error).message)}`)
    }
    if (Array.isArray(parsed)) return parsed
    if (isRecord(parsed) && Array.isArray(parsed.events)) return parsed.events
    if (isRecord(parsed)) return [parsed]
    throw new SessionParseError(`the session file ${path} has no JSON records`)
  }
  const records: unknown[] = []
  let valid = 0
  for (const line of trimmed.split(/\r?\n/u)) {
    /* v8 ignore next -- blank JSONL lines are tolerated */
    if (line.trim() === '') continue
    valid += 1
    try { records.push(JSON.parse(line) as unknown) } catch { /* one bad line is skipped; the rest still parse */ }
  }
  if (valid > 0 && records.length === 0) throw new SessionParseError(`the session file ${path} has no valid JSONL records`)
  return records
}

/**
 * Normalize one session file already read into text. Exposed so tests and
 * probes can exercise the adapters without a filesystem.
 * @param agent - which adapter to use.
 * @param text - the file's text.
 * @param meta - source identity and redaction choice.
 * @returns the bounded summary.
 */
export function parseSessionText(agent: AgentKind, text: string, meta: SessionRecordMeta): ParsedSession {
  const records = recordsFromText(text, meta.path)
  if (agent === 'dsh') return parseDshRecords(records, meta)
  if (agent === 'claude-code') return parseClaudeRecords(records, meta)
  return parseCodexRecords(records, meta)
}

/**
 * Read and normalize one discovered session file.
 * @param file - the discovered file.
 * @param options - redaction choice.
 * @returns the normalized summary.
 */
export async function parseSessionFile(file: SourceFile, options: { redactSecrets: boolean }): Promise<ParsedSession> {
  const info = await stat(file.path)
  if (!info.isFile()) throw new SessionParseError(`the session path ${file.path} is not a file`)
  if (info.size > MAX_SESSION_BYTES) throw new SessionParseError(`the session file ${file.path} is larger than ${String(MAX_SESSION_BYTES)} bytes`)
  const text = await readFile(file.path, 'utf8')
  const hash = createHash('sha256').update(text).digest('hex')
  return parseSessionText(file.agent, text, {
    path: file.path,
    hash,
    fallbackNativeId: basename(file.path).replace(/\.jsonl?$/u, ''),
    redact: options.redactSecrets,
  })
}

function acceptedExtension(path: string): boolean {
  return path.endsWith('.jsonl') || path.endsWith('.json')
}

/** Pick the newest DSH format generation in one directory (vN wins over the unversioned file). */
function dshLatestByDirectory(files: SourceFile[]): SourceFile[] {
  const groups = new Map<string, { best: SourceFile; version: number }>()
  const others: SourceFile[] = []
  for (const file of files) {
    const match = /^session(?:\.\d+)?(?:\.v(\d+))?\.jsonl$/u.exec(basename(file.path))
    if (match === null || !basename(file.path).startsWith('session')) {
      others.push(file)
      continue
    }
    const version = match[1] === undefined ? 0 : Number(match[1])
    const key = dirname(file.path)
    const group = groups.get(key)
    if (group === undefined || version > group.version) groups.set(key, { best: file, version })
  }
  return [...others, ...[...groups.values()].map(group => group.best)]
}

interface WalkState {
  files: SourceFile[]
  errors: string[]
  truncated: boolean
}

async function walk(root: string, agent: AgentKind, depth: number, state: WalkState): Promise<void> {
  if (depth > MAX_WALK_DEPTH || state.files.length >= MAX_SOURCE_FILES) { state.truncated = true; return }
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    state.errors.push(`${root}: ${String((error as Error).message)}`)
    return
  }
  for (const entry of entries) {
    if (state.files.length >= MAX_SOURCE_FILES) { state.truncated = true; return }
    const path = join(root, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) { await walk(path, agent, depth + 1, state); continue }
    if (!entry.isFile() || !acceptedExtension(path)) continue
    try {
      const info = await stat(path)
      state.files.push({ agent, path, mtimeMs: info.mtimeMs, size: info.size })
    } catch (error) {
      /* v8 ignore next -- the entry came from readdir; a vanished file race is the only path */
      state.errors.push(`${path}: ${String((error as Error).message)}`)
    }
  }
}

/**
 * Discover one source's session files. A missing root is a real "not found"
 * state, not an empty workspace; a symlink inside the tree is skipped.
 * @param agent - the source adapter.
 * @param root - the configured directory or one session file.
 * @returns the discovered files (bounded) and any read errors.
 */
export async function discoverSource(agent: AgentKind, root: string): Promise<DiscoveredSource> {
  let info
  try { info = await stat(root) } catch { return { agent, root, found: false, files: [], errors: [], truncated: false } }
  if (info.isFile()) {
    return acceptedExtension(root)
      ? { agent, root, found: true, files: [{ agent, path: root, mtimeMs: info.mtimeMs, size: info.size }], errors: [], truncated: false }
      : { agent, root, found: true, files: [], errors: [`${root}: unsupported session file extension`], truncated: false }
  }
  if (!info.isDirectory()) return { agent, root, found: true, files: [], errors: [`${root}: not a directory`], truncated: false }
  const state: WalkState = { files: [], errors: [], truncated: false }
  await walk(root, agent, 0, state)
  const files = agent === 'dsh' ? dshLatestByDirectory(state.files) : state.files
  return { agent, root, found: true, files, errors: state.errors, truncated: state.truncated }
}

/** Which root setting belongs to each agent. */
export function sourceRootFor(settingsRoots: { dsh: string; claudeCode: string; codex: string }, agent: AgentKind): string {
  if (agent === 'dsh') return settingsRoots.dsh
  if (agent === 'claude-code') return settingsRoots.claudeCode
  return settingsRoots.codex
}
