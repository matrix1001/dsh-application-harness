#!/usr/bin/env node
/**
 * The page-bootstrap skeleton every browser lane drives: open a surface (a
 * context + page at one viewport/scheme/locale, with the platform's first-run
 * dialog dismissed), re-establish it after a reload, wait for the layout to
 * settle, and open the applications panel and one application's page inside it.
 *
 * **The panel contract (P9).** An application is reached through the
 * applications panel, not through the old sidebar rows: the sidebar's rail
 * entry (`aria-label` = the panel's own dictionary word, `应用` / `Applications`)
 * selects the keyed `main` panel, the panel lists the host's applications as
 * rows (`[data-app-nav]`, `aria-current` on the selected one), and
 * selecting a row mounts that application's registered view (or its generic
 * call form) in the page pane beside the list. The selectors here are the
 * panel's own facts — element type, role-bearing attributes (`aria-current`,
 * `aria-selected`, `data-status`) and the accessibility name — never a hashed
 * CSS-module class, so a restyle cannot silently turn a lane green.
 *
 * **The entry is a panel selector.** The applications package registers the
 * rail row and the keyed `main` panel through the platform sidebar's additive
 * `sidebar.panellist` slot; the platform row selects the panel. The area then
 * opens its own navigation (`[data-app-nav-root][data-nav-state]` =
 * `expanded | collapsed | drawer`; a narrow closed drawer is not in the DOM at
 * all). {@link openPanel} — the helper every opener is built on — opens the
 * rows through the control that owns the folded state rather than assuming the
 * rail click already expanded them.
 *
 * Why it is its own module: the lanes had written these steps by hand and the
 * copies had already drifted. The first-run dismissal existed eight times (one
 * per reload site), three of them knowing only the Chinese label — which is the
 * exact failure a C/POSIX environment causes: the
 * ENGLISH dialog, a `hasText: '继续'` wait never sees it, and every later
 * assertion runs against a modal backdrop.
 *
 * Why it is separate from the script plane: argument parsing, profile seeding,
 * readiness scanning and redaction stay pure and import no browser; driving a
 * page is a different contract and lives here instead.
 *
 * Nothing here launches a browser at import time: every export takes the
 * caller's own `browser`/`page`.
 */

/**
 * The continue labels the platform's first-run dialog can carry, in the order
 * they are tried. Which one exists depends on the language the client resolved,
 * and the client resolves it from the context locale — which is why a lane that
 * sets no explicit locale (a C/POSIX environment) sees the ENGLISH dialog.
 */
export const FIRST_RUN_LABELS = ['继续', 'Continue', 'Got it', '开始使用']

/** The waits one panel open uses (the reconciled, more patient values). */
export const APP_OPEN_TIMEOUTS = {
  /** How long the rail entry may take to show up. */
  railVisible: 5000,
  /** How long the application rows may take after the panel is selected. */
  rowsReady: 30_000,
  /** How long the selected application's page may take after its row is clicked. */
  open: 30_000,
  /** The rail's expand animation, before the panel's list is reachable. */
  railPause: 300,
  /** The post-mount settle, before a geometry or style read measures the page. */
  settlePause: 600,
  /**
   * How long the fold control (the column's own toggle, or the header's
   * unfold/drawer button) may take to show up after an entry activation left
   * the navigation folded. Short: the control belongs to the same area the
   * click just rendered, so a wait this long that finds nothing means the
   * navigation is NOT folded — the row wait below owns that case.
   */
  foldPause: 2000,
}

/**
 * The panel's row/rail labels, per locale. The lanes run `zh-CN` by default
 * and the panel's dictionary is the source of these two words
 * (`packages/client/applications/src/client/locales.ts`); a lane that pins a
 * different locale names it here.
 *
 * `allow` is the one entry no control carries any more: a declared need is a
 * platform Switch now (its accessible name is the row's own `needs.toggle`
 * copy, `允许或撤销“…”`), and the per-need 允许/撤销 buttons it used to label
 * are gone. The word is kept as the panel's dictionary still holds it — a lane
 * matching approval TEXT would be matching a string nobody renders.
 */
export const PANEL_LABELS = {
  'zh-CN': {
    rail: '应用', manage: '应用管理', menu: '当前应用管理', back: '返回对话',
    permissions: '权限管理', settings: '应用设置', history: '操作历史', info: '应用信息',
    allow: '允许',
  },
  en: {
    rail: 'Applications', manage: 'Manage applications', menu: 'Manage this application', back: 'Back to the conversation',
    permissions: 'Permissions', settings: 'Settings', history: 'History', info: 'About',
    allow: 'Allow',
  },
}

/**
 * The panel's DOM anchors, as one vocabulary the lanes share. Every entry is a
 * structural or role fact of the area (the navigation's rows, the business
 * frame, the management dialog), never a CSS-module class:
 *
 * - `rows` — the application rows (one button per host application, carrying
 *   the lifecycle status in `data-status`);
 * - `currentRows` — the selected row (`aria-current`);
 * - `area` — the whole applications area (its presence IS "the panel is the
 *   selected one"; the platform unmounts the keyed panel with the selection);
 * - `navRoot` / `navState` — the application navigation and the state it
 *   reports in `data-nav-state` (`expanded | collapsed | drawer`);
 * - `drawerOpen` — the one control that re-opens a folded navigation (the
 *   narrow drawer's opener; while a WIDE column is folded, the header's own
 *   unfold button, which carries the same attribute);
 * - `frame` / `page` — the business frame (`data-app-id` names the rendered
 *   application) and its surface;
 * - `appMenu` — the current application's own menu (settings, permissions,
 *   history, info, back to the conversation);
 * - `dialog` / `dialogRows` / `dialogBody` — the management dialog, its list
 *   and its body (settings/permissions/history/info tabs);
 * - `settingsBody` / `settingsForm` / `settingsSaved` — the management
 *   dialog's 设置 tab and the application's own settings form rendered inside
 *   it (the form and its fields belong to the application — an info-hub field
 *   is `[data-info-field]` — so the helpers below compose the two);
 * - `needs` — one declared capability row inside the permissions tab;
 * - `needSwitch` / `needOff` — that row's platform Switch, and the unchecked
 *   ones (approval is a switch, not an allow/revoke button pair);
 * - `outcome` — the last settled call outcome. It is NOT a fact of the
 *   business surface any more (that line was removed with the rework): the one
 *   surface that still renders a settled outcome verbatim is the explicit
 *   debug form (management dialog → 信息 → 调试调用), so the selector names
 *   that form's own result, which is the new owner of the same promise.
 */
export const PANEL_SELECTORS = {
  // The application navigation: one row per application that draws a page
  // (`data-app-nav`), the selected one marked with `aria-current="page"`, and
  // every row carrying its lifecycle status in `data-status`.
  rows: '[data-app-nav]',
  currentRows: '[data-app-nav][aria-current="page"]',
  navManage: '[data-app-manage]',
  navToggle: '[data-app-nav-toggle]',
  // The area and its navigation's own state report.
  area: '[data-applications-area]',
  navRoot: '[data-app-nav-root]',
  drawerOpen: '[data-app-drawer-open]',
  // The business frame: `data-app-id` names the application being shown (the
  // header's own statement of what it rendered), `data-status` its lifecycle.
  frame: '[data-app-frame]',
  page: '[data-app-surface]',
  // The current application's own menu (settings/permissions/history/info/back).
  appMenu: '[data-app-menu]',
  cite: '[data-app-cite]',
  // The management dialog: the list, one application's detail, its tabs.
  dialog: '[data-manage-dialog]',
  dialogRows: '[data-manage-row]',
  dialogBack: '[data-manage-back]',
  dialogClose: '[data-manage-close]',
  dialogBody: '[data-manage-body]',
  // The settings the dialog hosts: the framework's own body, and the
  // application's form inside it.
  settingsBody: '[data-manage-settings]',
  settingsForm: '[data-manage-settings] [data-info-settings]',
  settingsSaved: '[data-info-saved]',
  // One declared need and its switch (the write in flight disables it).
  needs: '[data-app-need]',
  needSwitch: '[data-app-need] [role="switch"]',
  needOff: '[data-app-need] [role="switch"][aria-checked="false"]',
  // The settled call outcome, where it still lives: the debug form
  // (`[data-call-result]`) — `data-status` carries the CALL status there,
  // never a lifecycle one (the frame and the rows carry the lifecycle).
  outcome: [
    '[data-call-result] [data-status="ok"]',
    '[data-call-result] [data-status="rejected"]',
    '[data-call-result] [data-status="failed"]',
    '[data-call-result] [data-status="cancelled"]',
  ].join(', '),
}

/** The tab anchor of one management-dialog tab. */
export function manageTab(key) {
  return `[data-manage-tab="${key}"]`
}

/**
 * The anchor of one field in the settings form the management dialog hosts
 * (the application's own form, inside `[data-manage-settings]`): the framework
 * owns the tab, the application owns the field, and a lane that reads one
 * needs both halves in the same selector.
 */
export function manageField(key) {
  return `${PANEL_SELECTORS.settingsBody} [data-info-field="${key}"]`
}

/** The anchor of one action in that settings form (e.g. `settings-save`). */
export function manageAction(key) {
  return `${PANEL_SELECTORS.settingsBody} [data-info-action="${key}"]`
}

/** The panel labels for one locale, falling back to the default copy. */
export function panelLabels(locale = 'zh-CN') {
  const key = locale.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
  return PANEL_LABELS[key]
}

/**
 * The sidebar's applications entry (the rail row), as a locator. Matched by
 * accessible name — the panel's own dictionary word — in both sidebar states,
 * because the rail keeps its rows when the column folds.
 * @param page - the open page.
 * @param locale - the locale whose label to match.
 * @returns the rail row's locator.
 */
export function railEntry(page, locale = 'zh-CN') {
  return page.locator(`button[aria-label="${panelLabels(locale).rail}"]`).first()
}

/**
 * The navigation's own state, as the area reports it. `undefined` covers both
 * "no navigation in the DOM" (a narrow closed drawer) and "the panel is not
 * selected at all", which the caller distinguishes by {@link PANEL_SELECTORS}
 * `.area` — the two are different facts.
 * @param page - the open page.
 * @returns `expanded | collapsed | drawer`, or undefined.
 */
export async function navStateOf(page) {
  return await page.evaluate((selector) => document.querySelector(selector)?.getAttribute('data-nav-state') ?? undefined, PANEL_SELECTORS.navRoot)
}

/**
 * ACTIVATE the applications entry exactly once — one click on the rail row,
 * nothing else. That is a raw toggle (see the module header): a lane asserting
 * the entry's own contract must see what the one activation did, so this
 * helper deliberately does NOT re-open the navigation afterwards.
 * @param page - the open page.
 * @param options - the locale whose label to match, and the settle pause after the click.
 * @returns whether the rail row was reachable, and the navigation state after the click.
 */
/**
 * Postpone the first-run permission prompt when it is on screen. The prompt is
 * a modal now: on a fresh profile it owns the mask over the whole surface, so a
 * lane that clicks the sidebar or the page header must answer it first. The
 * answer is recorded per capability set, so a later revocation shows it again.
 * @param page - the open page.
 * @param options - how long to wait for the prompt to appear.
 * @returns whether a prompt was answered.
 */
export async function postponeOnboarding(page, { timeout = 500 } = {}) {
  const later = page.locator('[data-onboarding-action="later"]').first()
  if (!await later.isVisible({ timeout }).catch(() => false)) return false
  // The footer button is the primary answer; the header's X is the same answer
  // and stays reachable if the body scrolled the footer out of view.
  await later.click({ force: true }).catch(async () => {
    await page.locator('[role="dialog"] button[aria-label]').first().click({ force: true }).catch(() => {})
  })
  await page.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 5000 }).catch(async () => {
    await page.keyboard.press('Escape')
    await page.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 3000 }).catch(() => {})
  })
  return true
}

export async function activateEntry(page, { locale = 'zh-CN', pause = 400, timeouts = APP_OPEN_TIMEOUTS, dismissOnboarding = true } = {}) {
  if (dismissOnboarding) await postponeOnboarding(page)
  const rail = railEntry(page, locale)
  const reachable = await rail.isVisible({ timeout: timeouts.railVisible }).catch(() => false)
  if (!reachable) return { activated: false, navState: undefined }
  try {
    await rail.click({ timeout: 5000 })
  } catch (cause) {
    const dialogs = await page.locator('[role="dialog"]').allTextContents().catch(() => [])
    console.error('[lane] rail click blocked; dismiss=', dismissOnboarding, 'dialogs:', JSON.stringify(dialogs.map(text => text.slice(0, 160))))
    throw cause
  }
  await page.waitForTimeout(pause)
  // Selecting the panel can adopt its own default application, whose first-run
  // prompt opens a modal over the rows: postpone it before the caller clicks one
  // when the caller is not the lane that tests that prompt.
  if (dismissOnboarding) await postponeOnboarding(page, { timeout: 2500 })
  return { activated: true, navState: await navStateOf(page) }
}

/**
 * Dismiss the platform's first-run dialog when it is there. Matched per
 * language rather than by text alone, and awaited: a slow first paint must not
 * be mistaken for "no dialog".
 * @param page - the open page.
 * @param options - the per-label wait, the post-click pause, and whether the click is awaited.
 * @returns the label that was clicked, or `undefined` when no dialog appeared.
 */
export async function dismissFirstRun(page, { timeout = 1200, pause = 0 } = {}) {
  for (const label of FIRST_RUN_LABELS) {
    const button = page.locator('button', { hasText: label }).first()
    if (await button.isVisible({ timeout }).catch(() => false)) {
      await button.click()
      if (pause > 0) await page.waitForTimeout(pause)
      return label
    }
  }
  return undefined
}

/**
 * Wait until the page's layout has settled before anything is measured: the
 * font set is loaded (a late webfont changes every text box), the document is
 * past its first paint, and two consecutive animation frames report the same
 * body size — the sidebar's expand/collapse animation is the one transition
 * that moves the whole content column.
 * @param page - the open page.
 */
export async function waitLayoutSettled(page) {
  await page.evaluate(() => document.fonts.ready)
  await page.evaluate(async () => {
    const sample = () => {
      const body = document.body
      return `${String(body.clientWidth)}x${String(body.clientHeight)}`
    }
    let previous = sample()
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await new Promise((settle) => { requestAnimationFrame(() => { requestAnimationFrame(settle) }) })
      const current = sample()
      if (current === previous) return
      previous = current
    }
  })
}

/**
 * Reload the page and put it back in its post-first-run state: a reload renders
 * the platform's first-run dialog again, so a lane that only reloads leaves
 * every later click behind a modal backdrop.
 *
 * The panel selection does NOT survive a reload (the layout store is in-memory
 * by design, so a fresh page opens on the conversation). A lane whose next step
 * is inside the panel passes `panel: true` and the panel is selected again here
 * — re-deriving it silently in each lane is exactly the drift this module
 * exists to prevent.
 * @param page - the open page.
 * @param options - the hydration pause, the per-label dismissal wait, and whether to re-select the panel.
 */
export async function reloadSurface(page, { pause = 2000, firstRunTimeout = 1200, panel = false, locale = 'zh-CN' } = {}) {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(pause)
  await dismissFirstRun(page, { timeout: firstRunTimeout })
  if (panel) await openPanel(page, { locale })
}

/**
 * Catch a TRANSIENT state's box without sleeping on it: poll the page (each
 * poll is one immediate read, no `waitForTimeout`) until the marker is on
 * screen, recording the frame box at that same instant. Returns `{caught:false}`
 * when the state never got observed — the caller reports UNVERIFIED rather than
 * a pass, because "I never saw the loading state" is not "the loading state
 * holds the frame".
 * @param page - the browser page.
 * @param marker - the transient state's selector.
 * @param frame - the frame whose box must hold still.
 * @param attempts - how many immediate reads to try (each is one round trip, no pause).
 * @returns the caught box, or `{caught: false}` with the reason.
 */
async function catchTransient(page, marker, frame, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const sample = await page.evaluate(({ markerSel, frameSel }) => {
      const element = document.querySelector(frameSel)
      if (element === null) return null
      const rect = element.getBoundingClientRect()
      return {
        loading: document.querySelector(markerSel) !== null,
        box: { width: Math.round(rect.width), height: Math.round(rect.height), x: Math.round(rect.x), y: Math.round(rect.y) },
      }
    }, { markerSel: marker, frameSel: frame })
    if (sample !== null && sample.loading) return { caught: true, box: sample.box }
  }
  return { caught: false, reason: `${marker} was never on screen while polling (${frame} may not have mounted)` }
}

/**
 * Select the applications panel AND make its rows reachable: click the sidebar
 * rail entry whose accessibility name is the panel's own label. The rail is
 * present in both sidebar states (a narrow window collapses the column but
 * keeps the rail), so one call works at every viewport.
 *
 * The entry toggles (module header): when the panel is already selected the
 * click may have FOLDED the navigation instead of showing it, and when the
 * area is narrow it may have closed the drawer. The rows are what this helper
 * promises, so a folded navigation is re-opened through the control that owns
 * it — the column's unfold button or the drawer opener, both
 * `[data-app-drawer-open]`, both rendered by the header exactly while the
 * navigation is folded away.
 * @param page - the open page.
 * @param options - the locale whose label to match, the waits, and the unreachable handler.
 * @returns whether the panel's application rows became reachable.
 */
export async function openPanel(page, { locale = 'zh-CN', timeouts = APP_OPEN_TIMEOUTS, onUnreachable, dismissOnboarding = true } = {}) {
  // The rows are already on screen when the layout restored the panel: clicking
  // the rail would only fold it (and a first-run prompt may be opening over it).
  const rowsNow = page.locator(PANEL_SELECTORS.rows)
  if (await rowsNow.first().isVisible().catch(() => false)) {
    if (dismissOnboarding) await postponeOnboarding(page, { timeout: 6000 })
    return true
  }
  // A first-run prompt is a modal over the rail: answer it before the click
  // only when the caller does not want to observe the prompt itself.
  if (dismissOnboarding) await postponeOnboarding(page)
  const rail = railEntry(page, locale)
  if (!await rail.isVisible({ timeout: timeouts.railVisible }).catch(() => false)) {
    if (onUnreachable === undefined) throw new Error('the applications rail entry is not reachable')
    onUnreachable()
    return false
  }
  try {
    await rail.click({ timeout: 5000 })
  } catch (cause) {
    const dialogs = await page.locator('[role="dialog"]').allTextContents().catch(() => [])
    console.error('[lane] rail click blocked; dismiss=', dismissOnboarding, 'dialogs:', JSON.stringify(dialogs.map(text => text.slice(0, 160))))
    // The prompt may have finished opening between the pre-check and the click.
    if (dismissOnboarding) {
      await postponeOnboarding(page, { timeout: 2000 })
      await rail.click()
    } else {
      throw cause
    }
  }
  await page.waitForTimeout(timeouts.railPause)
  const rows = page.locator(PANEL_SELECTORS.rows)
  let ready = await rowsReachable(page, rows, timeouts)
  if (ready) {
    // A fresh surface can discard the first panel activation while its
    // conversation onboarding/layout settles (observed with en-US). A short
    // stability window turns "the rows appeared once" into "the panel stayed".
    await page.waitForTimeout(500)
    ready = await rows.first().isVisible().catch(() => false)
  }
  if (!ready) {
    if (onUnreachable === undefined) throw new Error('the applications panel listed no applications')
    onUnreachable()
    return false
  }
  return true
}

/**
 * Whether the rows are already on screen, or can be made so by the control
 * that owns the folded navigation. The waits are split deliberately, one per
 * state the entry activation can leave behind:
 *
 * - rows on screen right now → done (the panel was just opened, or the click
 *   unfolded the column);
 * - the navigation reported `collapsed` (or is not in the DOM, which is a
 *   closed narrow drawer) → its OWN control is clicked. That control is
 *   present immediately in those two states — it is what the states render —
 *   so the short {@link APP_OPEN_TIMEOUTS.foldPause} is the right wait, and a
 *   miss means the state has moved on;
 * - neither → the panel is mounted and the rows are still being read from the
 *   host: only that case may spend the full row wait.
 * @param page - the open page.
 * @param rows - the row locator to wait for.
 * @param timeouts - the waits the open uses.
 * @returns whether the rows became reachable.
 */
async function rowsReachable(page, rows, timeouts) {
  // An immediate read: `isVisible` polls nothing, so a not-yet-rendered row
  // cannot burn this branch's time budget.
  if (await rows.first().isVisible().catch(() => false)) return true
  const state = await navStateOf(page)
  if (state === undefined || state === 'collapsed') {
    const opener = page.locator(PANEL_SELECTORS.drawerOpen).first()
    if (await opener.isVisible({ timeout: timeouts.foldPause }).catch(() => false)) {
      await opener.click()
      await page.waitForTimeout(timeouts.railPause)
    }
  }
  return await rows.first().waitFor({ timeout: timeouts.rowsReady }).then(() => true).catch(() => false)
}

/**
 * Open one application's 权限 tab in the management dialog, and leave the
 * dialog open on it. The caller owns the closing (and whatever it wants to
 * read while the tab is up) — {@link approveNeeds} and a lane's own leftover
 * check both need exactly this state.
 * @param page - a page on which the applications rail is reachable.
 * @param appId - the application to manage.
 * @param options - the panel's locale and the row's display name, when it differs.
 * @returns whether the permissions tab became reachable.
 */
export async function openPermissions(page, appId, { name, locale = 'zh-CN' } = {}) {
  const labels = panelLabels(locale)
  await openApp(page, appId, { ...(name === undefined ? {} : { name }), locale, dismissOnboarding: true })
  // Selecting an application with unmet platform capabilities opens the
  // first-run prompt as a modal: it must be postponed before the header menu
  // underneath can be reached. The lane that tests the prompt itself acts on
  // the prompt directly, not through this helper.
  await postponeOnboarding(page, { timeout: 2500 })
  if (!await openAppMenu(page, locale)) return false
  await page.locator('[role="menuitem"]', { hasText: labels.permissions }).first().click()
  await page.locator(PANEL_SELECTORS.dialog).first().waitFor({ timeout: 10_000 })
  await page.locator(manageTab('permissions')).first().click()
  await page.waitForTimeout(400)
  return true
}

/**
 * Approve EVERY need the panel lists for one application — the user's own
 * action, taken through the panel's own 权限 tab. Nothing seeds a grant file:
 * the applications use the platform capabilities they declare (the model, the
 * network, subprocesses, the store), and a lane that wants those reads to work
 * has to give the approval the way a person does. Approvals are host state, so
 * one surface's clicks cover every later surface and the restart readback.
 *
 * A need is a platform Switch now (there is no 允许 button): the write goes to
 * the host and the row then follows the host's READ-BACK state. So this loop is
 * bounded on the LIST, not on a click count — after each activation the
 * unchecked switches are re-read, a switch whose own write is in flight
 * (disabled) is waited out instead of re-clicked, and only a switch that really
 * turned checked is counted. It ends when no unchecked switch remains, which is
 * also the honest failure signal: a write the host refused leaves its switch
 * unchecked and the caller sees a count that stopped growing.
 * @param page - a page on which the applications rail is reachable.
 * @param appId - the application whose needs to approve.
 * @param options - the panel's locale and the row's display name, when it differs.
 * @returns how many needs were approved (a switch that never turned checked is not counted).
 */
export async function approveNeeds(page, appId, { name, locale = 'zh-CN' } = {}) {
  // The first-run permission prompt is a modal on a fresh profile: it owns the
  // mask, so the approval pass postpones it before touching the header. The
  // record is per capability set, so a later revocation shows the prompt again.
  await postponeOnboarding(page)
  if (!await openPermissions(page, appId, { ...(name === undefined ? {} : { name }), locale })) return 0
  // One read of the whole tab, per poll: the row re-renders as its write
  // settles, so a locator that matched "the unchecked switch" stops matching
  // the moment it is checked — and every further call on it would sit out a
  // full locator timeout waiting for an element that is gone on purpose.
  const readNeeds = async () => await page.evaluate((rowSelector) => Array.from(document.querySelectorAll(rowSelector)).map(row => ({
    need: row.getAttribute('data-app-need'),
    checked: row.querySelector('[role="switch"]')?.getAttribute('aria-checked') === 'true',
    disabled: row.querySelector('[role="switch"]')?.hasAttribute('disabled') === true,
  })), PANEL_SELECTORS.needs)
  let approved = 0
  for (let attempt = 0; attempt < 24 && approved < 24; attempt += 1) {
    const next = (await readNeeds()).find(entry => !entry.checked)
    if (next === undefined) break
    // The row disables its own switch while the write is in flight; clicking a
    // disabled control is swallowed, and counting it would report an approval
    // that never happened.
    if (next.disabled) {
      await page.waitForTimeout(250)
      continue
    }
    await page.locator(`[data-app-need=${JSON.stringify(next.need)}] [role="switch"]`).click()
    let turned = false
    for (let wait = 0; wait < 24 && !turned; wait += 1) {
      turned = (await readNeeds()).find(entry => entry.need === next.need)?.checked === true
      if (!turned) await page.waitForTimeout(150)
    }
    if (!turned) break
    approved += 1
  }
  await closeManagement(page)
  return approved
}

/**
 * Open the CURRENT application's menu in the area header (the ⋯ control).
 * @param page - a page whose application area is open.
 * @param locale - the locale whose labels to match.
 * @returns whether the menu opened.
 */
export async function openAppMenu(page, locale = 'zh-CN') {
  const trigger = page.locator(PANEL_SELECTORS.appMenu).first()
  if (!await trigger.isVisible({ timeout: 5000 }).catch(() => false)) return false
  await trigger.click()
  await page.locator('[role="menuitem"]').first().waitFor({ timeout: 5000 }).catch(() => {})
  return true
}

/**
 * Close the management dialog (its own close control; Escape as the fallback).
 * @param page - a page with the dialog open.
 */
export async function closeManagement(page) {
  const close = page.locator(PANEL_SELECTORS.dialogClose).first()
  if (await close.isVisible({ timeout: 2000 }).catch(() => false)) {
    await close.click()
  } else {
    await page.keyboard.press('Escape')
  }
  await page.locator(PANEL_SELECTORS.dialog).first().waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
  await page.waitForTimeout(200)
}

/**
 * Leave the application area (the header menu's own 返回对话): the center column
 * returns to the conversation. The area itself stays selected, so the next
 * {@link openApp} only has to click a row.
 * @param page - the open page.
 * @param options - the locale whose label to match and the settle pause.
 */
export async function closeAppPage(page, { locale = 'zh-CN', pause = 300 } = {}) {
  if (!await openAppMenu(page, locale)) return
  const item = page.locator('[role="menuitem"]', { hasText: panelLabels(locale).back }).first()
  if (await item.isVisible({ timeout: 2000 }).catch(() => false)) {
    await item.click()
    await page.waitForTimeout(pause)
  }
}

/**
 * The index of the row whose application name is exactly `name`, or -1. Exact
 * matching is deliberate: the fixture set carries `ui-fixtures` and
 * `ui-fixtures-twin`, and a substring match would open the wrong one.
 *
 * The name is read from the row's NAME span, never from `row.textContent` (the
 * row appends its lifecycle status and an in-flight badge, so a text read would
 * stop matching for a non-available application) and never from the row's first
 * `span` (which is the GLYPH, an empty `[data-app-icon]` span — a read that
 * matched nothing and silently sent every named open down the click-and-confirm
 * walk below).
 * @param page - the open page.
 * @param name - the row's application name (the view's registered name, else the host's).
 * @returns the row index.
 */
async function rowIndexByName(page, name) {
  return await page.evaluate(({ selector, wanted }) => {
    const rows = [...document.querySelectorAll(selector)]
    return rows.findIndex((row) => {
      const span = row.querySelector('span:not([data-app-icon])')
      return (span?.textContent ?? row.textContent ?? '').trim() === wanted
    })
  }, { selector: PANEL_SELECTORS.rows, wanted: name })
}

/**
 * Open one application's page in the panel.
 *
 * The panel is selected first (the rail entry), then the application's row is
 * clicked. A `name` resolves the row directly (exact match); without one the
 * rows are walked and the selection is confirmed against the page header's own
 * application id — the panel shows the id, so no name table can drift out of
 * date behind a lane's back.
 * @param page - the open page.
 * @param appId - the application id the page header must report.
 * @param options - the row name when known, the locale, the transient-state probe and the unreachable handler.
 * @returns whether the application became reachable, and the transient box when one was asked for.
 */
export async function openApp(page, appId, { name, locale = 'zh-CN', catchLoading, onUnreachable, skipPanel = false, timeouts = APP_OPEN_TIMEOUTS, dismissOnboarding = true } = {}) {
  if (!skipPanel) {
    const opened = await openPanel(page, { locale, timeouts, dismissOnboarding, ...(onUnreachable === undefined ? {} : { onUnreachable }) })
    if (!opened) return { ready: false, loadingBox: undefined }
  }
  // The prompt can open while the panel/rows settle: answer it immediately
  // before the row walk, where a modal would swallow the row click.
  if (dismissOnboarding) await postponeOnboarding(page, { timeout: 2500 })
  const rows = page.locator(PANEL_SELECTORS.rows)
  const frame = page.locator(PANEL_SELECTORS.frame).first()
  // Resolution clicks the row it settles on (the walk confirms each candidate
  // against the header), so nothing below clicks a second time. The surface can
  // discard the first panel activation while the conversation onboarding/layout
  // settles (observed with an English-locale fresh surface), so a miss re-opens
  // the panel once and resolves again before it is reported as unreachable.
  let target = -1
  for (let attempt = 0; attempt < 2 && target < 0; attempt += 1) {
    if (attempt > 0) {
      const reopened = await openPanel(page, { locale, timeouts, ...(onUnreachable === undefined ? {} : { onUnreachable }) })
      if (!reopened) break
      await page.waitForTimeout(250)
    }
    if (name !== undefined) {
      target = await rowIndexByName(page, name)
      if (target >= 0) {
        // A click can lose the row to a re-render; a miss retries the whole
        // resolution instead of reporting an app that is visibly listed.
        const clicked = await rows.nth(target).click().then(() => true).catch(() => false)
        if (clicked) break
        target = -1
      }
    }
    const count = await rows.count()
    let unreachable = false
    for (let index = 0; index < count; index += 1) {
      // The walk clicks candidate after candidate, and a NARROW drawer closes
      // itself on every selection — so the next candidate is behind the opener
      // and a click on it would only sit out its timeout. Re-open the
      // navigation first (a no-op while the rows are already on screen).
      if (index > 0 && !await rowsReachable(page, rows, timeouts)) { unreachable = true; break }
      await rows.nth(index).click().catch(() => {})
      await page.waitForTimeout(120)
      const current = await frame.getAttribute('data-app-id', { timeout: 2000 }).catch(() => undefined)
      if (current === appId) { target = index; break }
    }
    if (unreachable) continue
    if (target < 0 && attempt === 0) await page.waitForTimeout(300)
  }
  if (target < 0) {
    // The caller owns the report: the lanes record a named precondition check
    // here, a caller that passes no handler gets the throw. Either way there is
    // no row to click, so the open stops here (`ready: false`) rather than
    // turning into an anonymous click timeout in the caller's face.
    if (onUnreachable === undefined) throw new Error(`no application row opens ${appId}`)
    onUnreachable()
    return { ready: false, loadingBox: undefined }
  }
  // A TRANSIENT state (e.g. a view's loading marker) is only observable in the
  // window right after the row is clicked — catching it is why this hook sits
  // at the click site instead of after the settled waits below. Nothing pauses:
  // the poll reads immediately and gives up with an honest "never seen".
  const loadingBox = catchLoading === undefined ? undefined : await catchTransient(page, catchLoading.marker, catchLoading.frame)
  // The frame's own `data-app-id` is the area's statement of which application
  // it rendered: waiting for it is what makes "the row was clicked" a different
  // fact from "this application's page is up".
  await frame.waitFor({ timeout: timeouts.open })
  const shown = await frame.getAttribute('data-app-id')
  if (shown !== appId) {
    if (onUnreachable === undefined) throw new Error(`the panel shows ${String(shown)}, not ${appId}`)
    onUnreachable()
    return { ready: false, loadingBox }
  }
  await page.waitForTimeout(timeouts.settlePause)
  return { ready: true, loadingBox }
}

/**
 * Bind the bootstrap to one lane's browser, instance URL and error sinks — the
 * openers read the same wiring at every call site instead of each lane
 * re-deriving it.
 * @param config - the browser, the instance URL, the default locale, the sinks and the bootstrap defaults.
 * @returns the bound `openSurface` and `openApp`.
 */
export function createPageBootstrap({
  browser,
  url,
  locale = 'zh-CN',
  onPageError = () => {},
  onConsoleError = () => {},
  onConsoleWarning = () => {},
  onContext = () => {},
  cookie = undefined,
  pause = 1500,
  settle = false,
  firstRunTimeout = 1200,
  firstRunPause = 0,
} = {}) {
  /**
   * Open a fresh context at one viewport/scheme/locale and get the page up: the
   * context's options, the error sinks, the load, the first-run dismissal and
   * (when asked) the layout settle. The sidebar opens COMPACT (this project's
   * own first-visit default) and keeps its rail at phone widths, so the
   * applications entry is a rail row either way ({@link openPanel} re-opens the
   * folded navigation when one activation folded it).
   *
   * Warnings get their own sink because a replaced deployment speaks through
   * them: a duplicate slot declaration, a patch directive the platform refused
   * to apply, an inactive row — all of them are warning-level, and a lane that
   * only collected `error` would call the broken deployment green.
   * @param options - the viewport, the colour scheme, the locale override, the device scale and the cookie override.
   * @returns the context and its page.
   */
  async function openSurface({ width, height, colorScheme = 'light', name, locale: surfaceLocale = locale, deviceScaleFactor, cookie: surfaceCookie = cookie, dismissOnboarding = true, expandNavigation = false }) {
    const context = await browser.newContext({
      viewport: { width, height },
      ...(deviceScaleFactor === undefined ? {} : { deviceScaleFactor }),
      colorScheme,
      // A fixed locale + timezone so the local-time assertions are deterministic
      // (the review's own screenshots were taken in Asia/Shanghai). The locale
      // is also what decides which first-run dialog the client renders.
      locale: surfaceLocale,
      timezoneId: process.env.DSH_E2E_TIMEZONE ?? 'Asia/Shanghai',
    })
    // The caller's bookkeeping (closing contexts on exit, attributing errors to
    // a named surface) stays on its side of the seam.
    onContext(context, name)
    if (surfaceCookie !== undefined) {
      const at = surfaceCookie.indexOf('=')
      await context.addCookies([{ name: surfaceCookie.slice(0, at), value: surfaceCookie.slice(at + 1), url }])
    }
    const page = await context.newPage()
    // Opt-in: a surface whose scenario drives the application ROWS needs the
    // navigation unfolded. The deployment starts folded (decision S1), so a lane
    // that clicks rows directly would wait on a `display: none` element; seeding
    // the preference is the honest way to ask for the unfolded state, and the
    // folded default stays covered by the panel unit tests.
    if (expandNavigation) {
      await page.addInitScript(() => {
        try {
          const key = 'dsh.applications.preferences.v1'
          const current = JSON.parse(localStorage.getItem(key) ?? '{}')
          localStorage.setItem(key, JSON.stringify({ ...current, navExpanded: true }))
        } catch { /* storage unavailable: the column stays folded, the scenario reports it */ }
      })
    }
    page.on('pageerror', error => { onPageError(String(error), name) })
    page.on('console', (message) => {
      const type = message.type()
      if (type === 'error') onConsoleError(message.text(), name)
      else if (type === 'warning') onConsoleWarning(message.text(), name)
    })
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(pause)
    await dismissFirstRun(page, { timeout: firstRunTimeout, pause: firstRunPause })
    // The layout may restore the last application and open its first-run prompt
    // during hydration; answer it before handing the page to a scenario — except
    // for the lane whose SUBJECT is that prompt.
    if (dismissOnboarding) await postponeOnboarding(page, { timeout: 2500 })
    if (settle) await waitLayoutSettled(page)
    return { context, page }
  }

  return { openSurface, openApp }
}
