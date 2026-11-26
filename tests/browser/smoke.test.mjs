#!/usr/bin/env node
/**
 * The browser smoke lane: does the assembled product actually work?
 *
 * Unit coverage proves lines ran; these flows prove the product a user gets —
 * the platform shell boots the composed profile and the applications area
 * renders every deployed app. They run against an isolated instance
 * (`harness.mjs`), never the daily one.
 *
 * App-surface flows (opening the local applications and asserting their
 * anchors) need no API key: the app pages mount against the isolated workspace's
 * local data. Network/model flows, when added, belong behind an explicit key
 * gate of their own; they must not decide whether the local surfaces are
 * exercised.
 *
 * Usage: node tests/browser/smoke.test.mjs
 * @module tests/browser/smoke
 */

import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { chromium } from 'playwright'
import { resolveChrome } from '../../scripts/playwright-chrome.mjs'
import { startInstance } from './harness.mjs'

let instance
let browser
let page
const failures = []
before(async () => {
  instance = await startInstance()
  const executablePath = await resolveChrome()
  browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  page = await browser.newPage()
  page.on('pageerror', error => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => { if (message.type() === 'error') failures.push(`console: ${message.text()}`) })
  page.on('requestfailed', (request) => failures.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ''}`))
  await page.goto(instance.url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined)
  await dismissOverlays()
  await openApplications()
})

after(async () => {
  await browser?.close()
  await instance?.stop()
})

/**
 * Close first-boot overlays. A fresh isolated home shows the platform's preview
 * note and may open the workspace picker; both mount a modal mask that would
 * otherwise intercept every click.
 */
async function dismissOverlays() {
  // The preview note mounts after the shell; wait for it rather than racing it.
  const cont = page.locator('button[aria-label="继续"], button[aria-label="Continue"], button').filter({ hasText: /^(继续|Continue)$/u })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if ((await cont.count()) > 0) { await cont.first().click().catch(() => undefined); break }
    await page.waitForTimeout(250)
  }
  await page.keyboard.press('Escape').catch(() => undefined)
  await page.waitForTimeout(300)
}

/** Open the applications area once; later calls are a no-op while the rail is up. */
async function openApplications() {
  if (await page.locator('[data-app-tabs]').first().isVisible().catch(() => false)) return
  await dismissOverlays()
  const entry = page.locator('button[aria-label="应用"], button[aria-label="Applications"]')
  if (await entry.count()) await entry.first().click()
  // A fresh home may still ask which workspace to use; pick the seeded one.
  const picker = page.locator('button[aria-label="选择工作区"], button[aria-label="Choose workspace"]')
  if (await picker.count()) await picker.first().click().catch(() => undefined)
  const seeded = page.getByText('browser', { exact: true })
  if (await seeded.count()) await seeded.first().click().catch(() => undefined)
  await page.waitForSelector('[data-app-tabs]', { timeout: 60_000 })
  await dismissAppOnboarding()
}

/** Allow or postpone the app-area's first-run capability card before clicking a tab. */
async function dismissAppOnboarding() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const allow = page.locator('[data-onboarding-action="allow-all"]')
    if ((await allow.count()) > 0) {
      await allow.first().click().catch(() => undefined)
      await page.waitForTimeout(500)
      continue
    }
    const later = page.locator('button').filter({ hasText: /^(稍后|Later)$/u })
    if ((await later.count()) > 0) {
      await later.first().click().catch(() => undefined)
      await page.waitForTimeout(300)
      continue
    }
    break
  }
}

describe('browser smoke', () => {
  it('renders the applications area with every deployed app', async () => {
    const nav = await page.$$eval('[data-app-tab]', nodes => nodes.map(node => node.getAttribute('data-app-tab')))
    for (const app of ['home', 'inbox', 'notes', 'todo', 'git-browser']) {
      assert.ok(nav.includes(app), `application tabs are missing ${app} (saw ${nav.join(', ')})`)
    }
  })

  it('creates and persists a note through the real storage path', async () => {
    await page.locator('[data-app-tab="notes"]').first().click()
    await page.waitForTimeout(500)
    await dismissAppOnboarding()
    await page.waitForSelector('[data-notes-page]', { timeout: 30_000 })
    assert.equal(await page.locator('[data-notes-page]').first().isVisible(), true)
    await page.locator('[data-notes-new]').first().click()
    await page.locator('[data-notes-source]').first().fill('# browser smoke note')
    await page.locator('[data-notes-save]').first().click()
    await page.waitForFunction(() => document.querySelectorAll('[data-notes-note]').length > 0, undefined, { timeout: 15_000 })
    assert.ok(await page.locator('[data-notes-note]').count() > 0)
  })

  it('opens the inbox application and shows its surface', async () => {
    await page.locator('[data-app-tab="inbox"]').first().click()
    await page.waitForTimeout(500)
    await dismissAppOnboarding()
    await page.waitForSelector('[data-inbox-page]', { timeout: 30_000 })
    assert.equal(await page.locator('[data-inbox-page]').first().isVisible(), true)
  })

  it('opens the todo application on its today view', async () => {
    await page.locator('[data-app-tab="todo"]').first().click()
    await page.waitForTimeout(500)
    await dismissAppOnboarding()
    await page.waitForSelector('[data-todo-page]', { timeout: 30_000 })
    await page.waitForSelector('[data-today-view]', { timeout: 30_000 })
    assert.equal(await page.locator('[data-today-view]').first().isVisible(), true)
  })

  it('opens the home dashboard and shows its cards', async () => {
    await page.locator('[data-app-tab="home"]').first().click()
    await page.waitForTimeout(500)
    await dismissAppOnboarding()
    await page.waitForSelector('[data-home-page]', { timeout: 30_000 })
    await page.waitForSelector('[data-home-card="inbox"]', { timeout: 30_000 })
    assert.equal(await page.locator('[data-home-page]').first().isVisible(), true)
    await page.waitForFunction(
      () => document.querySelector('[data-home-card="inbox"]')?.getAttribute('data-home-card-state') === 'ready',
      undefined,
      { timeout: 15_000 },
    )
  })

  it('opens the application dock entry and offers first-use setup', async () => {
    // The header entry is the only path into the application-area conversation.
    // A fresh isolated home has no remembered conversation, so the entry opens
    // the first-use setup dialog; cancelling returns to the page without
    // creating a Workspace or a Session.
    await page.locator('[data-sidebar-right-expand]').first().click()
    await page.waitForSelector('[data-app-conversation-setup]', { timeout: 30_000 })
    await page.locator('[data-app-conversation-setup-cancel]').first().click()
    await page.waitForSelector('[data-app-conversation-setup]', { state: 'detached', timeout: 15_000 })
  })

  it('keeps every header action at 32×32 with a 16×16 glyph', async () => {
    const sizes = await page.evaluate(() => {
      const read = (selector) => {
        const node = document.querySelector(selector)
        if (node === null) return null
        const box = node.getBoundingClientRect()
        const svg = node.querySelector('svg')?.getBoundingClientRect()
        return { width: box.width, height: box.height, iconWidth: svg?.width, iconHeight: svg?.height }
      }
      return {
        back: read('[data-app-back]'),
        all: read('[data-app-all]'),
        menu: read('[data-app-menu]'),
        expand: read('[data-sidebar-right-expand]'),
        tab: read('[data-app-tab]'),
      }
    })
    for (const action of [sizes.back, sizes.all, sizes.menu, sizes.expand]) {
      assert.equal(action.width, 32)
      assert.equal(action.height, 32)
      assert.equal(action.iconWidth, 16)
      assert.equal(action.iconHeight, 16)
    }
    assert.equal(sizes.tab.height, 28)
    assert.equal(sizes.tab.iconWidth, 16)
    assert.equal(sizes.tab.iconHeight, 16)
  })

  it('lists every application in the header panel and pins from the row', async () => {
    await page.locator('[data-app-all]').click()
    await page.waitForSelector('[data-app-apps-panel]', { timeout: 10_000 })
    assert.equal(await page.locator('[data-app-apps-row]').count(), 5)
    assert.equal(await page.locator('[data-app-pin-toggle]').count(), 5)
    const pin = page.locator('[data-app-pin-toggle="git-browser"]')
    assert.equal(await pin.getAttribute('aria-pressed'), 'true')
    await pin.click()
    await page.waitForTimeout(200)
    assert.equal(await page.locator('[data-app-apps-panel]').count(), 1)
    assert.equal(await page.locator('[data-app-pin-toggle="git-browser"]').getAttribute('aria-pressed'), 'false')
    assert.equal(await page.locator('[data-app-tab="git-browser"]').count(), 0)
    await page.locator('[data-app-pin-toggle="git-browser"]').click()
    await page.waitForTimeout(200)
    assert.equal(await page.locator('[data-app-tab="git-browser"]').count(), 1)
    await page.keyboard.press('Escape')
    await page.waitForTimeout(200)
    assert.equal(await page.locator('[data-app-apps-panel]').count(), 0)
    assert.equal(await page.evaluate(() => document.activeElement?.hasAttribute('data-app-all')), true)
  })

  it('keeps the management footer visible when the application list overflows', async () => {
    await page.setViewportSize({ width: 1440, height: 260 })
    await page.locator('[data-app-all]').click()
    await page.waitForSelector('[data-app-apps-panel]', { timeout: 10_000 })
    const panel = await page.locator('[data-app-apps-panel]').boundingBox()
    const footer = await page.locator('[data-app-manage-list]').boundingBox()
    assert.ok(panel !== null && footer !== null)
    assert.ok(footer.y + footer.height <= panel.y + panel.height + 1, 'the management footer stays inside the panel')
    const list = await page.evaluate(() => {
      const element = document.querySelector('[data-app-apps-panel] ul')
      return element === null ? undefined : { scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }
    })
    assert.ok(list !== undefined && list.scrollHeight > list.clientHeight, 'only the application list scrolls')
    await page.keyboard.press('Escape')
    await page.setViewportSize({ width: 1440, height: 900 })
  })

  it('reorders the tab strip by dragging a whole tab', async () => {
    const before = await page.$$eval('[data-app-tab]', nodes => nodes.map(node => node.getAttribute('data-app-tab')))
    const first = page.locator('[data-app-tab]').first()
    const last = page.locator('[data-app-tab]').last()
    const lastBox = await last.boundingBox()
    assert.ok(lastBox !== null)
    await first.dragTo(last, { targetPosition: { x: lastBox.width - 2, y: lastBox.height / 2 } })
    await page.waitForTimeout(400)
    const after = await page.$$eval('[data-app-tab]', nodes => nodes.map(node => node.getAttribute('data-app-tab')))
    assert.equal(after.length, before.length)
    assert.deepEqual([...after].sort(), [...before].sort())
    assert.notEqual(after[0], before[0])
  })

  it('keeps the dock seam on one pixel column and restores the expand icon', async () => {
    // The dock only sits beside the page above a 1040px AREA width; the default
    // 1280px page leaves 1000px for the area, which is the narrow overlay mode.
    await page.setViewportSize({ width: 1440, height: 900 })
    // Seed the dock preference, reload, and re-enter the area: the panel needs
    // a real 420px dock, and a fresh area has no Conversation to set one up.
    await page.evaluate(() => {
      const key = 'dsh.applications.preferences.v1'
      const raw = localStorage.getItem(key)
      const value = raw === null ? { navOrder: [] } : JSON.parse(raw)
      localStorage.setItem(key, JSON.stringify({ ...value, lastAppId: 'home', dockExpanded: true, dockWidth: 420 }))
    })
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => undefined)
    await openApplications()
    await page.waitForSelector('[data-app-dock-strip]', { timeout: 30_000 })
    await page.waitForTimeout(400)
    const seam = await page.evaluate(() => {
      const strip = document.querySelector('[data-app-dock-strip]').getBoundingClientRect()
      const body = document.querySelector('[data-app-dock-body]').getBoundingClientRect()
      const header = document.querySelector('[data-app-header]').getBoundingClientRect()
      return { stripLeft: strip.left, bodyLeft: body.left, stripBottom: strip.bottom, headerBottom: header.bottom }
    })
    assert.equal(seam.stripLeft, seam.bodyLeft)
    assert.equal(seam.stripBottom, seam.headerBottom)
    await page.locator('[data-app-dock-collapse]').click()
    await page.waitForTimeout(500)
    const expand = await page.evaluate(() => {
      const node = document.querySelector('[data-sidebar-right-expand]')
      const box = node.getBoundingClientRect()
      const svg = node.querySelector('svg').getBoundingClientRect()
      return { width: box.width, height: box.height, iconWidth: svg.width, iconHeight: svg.height }
    })
    assert.deepEqual(expand, { width: 32, height: 32, iconWidth: 16, iconHeight: 16 })
  })

  it('reported no page errors or console errors', () => {
    assert.deepEqual(failures, [])
  })
})
