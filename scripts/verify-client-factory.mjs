/**
 * Client factory evaluation gate: evaluate every committed client bundle
 * (`lib/client.js`) in a node:vm sandbox and assert the loader handoff it
 * makes is exactly one valid `__ModuleLoader__.load({ id, factory })`
 * registration with the package's own id. The factory is then executed
 * against a recording `require` so every external specifier it asks for is
 * answered by the loader module table (platform seeds + the package's
 * declared `dsh.client.external` edges, exact specifiers) — a specifier the
 * table cannot answer is a guaranteed browser-time throw.
 *
 * Why: the build-time purity gate enforces these rules at bundle time, but
 * the classes of defect that broke live instances (double registration, a
 * banner TDZ, a rebuilt artifact drifting from its manifest) exist only in
 * the built artifact. This gate runs on the artifact. The inline negative
 * cases self-prove the checker: each must trip it, or the gate itself is
 * broken. Modeled on the dsh-worktable factory gate (2026-09-07 study B01).
 *
 * Run after the client build; wired into release:check.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { packageDirs } from './package-areas.mjs'
import vm from 'node:vm'
import { parseLocalPlatformModules } from './platform-contract.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PLATFORM_MODULES = parseLocalPlatformModules(join(ROOT, 'packages', 'client', 'tsdown.client.ts'))

/** Per-bundle factory evaluation budget. */
const TIMEOUT_MS = 10_000

/**
 * The names an esbuild/tsdown CJS-interop helper copies when it turns a required
 * module into a namespace object (`__copyProps` walks `Object.getOwnPropertyNames`).
 * A double that answered only `get` would look empty to that helper — a bundled
 * library calling `(0, react.memo)(...)` then fails inside the sandbox although
 * the real browser build works. The list is deliberately generic: it is the
 * surface an inlined third-party UI library may touch, not a claim about any one
 * package.
 */
const MODULE_DOUBLE_NAMES = [
  // The target is a function: its own non-configurable keys must be reported too
  // (a Proxy invariant), even though nothing reads their values.
  'length', 'name', 'prototype',
  'default', '__esModule',
  // React's public surface (the common subset an inlined component library uses).
  'memo', 'forwardRef', 'createElement', 'cloneElement', 'isValidElement', 'createContext', 'createFactory',
  'useState', 'useEffect', 'useLayoutEffect', 'useMemo', 'useCallback', 'useRef', 'useReducer', 'useContext',
  'useImperativeHandle', 'useDebugValue', 'useId', 'useTransition', 'useDeferredValue', 'useSyncExternalStore',
  'startTransition', 'Component', 'PureComponent', 'Fragment', 'StrictMode', 'Suspense', 'lazy', 'Children', 'version',
  // DOM/browser helpers an inlined library may probe for.
  'addEventListener', 'removeEventListener', 'dispatchEvent', 'querySelector', 'querySelectorAll', 'createElementNS',
  'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'matchMedia',
]

/**
 * The permissive module double every factory `require` is answered with:
 * callable, indexable, property-carrying — a require of any shape succeeds
 * while the recorder notes the specifier. `ownKeys`/`getOwnPropertyDescriptor`
 * exist so an interop helper's property copy sees that surface.
 */
function moduleDouble() {
  const target = function () { return target }
  return new Proxy(target, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'default') return target
      return target
    },
    apply() { return target },
    has() { return true },
    ownKeys() { return MODULE_DOUBLE_NAMES },
    getOwnPropertyDescriptor(_, prop) {
      // Every reported key must be describable (a Proxy invariant), and the
      // descriptor is a plain enumerable data property so `__copyProps`
      // transfers it. A key the FUNCTION target already owns must keep that
      // property's own descriptor shape (the invariant compares them).
      if (prop === 'length' || prop === 'name') return { value: prop === 'length' ? 0 : '', writable: false, enumerable: false, configurable: true }
      if (prop === 'prototype') return { value: target.prototype, writable: true, enumerable: false, configurable: false }
      return { value: target, writable: true, enumerable: true, configurable: true }
    },
  })
}

/**
 * Fake browser globals for factory top-level side effects. The element is
 * permissive on purpose: an inlined third-party UI library may prepare DOM at
 * module/registration time (FullCalendar inserts its container synchronously),
 * and the gate's real assertions are the registration shape and the specifier
 * whitelist — not a DOM implementation. The named methods are the ones worth
 * answering concretely (so a probe for `null`/length behaves), and anything else
 * resolves to the same callable double the modules get.
 */
function fakeElement() {
  const element = {
    dataset: {}, style: {}, textContent: '',
    nodeType: 1, parentNode: null, children: [], childNodes: [],
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    appendChild() { return element }, insertBefore() { return element }, removeChild() { return element }, replaceChild() { return element },
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true },
    querySelector() { return null }, querySelectorAll() { return [] },
    getContext() { return null }, getBoundingClientRect() { return {} },
    contains() { return false }, cloneNode() { return element }, focus() {}, blur() {}, click() {}, remove() {},
  }
  return new Proxy(element, {
    get(target, prop) {
      if (prop in target) return target[prop]
      return moduleDouble()
    },
  })
}

function fakeDocument() {
  return {
    createElement() { return fakeElement() },
    querySelector() { return null },
    querySelectorAll() { return [] },
    head: fakeElement(), body: fakeElement(),
    documentElement: fakeElement(),
  }
}

/** Evaluate one bundle source and return the registrations it made. */
function evaluateBundle(source, sandbox) {
  const registrations = []
  const loader = {
    load(record) {
      registrations.push(record)
    },
  }
  const context = vm.createContext({
    window: { __ModuleLoader__: loader, addEventListener() {}, removeEventListener() {}, location: {} },
    document: fakeDocument(),
    navigator: { userAgent: 'node' },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    ...sandbox,
  })
  const script = new vm.Script(source, { filename: 'lib/client.js' })
  // Method form: the module-level vm.runInContext stringifies a Script
  // instance on this Node line (24.x), which parses "[object Object]".
  script.runInContext(context, { timeout: TIMEOUT_MS })
  return { registrations, context }
}

/** Check one bundle: registration shape, id, factory type, require whitelist. */
function checkBundle(pkgName, source, seamList) {
  let evaluated
  try {
    evaluated = evaluateBundle(source)
  } catch (error) {
    return [`bundle evaluation failed: ${String(error?.message ?? error)}`]
  }
  const { registrations, context } = evaluated
  const problems = []
  if (registrations.length !== 1) {
    problems.push(`expected exactly 1 __ModuleLoader__.load call, got ${registrations.length}`)
    return problems
  }
  const [{ id, factory }] = registrations
  if (id !== pkgName) problems.push(`registration id ${JSON.stringify(id)} != package name ${JSON.stringify(pkgName)}`)
  if (typeof factory !== 'function') problems.push('factory is not a function')
  if (problems.length > 0) return problems

  // Execute the factory against the recording require to check every
  // external specifier is answerable by the loader module table.
  const whitelist = new Set([...PLATFORM_MODULES, ...seamList])
  const requested = new Set()
  const factoryScript = new vm.Script(`__factory__(__require__)`, { filename: 'lib/client.js (factory)' })
  context.__factory__ = factory
  context.__require__ = (specifier) => {
    if (typeof specifier !== 'string') throw new TypeError(`non-string require specifier: ${String(specifier)}`)
    requested.add(specifier)
    if (!whitelist.has(specifier)) {
      throw new Error(`unanswered require ${JSON.stringify(specifier)} — not a platform seed or declared dsh.client.external edge`)
    }
    return moduleDouble()
  }
  try {
    factoryScript.runInContext(context, { timeout: TIMEOUT_MS })
  } catch (error) {
    problems.push(`factory execution failed: ${String(error?.message ?? error)}`)
  }
  for (const specifier of requested) {
    if (!whitelist.has(specifier)) problems.push(`factory requires unanswerable ${JSON.stringify(specifier)}`)
  }
  return problems
}

/** Self-proof: each synthetic broken bundle must trip the checker. */
function runNegativeSelfTests() {
  const cases = [
    ['double registration', `window.__ModuleLoader__.load({ id: 'x', factory: () => {} }); window.__ModuleLoader__.load({ id: 'x', factory: () => {} })`, /exactly 1/],
    ['wrong id', `window.__ModuleLoader__.load({ id: 'other', factory: () => {} })`, /!= package name/],
    ['non-function factory', `window.__ModuleLoader__.load({ id: 'x', factory: 42 })`, /not a function/],
    ['top-level TDZ', `window.__ModuleLoader__.load({ id: 'x', factory: () => {} }); let a = b; let b`, /evaluation failed|Cannot access/],
    ['eval throw', `throw new Error('boom')`, /boom/],
    ['unanswerable require', `window.__ModuleLoader__.load({ id: 'x', factory: (require) => require('@matrix1001/dsh-application-harness-nope') })`, /unanswerable|unanswered/],
  ]
  for (const [label, source, pattern] of cases) {
    const problems = checkBundle('x', source, [])
    if (!problems.some(p => pattern.test(p))) {
      throw new Error(`negative self-test "${label}" did not trip the checker (got: ${problems.join('; ') || 'no problems'})`)
    }
  }
  console.log(`  ✓ ${cases.length} negative self-tests all trip the checker`)
}

/** Enumerate the workspace client packages (manifest declares dsh.client). */
function clientPackages() {
  const result = []
  for (const dir of packageDirs(ROOT)) {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (manifest.dsh?.client !== undefined) result.push({ name: manifest.name, dir })
  }
  return result
}

function main() {
  console.log('verify-client-factory: evaluating committed client bundles')
  runNegativeSelfTests()

  const packages = clientPackages()
  if (packages.length === 0) {
    console.error('no client packages found — is the workspace present?')
    process.exit(1)
  }
  let failed = 0
  for (const { name, dir } of packages) {
    const bundle = join(dir, 'lib/client.js')
    if (!existsSync(bundle)) {
      console.error(`  ✘ ${name}: lib/client.js missing — run the client build first`)
      failed++
      continue
    }
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const seams = Array.isArray(manifest.dsh?.client?.external) ? manifest.dsh.client.external : []
    const source = readFileSync(bundle, 'utf8')
    const problems = checkBundle(name, source, seams)
    if (problems.length > 0) {
      console.error(`  ✘ ${name}:`)
      for (const problem of problems) console.error(`      ${problem}`)
      failed++
    } else {
      console.log(`  ✓ ${name} (${(source.length / 1024).toFixed(0)} KiB)`)
    }
  }
  if (failed > 0) {
    console.error(`verify-client-factory: ${failed} bundle(s) failed`)
    process.exit(1)
  }
  console.log(`verify-client-factory: ${packages.length} bundles OK`)
}

main()
