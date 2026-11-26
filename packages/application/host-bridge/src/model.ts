/**
 * The shared platform-model port: one single-turn call behind the application's
 * `model` capability. Applications do not mount their own model stack; the host
 * injects this port and the app passes its operation-bound capability door.
 *
 * The port keeps the parts every application would otherwise repeat: the route
 * selection, abort handling, streamed usage, bounded output, and optional
 * structured decoding. It does not retry, keep conversation, or decide what may
 * be sent — those are the application's own policy.
 * @module @matrix1001/dsh-application-harness-host-bridge/model
 */

import { BlockAssembler, createUserMessage, type ContentBlock, type GenerateOptions, type LlmRuntime, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { CapabilityAccess } from '@matrix1001/dsh-application-harness-runtime'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'application-harness-model': { kind: 'application-harness-model' }
  }
}

/** Stable model-call failure codes. */
export type ModelCallCode = 'platform.model-unavailable' | 'platform.model-failed' | 'platform.model-invalid-output' | 'platform.model-limit-exceeded'

/** No model service or no configured model route. */
export class ModelUnavailableError extends Error {
  readonly code = 'platform.model-unavailable' as const
  constructor(message: string) { super(message); this.name = 'ModelUnavailableError' }
}

/** A model call failed, or its structured answer did not validate. */
export class ModelCallError extends Error {
  constructor(
    /** Stable code the application can branch on. */
    readonly code: Exclude<ModelCallCode, 'platform.model-unavailable'>,
    message: string,
  ) {
    super(message)
    this.name = 'ModelCallError'
  }
}

/** One single-turn model request. */
export interface ModelAskRequest<T = string> {
  /** The user prompt (the caller decides what data it carries). */
  readonly prompt: string
  /** Optional system prompt. */
  readonly system?: string
  /** Forwarded to the platform stream; aborting ends the call as AbortError. */
  readonly signal?: AbortSignal
  /** The application's capability door. */
  readonly capabilities: CapabilityAccess
  /** Whether the application marks this as background work (applies background limits). */
  readonly background?: boolean
  /** Upper bound on generated tokens. */
  readonly maxOutputTokens?: number
  /** Sampling temperature. */
  readonly temperature?: number
  /**
   * Decode the text answer. A throw becomes `platform.model-invalid-output`; without a
   * decoder the result carries only text.
   */
  readonly parse?: (text: string) => T
}

/** What one model call produced. */
export interface ModelAskResult<T = string> {
  readonly text: string
  readonly structured?: T
  readonly usage?: { readonly inputTokens?: number; readonly outputTokens?: number }
  readonly model?: { readonly provider: string; readonly model: string }
}

/** The model face an application holds. */
export interface ModelPort {
  ask<T = string>(request: ModelAskRequest<T>): Promise<ModelAskResult<T>>
}

interface DefaultModelFace { currentSelection?(): { provider: string; model: string } | undefined }

function textBlocks(blocks: readonly ContentBlock[]): string {
  return blocks.filter((block): block is { type: 'text'; text: string } => block.type === 'text').map(block => block.text).join(' ')
}

function cancelled(message: string): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

function usageOf(usage: TokenUsage | undefined): ModelAskResult['usage'] {
  if (usage === undefined) return undefined
  return { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens }
}

/**
 * Build the port over the host context.
 * @param ctx - the host context that owns `llm` and `agentDefaultModel`.
 * @returns the port; availability is decided per call, so a late-mounted route works.
 */
export function createPlatformModelPort(ctx: Context, appId?: string): ModelPort {
  return {
    ask: async <T>(request: ModelAskRequest<T>): Promise<ModelAskResult<T>> => {
      const started = Date.now()
      let status: 'success' | 'failed' | 'cancelled' = 'failed'
      let selected: { provider: string; model: string } | undefined
      let usageValue: ModelAskResult['usage']
      let release: (() => void) | undefined
      try {
        return await request.capabilities.use('model', async () => {
          if (appId !== undefined) {
            const gate = ctx.get('applicationModelLimits') as { begin?: (id: string, background: boolean) => Promise<() => void> } | undefined
            if (gate?.begin !== undefined) {
              try {
                release = await gate.begin(appId, request.background === true)
              } catch (error) {
                throw new ModelCallError('platform.model-limit-exceeded', error instanceof Error ? error.message : String(error))
              }
            }
          }
          const llm = ctx.get('llm') as LlmRuntime | undefined
          if (llm === undefined) throw new ModelUnavailableError('this composition mounts no platform LLM service')
          const configured = appId === undefined
            ? undefined
            : (ctx.get('applicationModelSettings') as { selection?: (id: string) => { provider: string; model: string } | undefined } | undefined)?.selection?.(appId)
          const selection = configured ?? (ctx.get('agentDefaultModel') as DefaultModelFace | undefined)?.currentSelection?.()
          if (selection === undefined) throw new ModelUnavailableError('no model route is configured')
          selected = { provider: selection.provider, model: selection.model }
          const options: GenerateOptions = {
            provider: selection.provider,
            model: selection.model,
            messages: [createUserMessage({ content: [{ type: 'text', text: request.prompt }], source: { kind: 'application-harness-model' } })],
            ...(request.system === undefined ? {} : { system: request.system }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
            ...(request.maxOutputTokens === undefined ? {} : { maxTokens: request.maxOutputTokens }),
            ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          }
          const assembler = new BlockAssembler()
          for await (const chunk of llm.stream(options)) assembler.push(chunk)
          const finish = assembler.finish
          if (finish.kind === 'error') throw new ModelCallError('platform.model-failed', `the model call failed (${finish.failure.code}): ${finish.failure.message}`)
          if (finish.kind === 'aborted') {
            if (request.signal?.aborted === true) throw cancelled('the model call was cancelled by the caller')
            throw new ModelCallError('platform.model-failed', `the model call was aborted (${finish.failure.code}): ${finish.failure.message}`)
          }
          const text = textBlocks(assembler.blocks())
          let structured: T | undefined
          if (request.parse !== undefined) {
            try {
              structured = request.parse(text)
            } catch (error) {
              throw new ModelCallError('platform.model-invalid-output', `the model answer did not validate: ${String((error as Error)?.message ?? error)}`)
            }
          }
          usageValue = usageOf(assembler.usage)
          status = 'success'
          return {
            text,
            ...(structured === undefined ? {} : { structured }),
            ...(usageValue === undefined ? {} : { usage: usageValue }),
            model: { provider: selection.provider, model: selection.model },
          }
        })
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') status = 'cancelled'
        throw error
      } finally {
        release?.()
        if (appId !== undefined) {
          const recorder = (ctx.get('applicationModelUsage') as { record?: (id: string, record: { status: 'success' | 'failed' | 'cancelled'; durationMs: number; model?: { provider: string; model: string }; inputTokens?: number; outputTokens?: number }) => Promise<void> | void } | undefined)?.record
          if (recorder !== undefined) {
            try {
              await recorder(appId, {
                status,
                durationMs: Date.now() - started,
                ...(selected === undefined ? {} : { model: selected }),
                ...(usageValue?.inputTokens === undefined ? {} : { inputTokens: usageValue.inputTokens }),
                ...(usageValue?.outputTokens === undefined ? {} : { outputTokens: usageValue.outputTokens }),
              })
            } catch {
              // Usage is telemetry; a failed write never changes the model answer.
            }
          }
        }
      }
    },
  }
}
