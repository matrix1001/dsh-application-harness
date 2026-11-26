/**
 * The shared test host for the page-context suite: the REAL application
 * runtime, mounted through its own plugin, with the REAL context plugin on top
 * of it, driven through the REAL `agent/pre-step` waterfall.
 *
 * The observation surface is the step decision — what the pre-step rung admits
 * to the model — never an internal function: a test drives the same dispatch
 * the agent loop drives and reads the messages that come out. Applications
 * register the way a deployment registers them (a declaration through the
 * runtime), and nothing here fakes a message the platform would produce.
 */

import { Context } from '@deepseek-ai/cordis'
import { apply as applyRuntime, type AppDeclaration, type ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { agentEvents, type Agent, type PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import * as PageContext from '../src/index.ts'

/** The session a test's fake agent belongs to. */
export const SESSION = 'session-1' as SessionId

/** One mounted test host. */
export interface Host {
  readonly ctx: Context
  readonly runtime: ApplicationRuntime
  /** Drive one pre-step through the real waterfall (this plugin is one of its rungs). */
  preStep: (messages: readonly UserMessage[], signal?: AbortSignal, turn?: number) => Promise<PreStepDecision>
  /** End one turn through the real event, so the plugin's cleanup runs. */
  stopTurn: (turn?: number) => void
}

/**
 * Mount the runtime, register the applications, and mount the context plugin.
 * @param declarations - the applications to register before the plugin mounts.
 * @returns the host.
 */
export async function host(declarations: readonly AppDeclaration[] = [notesApp()], appSession = true, developmentApp?: string): Promise<Host> {
  const ctx = new Context()
  applyRuntime(ctx, {})
  ctx.reflect.provide('appTools', { has: () => appSession, ...(developmentApp === undefined ? {} : { developmentApp: () => developmentApp }) } as never)
  const runtime = ctx.applications
  if (runtime === undefined) throw new Error('test host: the runtime did not mount')
  for (const declaration of declarations) await runtime.register(declaration)
  await ctx.plugin(PageContext, {})
  const agent = { id: SESSION, session: { id: SESSION }, options: {} } as unknown as Agent
  const events = agentEvents(ctx, agent)
  return {
    ctx,
    runtime,
    stopTurn: (turn = 1) => { ctx.emit('agent/turn-stopping', { agent, turn } as never) },
    preStep: (messages, signal = new AbortController().signal, turn = 1) => Promise.resolve(
      events.waterfall(
        'agent/pre-step',
        { messages: [...messages], turn, step: 1, signal, modelSelection: { provider: 'test', model: 'test' } },
        () => Promise.resolve({ kind: 'enter' as const, messages: [...messages] }),
      ),
    ),
  }
}

/**
 * Enter one pre-step through a host whose rung REJECTS: the plugin must hand the
 * rejection back untouched rather than prepare context nobody will read.
 * @param ctx - the mounted host context.
 * @param messages - the messages the step carried.
 * @returns the rejection the dispatcher produced.
 */
export async function rejectedPreStep(ctx: Context, messages: readonly UserMessage[]): Promise<PreStepDecision> {
  const agent = { id: SESSION, session: { id: SESSION }, options: {} } as unknown as Agent
  return await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [...messages], turn: 1, step: 1, signal: new AbortController().signal, modelSelection: { provider: 'test', model: 'test' } },
    () => Promise.resolve({ kind: 'reject' as const }),
  )
}

/** One user message carrying the text the test wants to send. */
export function userMessage(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/**
 * A notes-shaped application using the production record table: one AI-open
 * `contextState` operation answering `{ notes }`. Notes carry `title` and an
 * optional `deletedAt`; the lightweight `text`/`deleted` test aliases are
 * normalized here so existing prose fixtures stay readable.
 * @param state - the notes collection the operation answers with.
 * @param over - declaration overrides (a failing start, a closed exposure, …).
 * @returns the declaration.
 */
export function notesApp(
  state: { readonly notes?: readonly JsonValue[] } = {},
  over: Partial<AppDeclaration['ops']> = {},
): AppDeclaration {
  return {
    id: 'notes',
    name: 'Notes',
    description: 'notes over one document',
    version: '1.2.3',
    ops: {
      contextState: {
        description: 'reads the notes document',
        params: {},
        result: { type: 'json' },
        exposure: { ai: 'open' },
        effect: 'read',
        execute: () => ({
          notes: (state.notes ?? []).map((note) => {
            if (typeof note !== 'object' || note === null || Array.isArray(note)) return note
            const record = note as Record<string, JsonValue>
            return {
              ...record,
              ...(record['title'] === undefined && typeof record['text'] === 'string' ? { title: record['text'].split('\n')[0] } : {}),
              ...(record['deleted'] === true && record['deletedAt'] === undefined ? { deletedAt: 1 } : {}),
            }
          }),
        }),
      },
      ...over,
    },
  }
}

/**
 * A second application in the same host, registered so a two-page test can show
 * each citation resolving against its own application.
 * @param id - its application id (also the citation's appId).
 * @returns the declaration, with one AI-open `read` operation answering `{ items }`.
 */
export function listApp(id: string): AppDeclaration {
  return {
    id,
    name: `${id} title`,
    description: `${id} application`,
    version: '1.2.3',
    ops: {
      read: {
        description: 'reads the records of this application',
        params: {},
        result: { type: 'json' },
        exposure: { ai: 'open' },
        execute: () => ({ items: [{ id: `${id}-1` }] }),
      },
    },
  }
}
