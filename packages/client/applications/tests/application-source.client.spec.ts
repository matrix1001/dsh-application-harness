/**
 * The application reference source in isolation: every available application is
 * offered as `@app:<id>`, while the application already represented by the
 * page row (current or pending) is omitted. The source never prefetches data.
 */
import { describe, expect, it } from 'vitest'
import type { InputTriggerCandidate, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { AppInfo } from '@matrix1001/dsh-application-harness-host-bridge/client'
import { createApplicationSource, APPLICATION_SOURCE_NAME } from '../src/client/application-source.ts'
import type { ApplicationsState } from '../src/client/shell.ts'
import type { PageContext, PageContextService } from '../src/client/contract.ts'

const t = ((key: string) => key) as TranslateNS<'applications'>

function app(id: string, status: AppInfo['status'] = 'available'): AppInfo {
  return {
    id,
    name: id,
    description: `${id} description`,
    version: '1',
    status,
    ops: [],
  } as unknown as AppInfo
}

function state(apps: readonly AppInfo[] | undefined): { getSnapshot(): ApplicationsState } {
  return { getSnapshot: () => ({ apps }) as ApplicationsState }
}

function pageContext(page: PageContext | undefined): PageContextService {
  return { current: () => page, report: () => () => {}, subscribe: () => () => {} }
}

function source(apps: readonly AppInfo[] | undefined, page?: PageContext): InputTriggerSource {
  return createApplicationSource(
    state(apps),
    { views: () => new Map(), register: () => () => {}, state: () => ({}) } as never,
    pageContext(page),
    t,
  )
}

async function rows(of: InputTriggerSource): Promise<readonly InputTriggerCandidate[]> {
  return await of.candidates({ sessionId: 's' } as never, {
    query: '', position: 'inline', drilled: false, signal: new AbortController().signal,
  })
}

describe('the application reference source', () => {
  it('offers nothing before the application list answers', async () => {
    expect(await rows(source(undefined))).toEqual([])
  })

  it('offers every available application and omits the represented one', async () => {
    const page = { appId: 'workbook', label: 'Workbook' } as const
    const offered = await rows(source([app('workbook'), app('info-hub'), app('disk-analysis', 'stopped')], page))
    expect(offered).toEqual([{
      name: 'info-hub',
      label: 'info-hub',
      description: 'info-hub description',
      value: '@app:info-hub',
      section: 'reference.applications',
    }])
  })

  it('picks the application as an application chip and serializes its token', async () => {
    const of = source([app('workbook')])
    const candidate = (await rows(of))[0]!
    expect(of.onPick({
      candidate,
      session: { sessionId: 's' } as never,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 0, draftRev: 1 },
    })).toEqual({
      insert: {
        source: APPLICATION_SOURCE_NAME,
        ref: '@app:workbook',
        label: 'workbook',
        clipboardText: '@app:workbook',
      },
    })
    expect(of.codec?.clipboardText('@app:workbook')).toBe('@app:workbook')
    await expect(of.codec?.serialize('@app:workbook', new AbortController().signal)).resolves.toBe('@app:workbook')
    expect(of.onPick({
      candidate: { name: 'label-less', value: '@app:label-less' },
      session: { sessionId: 's' } as never,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 0, draftRev: 1 },
    })).toMatchObject({ insert: { label: 'label-less' } })
    expect(() => of.onPick({
      candidate: { name: 'broken' },
      session: { sessionId: 's' } as never,
      position: 'inline',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 0, draftRev: 1 },
    })).toThrow(/no reference/u)
  })
})
