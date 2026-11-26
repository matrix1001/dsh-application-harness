/**
 * Script-plane tests for the application scaffolder (`node --test`, NOT vitest
 * — vitest collects `packages/∗/∗​/tests/**` only).
 *
 * The scaffolder is exercised as a SUBPROCESS, against temp roots it shapes
 * itself:
 *
 * - a small structural root (the two tsconfig reference files, the client
 *   bundle list, the root manifest the cordis pin is read from and the
 *   deployment descriptor the platform pin is read from), so both products are
 *   real: the default `host + view` pair and the `--no-view` host-only one;
 * - a VERIFICATION root under the repo's `tmp/` where the generated packages
 *   are checked for real — `tsc --noEmit -p <generated tsconfig>` against the
 *   workspace's own packages, and a `vitest` run over probe specs that call the
 *   generated `ping` op and register the generated page. Nothing generated
 *   lands in `packages/`: the app set is never polluted.
 *
 * The finding this locks down (arch-review 2026-09-16 AR2 ③): the generated
 * view package declared the panel as a workspace PEER, so the scaffold's own
 * product failed the client peer gate that ships beside it.
 *
 * The verification root needs the workspace's EMITTED declarations (the
 * generated package's project references resolve to `lib/types`): the repo's
 * own orders emit them (`pnpm run typecheck` / the `build` step before
 * `test:scripts`), and the check below says so explicitly rather than letting
 * tsc's TS6305 stand in for the reason.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { checkPeerShape } from '../verify-client-peer-shape.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'new-app.mjs')
/** The workspace's own cordis pin — what a scaffolded package must carry. */
const CORDIS_PIN = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies['@deepseek-ai/cordis']
/** The pin the STRUCTURAL roots declare, deliberately unlike the real one: the generated manifests must carry the root's value, not a literal. */
const FIXTURE_PIN = '9.9.9-fixture.1'

/** A minimal scaffold root: the deployment descriptor the platform pin comes
 * from, the root manifest the cordis pin comes from, the two reference files
 * and the client bundle list it wires into. */
function scaffoldRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-new-app-'))
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  write('packages/bundle/app-harness/deployment.yml', 'platform:\n  declaredLine: 0.1.6-alpha.2\n')
  write('package.json', JSON.stringify({ name: 'scaffold-root', private: true, devDependencies: { '@deepseek-ai/cordis': FIXTURE_PIN } }))
  write('tsconfig.host.json', '{\n  "references": [\n    { "path": "./packages/application/runtime" }\n  ]\n}\n')
  write('tsconfig.client.json', '{\n  "references": [\n    { "path": "./packages/client/applications" }\n  ]\n}\n')
  write('tsdown.config.ts', "const CLIENT_WORKSPACE = [\n  'packages/client/applications',\n] as const\n")
  return root
}

/** Run the scaffolder into `root`; returns its stdout. */
function scaffold(root, app, extra = []) {
  return execFileSync(process.execPath, [SCRIPT, app, '--root', root, ...extra], { encoding: 'utf8' })
}

test('the default scaffold writes a host declaration and a view whose peers pass the client peer gate', () => {
  const root = scaffoldRoot()
  try {
    const instructions = scaffold(root, 'demo')
    assert.match(instructions, /deployment\.yml/u)
    assert.match(instructions, /inject-contract\.json/u)
    assert.match(instructions, /node scripts\/deps\.mjs/u)
    const hostManifest = JSON.parse(readFileSync(join(root, 'apps/demo/host/package.json'), 'utf8'))
    const viewManifest = JSON.parse(readFileSync(join(root, 'apps/demo/view/package.json'), 'utf8'))
    assert.equal(hostManifest.name, '@matrix1001/dsh-application-harness-demo')
    assert.deepEqual(hostManifest.dsh.appRow, { id: 'demo', name: '@matrix1001/dsh-application-harness-demo' })
    // The declaration is written against the runtime, not the retired anchor.
    assert.deepEqual(Object.keys(hostManifest.peerDependencies).sort(), ['@deepseek-ai/cordis', '@matrix1001/dsh-application-harness-runtime'])
    assert.equal(hostManifest.peerDependencies['@matrix1001/dsh-application-harness-runtime'], 'workspace:*')
    // The cordis pin comes from the root manifest — never a literal that rots.
    assert.equal(hostManifest.peerDependencies['@deepseek-ai/cordis'], FIXTURE_PIN)
    assert.equal(hostManifest.devDependencies['@deepseek-ai/cordis'], FIXTURE_PIN)

    // The host half: an `AppDeclaration` built from the platform's schema DSL,
    // mounted through the shared helper, including disposal during startup.
    const appSource = readFileSync(join(root, 'apps/demo/host/src/app.ts'), 'utf8')
    const indexSource = readFileSync(join(root, 'apps/demo/host/src/index.ts'), 'utf8')
    assert.match(appSource, /export function DemoDeclaration\(\): AppDeclaration/u)
    assert.match(appSource, /import \{ AppError \} from '@matrix1001\/dsh-application-harness-runtime'/u)
    assert.match(appSource, /^      ping: \{$/mu)
    // Generation 2 with a data description and read semantics: the scaffolded
    // declaration is the guide's standard example, not a file the reader has to
    // replace (asserted here so the two cannot drift apart again).
    assert.match(appSource, /generation: 2/u)
    assert.match(appSource, /data: \{ kind: 'none' \}/u)
    assert.match(appSource, /effect: 'read'/u)
    assert.match(appSource, /additionalProperties: false/u)
    assert.match(appSource, /params: \{\n\s+message: \{ type: 'string', required: true/u)
    assert.match(appSource, /exposure: \{ ai: 'closed' \}/u)
    assert.match(indexSource, /export const inject = \['applications'\]/u)
    assert.match(indexSource, /await mountApplication\(ctx, DemoDeclaration\(\)\)/u)
    assert.equal(hostManifest.engines.dsh, '0.1.6-alpha.2')
    assert.doesNotMatch(indexSource, /registerOp|applicationRuntime|manifest/u)

    // The view half: registration into the shell's `applicationViews`, keyed by
    // the application id the row declares.
    assert.equal(viewManifest.name, '@matrix1001/dsh-application-harness-demo-view')
    assert.deepEqual(viewManifest.dsh.client, { inject: [], platform: 'web' })
    assert.deepEqual(viewManifest.dsh.appRow, { id: 'client-ui-demo', name: '@matrix1001/dsh-application-harness-demo-view', appId: 'demo' })
    assert.equal(viewManifest.devDependencies['@matrix1001/dsh-application-harness-client-applications'], 'workspace:*')
    assert.equal(viewManifest.peerDependencies['@deepseek-ai/cordis'], FIXTURE_PIN)
    const clientSource = readFileSync(join(root, 'apps/demo/view/src/client/index.ts'), 'utf8')
    assert.match(clientSource, /export const inject = \['locale', 'applicationViews'\]/u)
    assert.match(clientSource, /ctx\.applicationViews\.register\(APP_ID, view\)/u)
    assert.match(clientSource, /const APP_ID = 'demo'/u)
    assert.doesNotMatch(clientSource, /slots\.inject|app\.page\.projection/u)

    // The gate's own verdict over the generated tree: no peer drift (AR2 ③).
    assert.deepEqual(checkPeerShape(root), [])
    assert.deepEqual(Object.keys(viewManifest.peerDependencies), ['@deepseek-ai/cordis'])
    // The browser/type edge to the shell is a devDependency plus a tsconfig
    // reference, not a peer.
    const references = JSON.parse(readFileSync(join(root, 'apps/demo/view/tsconfig.json'), 'utf8')).references
    assert.deepEqual(references, [{ path: '../../../packages/client/applications' }])
    const hostReferences = JSON.parse(readFileSync(join(root, 'apps/demo/host/tsconfig.json'), 'utf8')).references
    assert.deepEqual(hostReferences, [{ path: '../../../packages/application/runtime' }])

    // No package README (and no pair record) is generated any more.
    assert.equal(existsSync(join(root, 'apps/demo/host/README.md')), false)
    assert.equal(existsSync(join(root, 'apps/demo/host/README.zh.md')), false)
    assert.equal(existsSync(join(root, 'apps/demo/host/README.i18n.yaml')), false)
    assert.equal(existsSync(join(root, 'apps/demo/view/README.md')), false)
    assert.equal(existsSync(join(root, 'apps/demo/view/README.zh.md')), false)
    assert.ok(readdirSync(join(root, 'apps/demo/host')).every((entry) => !entry.startsWith('README')))

    // Both packages were wired into the build graphs.
    assert.match(readFileSync(join(root, 'tsconfig.host.json'), 'utf8'), /apps\/demo\/host/u)
    assert.match(readFileSync(join(root, 'tsconfig.client.json'), 'utf8'), /apps\/demo\/view/u)
    assert.match(readFileSync(join(root, 'tsdown.config.ts'), 'utf8'), /'apps\/demo\/view',/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--no-view scaffolds the host package only', () => {
  const root = scaffoldRoot()
  try {
    scaffold(root, 'solo', ['--no-view'])
    assert.equal(existsSync(join(root, 'apps/solo/host/package.json')), true)
    assert.equal(existsSync(join(root, 'apps/solo/view')), false)
    assert.deepEqual(checkPeerShape(root), [])
    // The wiring follows the product: nothing named the skipped view package.
    assert.doesNotMatch(readFileSync(join(root, 'tsconfig.client.json'), 'utf8'), /apps\/solo\/view/u)
    assert.doesNotMatch(readFileSync(join(root, 'tsdown.config.ts'), 'utf8'), /apps\/solo\/view/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--version is honoured in both forms (it used to be silently dropped)', () => {
  const root = scaffoldRoot()
  try {
    scaffold(root, 'vone', ['--version', '9.9.9'])
    assert.equal(JSON.parse(readFileSync(join(root, 'apps/vone/host/package.json'), 'utf8')).version, '9.9.9')
    scaffold(root, 'vtwo', ['--version=8.8.8'])
    assert.equal(JSON.parse(readFileSync(join(root, 'apps/vtwo/host/package.json'), 'utf8')).version, '8.8.8')
    // The flag's VALUE never becomes the appid.
    assert.equal(existsSync(join(root, 'apps/9.9.9/host')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * A verification root under the repo's `tmp/`: the same seed files as
 * {@link scaffoldRoot}, plus symlinks into the real workspace so the generated
 * package's project references and imports resolve against the real packages.
 */
function verificationRoot() {
  mkdirSync(join(ROOT, 'tmp'), { recursive: true })
  const root = mkdtempSync(join(ROOT, 'tmp', 'scaffold-verify-'))
  cpSync(join(ROOT, 'tsconfig.base.json'), join(root, 'tsconfig.base.json'))
  cpSync(join(ROOT, 'tsconfig.base.client.json'), join(root, 'tsconfig.base.client.json'))
  // The paths plugin the repo's vitest config uses reads this from the root.
  cpSync(join(ROOT, 'tsconfig.test-paths.json'), join(root, 'tsconfig.test-paths.json'))
  mkdirSync(join(root, 'packages/bundle/app-harness'), { recursive: true })
  cpSync(join(ROOT, 'packages/bundle/app-harness/deployment.yml'), join(root, 'packages/bundle/app-harness/deployment.yml'))
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'scaffold-verify', private: true, devDependencies: { '@deepseek-ai/cordis': CORDIS_PIN } }))
  writeFileSync(join(root, 'tsconfig.host.json'), '{\n  "references": [\n    { "path": "./packages/application/runtime" }\n  ]\n}\n')
  writeFileSync(join(root, 'tsconfig.client.json'), '{\n  "references": [\n    { "path": "./packages/client/applications" }\n  ]\n}\n')
  writeFileSync(join(root, 'tsdown.config.ts'), "const CLIENT_WORKSPACE = [\n  'packages/client/applications',\n] as const\n")
  mkdirSync(join(root, 'packages/client'), { recursive: true })
  mkdirSync(join(root, 'apps'), { recursive: true })
  mkdirSync(join(root, 'node_modules/@deepseek-ai'), { recursive: true })
  mkdirSync(join(root, 'node_modules/@matrix1001'), { recursive: true })
  // The shared trees the referenced projects live in.
  symlinkSync(join(ROOT, 'packages/application'), join(root, 'packages/application'))
  symlinkSync(join(ROOT, 'packages/typert'), join(root, 'packages/typert'))
  symlinkSync(join(ROOT, 'packages/client/applications'), join(root, 'packages/client/applications'))
  // applications references the chrome project; the verification root needs the
  // same sibling so the copied tsconfig resolves it.
  symlinkSync(join(ROOT, 'packages/client/chrome'), join(root, 'packages/client/chrome'))
  // The one workspace package node_modules resolution cannot reach from here
  // (it is not a root dependency): the shell the view registers into.
  symlinkSync(join(ROOT, 'packages/client/applications'), join(root, 'node_modules/@matrix1001/dsh-application-harness-client-applications'))
  return root
}

/** Run one of the repo's binaries (the same binaries `pnpm exec` would run). */
function runBin(name, args, options = {}) {
  return execFileSync(join(ROOT, 'node_modules/.bin', name), args, {
    encoding: 'utf8',
    // The verification root's own tsconfig chain must be selected by ARGUMENT,
    // never by the cwd — run from the repo root so relative inputs stay stable.
    cwd: ROOT,
    ...options,
  })
}

/** Fail with the reason, not tsc's symptom, when the workspace has no emitted declarations. */
function requireBuiltDeclarations() {
  const required = [
    join(ROOT, 'packages/application/runtime/lib/types/index.d.ts'),
    join(ROOT, 'packages/application/host-bridge/lib/types/index.d.ts'),
    join(ROOT, 'packages/client/applications/lib/types/client/index.d.ts'),
    join(ROOT, 'packages/client/chrome/lib/types/index.d.ts'),
  ]
  const missing = required.filter((path) => !existsSync(path))
  if (missing.length > 0) {
    throw new Error(`the generated package's project references resolve to the workspace's emitted declarations; run \`pnpm run typecheck\` first (missing: ${missing.map((path) => path.replace(`${ROOT}/`, '')).join(', ')})`)
  }
}

test('the generated packages typecheck (tsc --noEmit -p) and run under vitest', () => {
  const root = verificationRoot()
  try {
    requireBuiltDeclarations()
    scaffold(root, 'demo')
    const hostPackage = join(root, 'apps/demo/host')
    const viewPackage = join(root, 'apps/demo/view')
    // The real commands: the generated package's own tsconfig, nothing relaxed.
    runBin('tsc', ['--noEmit', '-p', join(hostPackage, 'tsconfig.json')])
    runBin('tsc', ['--noEmit', '-p', join(viewPackage, 'tsconfig.json')])

    // The probe specs are the check's own material (the scaffold generates no
    // tests): they call the declared `ping` op and register the page.
    mkdirSync(join(hostPackage, 'tests'), { recursive: true })
    writeFileSync(join(hostPackage, 'tests/demo.spec.ts'), `import { expect, test } from 'vitest'
import { DemoDeclaration, apply as mountDemo } from '../src/index.ts'
import { ApplicationRuntime } from '@matrix1001/dsh-application-harness-runtime'
import { apply, inject } from '../../view/src/client/index.ts'

test('the generated declaration answers ping through its own op', async () => {
  const declaration = DemoDeclaration()
  expect(declaration.id).toBe('demo')
  const value = await declaration.ops.ping.execute({ message: 'hello' }, {} as never)
  expect(value).toEqual({ echo: 'hello' })
})

test('the generated plugin unloads and can mount again with the same id', async () => {
  const applications = new ApplicationRuntime()
  let dispose: () => Promise<void>
  const ctx = { applications, effect: (body: () => () => Promise<void>) => { dispose = body() } }
  await mountDemo(ctx as never)
  expect(applications.list()).toHaveLength(1)
  await dispose!()
  expect(applications.list()).toHaveLength(0)
  await mountDemo(ctx as never)
  expect(applications.list()).toHaveLength(1)
  await dispose!()
})

test('the generated view registers the demo page into the shell registry', () => {
  expect(inject).toContain('applicationViews')
  const registered: string[] = []
  const ctx = {
    // The registration binds the dictionary for its identity getters too
    // (name/description), so the double carries the whole face it reads.
    locale: { register: () => () => {}, bind: () => (key: string) => key },
    applicationViews: { register: (appId: string) => { registered.push(appId); return () => {} } },
    effect: (body: () => unknown) => { void body() },
  }
  apply(ctx as never)
  expect(registered).toEqual(['demo'])
})
`)
    const run = runBin('vitest', [
      'run', '--root', root, '--config', join(ROOT, 'vitest.config.ts'),
      'apps/demo/host/tests/demo.spec.ts',
    ])
    const plain = stripVTControlCharacters(run)
    assert.match(plain, /Test Files\s+1 passed/u)
    assert.match(plain, /Tests\s+3 passed/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
