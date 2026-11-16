import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { CapabilityAccess } from '@matrix1001/dsh-application-harness-runtime'
import { createPlatformModelPort, ModelCallError, ModelUnavailableError } from '../src/model.ts'

function door(asked: string[] = []): CapabilityAccess {
  return {
    appId: 'review',
    use: async <T>(name: string, work: () => T | Promise<T>): Promise<T> => { asked.push(name); return await work() },
  }
}

function fakeCtx(services: { llm?: unknown; agentDefaultModel?: unknown; applicationModelSettings?: unknown; applicationModelUsage?: unknown; applicationModelLimits?: unknown }): Context {
  return { get: (name: string) => (services as Record<string, unknown>)[name] } as unknown as Context
}

function fakeLlm(chunks: StreamChunk[]): { options: GenerateOptions[]; llm: { stream(options: GenerateOptions): AsyncIterable<StreamChunk> } } {
  const options: GenerateOptions[] = []
  return {
    options,
    llm: {
      stream: (call: GenerateOptions) => {
        options.push(call)
        return { async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk } }
      },
    },
  }
}

function textChunks(text: string, usage?: { inputTokens: number; outputTokens: number }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    ...(usage === undefined ? [] : [{ type: 'usage' as const, usage }]),
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const routed = { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }

describe('platform model port', () => {
  it('degrades to a typed unavailable error without a mounted LLM service or route', async () => {
    await expect(createPlatformModelPort(new Context()).ask({ prompt: 'hello', capabilities: door() })).rejects.toBeInstanceOf(ModelUnavailableError)
    const { llm } = fakeLlm(textChunks('answer'))
    await expect(createPlatformModelPort(fakeCtx({ llm })).ask({ prompt: 'hello', capabilities: door() })).rejects.toBeInstanceOf(ModelUnavailableError)
  })

  it('asks the model capability, routes the call and returns text, usage and model', async () => {
    const { llm, options } = fakeLlm(textChunks('review', { inputTokens: 3, outputTokens: 4 }))
    const asked: string[] = []
    const result = await createPlatformModelPort(fakeCtx({ llm, agentDefaultModel: routed })).ask({
      prompt: 'hello', system: 'be brief', maxOutputTokens: 12, temperature: 0.2, capabilities: door(asked),
    })
    expect(asked).toEqual(['model'])
    expect(result).toEqual({
      text: 'review',
      usage: { inputTokens: 3, outputTokens: 4 },
      model: { provider: 'deepseek-official', model: 'deepseek-flash' },
    })
    expect(options[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash', system: 'be brief', maxTokens: 12, temperature: 0.2 })
  })

  it('uses the application fixed route before the platform default', async () => {
    const { llm, options } = fakeLlm(textChunks('fixed'))
    const ctx = fakeCtx({
      llm,
      agentDefaultModel: routed,
      applicationModelSettings: { selection: (id: string) => id === 'review' ? { provider: 'fixed', model: 'route' } : undefined },
    })
    await createPlatformModelPort(ctx, 'review').ask({ prompt: 'hello', capabilities: door() })
    expect(options[0]).toMatchObject({ provider: 'fixed', model: 'route' })
    const fallback = fakeLlm(textChunks('default'))
    const fallbackCtx = fakeCtx({ llm: fallback.llm, agentDefaultModel: routed, applicationModelSettings: { selection: () => undefined } })
    await createPlatformModelPort(fallbackCtx, 'other').ask({ prompt: 'hello', capabilities: door() })
    expect(fallback.options[0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash' })
  })

  it('applies the application model limits and releases the slot', async () => {
    const calls: Array<{ id: string; background: boolean }> = []
    let releases = 0
    const { llm } = fakeLlm(textChunks('ok'))
    const port = createPlatformModelPort(fakeCtx({
      llm,
      agentDefaultModel: routed,
      applicationModelLimits: { begin: async (id: string, background: boolean) => { calls.push({ id, background }); return () => { releases += 1 } } },
    }), 'review')
    await port.ask({ prompt: 'hi', capabilities: door() })
    await port.ask({ prompt: 'hi', background: true, capabilities: door() })
    expect(calls).toEqual([{ id: 'review', background: false }, { id: 'review', background: true }])
    expect(releases).toBe(2)

    const denied = createPlatformModelPort(fakeCtx({
      llm: fakeLlm(textChunks('never')).llm,
      agentDefaultModel: routed,
      applicationModelLimits: { begin: async () => { throw new Error('disabled') } },
    }), 'review')
    await expect(denied.ask({ prompt: 'hi', background: true, capabilities: door() })).rejects.toMatchObject({ code: 'model-limit-exceeded' })
    const deniedString = createPlatformModelPort(fakeCtx({
      llm: fakeLlm(textChunks('never')).llm,
      agentDefaultModel: routed,
      applicationModelLimits: { begin: async () => { throw 'disabled' } },
    }), 'review')
    await expect(deniedString.ask({ prompt: 'hi', background: true, capabilities: door() })).rejects.toMatchObject({ code: 'model-limit-exceeded' })
  })

  it('records success, failure and cancellation without changing the answer', async () => {
    const records: unknown[] = []
    const usage = { record: async (_id: string, record: unknown) => { records.push(record) } }
    const ok = fakeLlm(textChunks('answer', { inputTokens: 2, outputTokens: 3 }))
    await createPlatformModelPort(fakeCtx({ llm: ok.llm, agentDefaultModel: routed, applicationModelUsage: usage }), 'review')
      .ask({ prompt: 'hi', capabilities: door() })
    expect(records[0]).toMatchObject({ status: 'success', model: { provider: 'deepseek-official', model: 'deepseek-flash' }, inputTokens: 2, outputTokens: 3 })
    const failed = createPlatformModelPort(fakeCtx({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad' } } }]).llm,
      agentDefaultModel: routed,
      applicationModelUsage: usage,
    }), 'review')
    await expect(failed.ask({ prompt: 'hi', capabilities: door() })).rejects.toBeInstanceOf(ModelCallError)
    expect(records[1]).toMatchObject({ status: 'failed' })
    const controller = new AbortController()
    controller.abort()
    const aborted = createPlatformModelPort(fakeCtx({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stop' } } }]).llm,
      agentDefaultModel: routed,
      applicationModelUsage: usage,
    }), 'review')
    await expect(aborted.ask({ prompt: 'hi', signal: controller.signal, capabilities: door() })).rejects.toMatchObject({ name: 'AbortError' })
    expect(records[2]).toMatchObject({ status: 'cancelled' })
    const denied: unknown[] = []
    const deniedPort = createPlatformModelPort(fakeCtx({
      llm: fakeLlm(textChunks('never')).llm,
      agentDefaultModel: routed,
      applicationModelUsage: { record: async (_id: string, record: unknown) => { denied.push(record) } },
    }), 'review')
    await expect(deniedPort.ask({ prompt: 'x', capabilities: { appId: 'review', use: async () => { throw new Error('denied') } } })).rejects.toThrow(/denied/u)
    expect(denied[0]).toMatchObject({ status: 'failed' })
    expect(denied[0]).not.toHaveProperty('model')

    const broken = { record: async () => { throw new Error('disk') } }
    const still = fakeLlm(textChunks('fine'))
    await expect(createPlatformModelPort(fakeCtx({ llm: still.llm, agentDefaultModel: routed, applicationModelUsage: broken }), 'review')
      .ask({ prompt: 'hi', capabilities: door() })).resolves.toMatchObject({ text: 'fine' })
  })

  it('decodes structured output and reports a failed decoder as invalid output', async () => {
    const { llm } = fakeLlm(textChunks('{"ok":true}'))
    const port = createPlatformModelPort(fakeCtx({ llm, agentDefaultModel: routed }))
    const parsed = await port.ask({ prompt: 'json', capabilities: door(), parse: (text) => JSON.parse(text) as { ok: boolean } })
    expect(parsed.structured).toEqual({ ok: true })
    await expect(port.ask({ prompt: 'json', capabilities: door(), parse: () => { throw new Error('shape') } }))
      .rejects.toMatchObject({ code: 'model-invalid-output' })
    await expect(port.ask({ prompt: 'json', capabilities: door(), parse: () => { throw 'shape' } }))
      .rejects.toMatchObject({ code: 'model-invalid-output' })
  })

  it('reports provider failures and the caller cancellation distinctly', async () => {
    const failed = createPlatformModelPort(fakeCtx({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'error', failure: { code: 'AUTH', message: 'bad key' } } }]).llm,
      agentDefaultModel: routed,
    }))
    await expect(failed.ask({ prompt: 'hi', capabilities: door() })).rejects.toBeInstanceOf(ModelCallError)

    const controller = new AbortController()
    controller.abort()
    const aborted = createPlatformModelPort(fakeCtx({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }]).llm,
      agentDefaultModel: routed,
    }))
    const error = await aborted.ask({ prompt: 'hi', signal: controller.signal, capabilities: door() }).catch((thrown: unknown) => thrown as Error) as unknown as Error
    expect(error.name).toBe('AbortError')

    const remoteAbort = createPlatformModelPort(fakeCtx({
      llm: fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'stopped' } } }]).llm,
      agentDefaultModel: routed,
    }))
    await expect(remoteAbort.ask({ prompt: 'hi', capabilities: door() })).rejects.toMatchObject({ code: 'model-failed' })
  })
})

describe('model usage absence', () => {
  it('returns no usage when the stream carries none', async () => {
    const { llm } = fakeLlm(textChunks('plain'))
    const result = await createPlatformModelPort(fakeCtx({ llm, agentDefaultModel: routed })).ask({ prompt: 'plain', capabilities: door() })
    expect(result.usage).toBeUndefined()
  })
})
