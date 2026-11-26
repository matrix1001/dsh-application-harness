#!/usr/bin/env node
/**
 * 行聚合生成器（官方通道迁移计划决策 2）：把各包的 `dsh.appRow` 声明聚合进
 * bundle 的 cordis.patch.yml——机制行在 marker 之上（手写、真源不动），应用行
 * 在 marker 之下（生成、确定性排序）。行序 = setup.mjs 惯例（examples 先、
 * client 视图后，各按包名序）。`--check` 模式：生成产物与提交内容不一致即红
 * （release:check 门——漂移必须显式重生成并提交，杜绝手工改行）。
 *
 * **同一份生成器还维护 web 示例 overlay 的机械段**（`examples/web-application/
 * cordis.yml`，2026-09-23 收口）：那份 overlay 曾把 bundle patch 的 31 条机械行
 * **整段手抄**一份，于是"第二份拷贝"可以和真源静默分叉——`client-ui-git-read`
 * 就是这样在没有宿主应用行的情况下挂了很久，而所有门禁全绿（行集门只比对
 * id+name）。现在它的机械段由 bundle patch 的机械段**生成**，手写的只剩文件头
 * 说明与本示例自己的示例行；漂移不再可能，覆盖它的门禁就是本脚本的 `--check`。
 *
 * 生成器不再维护侧栏替换指令：平台默认 `ui-sidebar` 保留，applications 包通过
 * `sidebar.panellist` 与 keyed `main` 接入。overlay 因此只生成机械行。
 *
 * 用法：
 *   node scripts/generate-bundle-patch.mjs           # 重写两处生成段
 *   node scripts/generate-bundle-patch.mjs --check   # 只校验（任一漂移 → exit 1）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { load as parseYaml } from 'js-yaml'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appHostDirs, appViewDirs } from './package-areas.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PATCH_PATH = join(ROOT, 'packages', 'bundle', 'app-harness', 'cordis.patch.yml')
const OVERLAY_PATH = join(ROOT, 'examples', 'web-application', 'cordis.yml')

const MARKER = '    # --- generated application rows (do not edit below; node scripts/generate-bundle-patch.mjs) ---'
/** The web overlay's generated machinery region: everything between these two lines is rewritten from the bundle patch. */
const OVERLAY_MACHINERY_START = '    # --- machinery rows (generated from packages/bundle/app-harness/cordis.patch.yml; node scripts/generate-bundle-patch.mjs) ---'
const OVERLAY_EXAMPLE_START = '    # --- example rows (hand-written: this composition demonstrates the git-browser application) ---'

/**
 * The bundle patch's machinery region: the rows of its `insert:` list above its
 * own generated marker, comments included, without the `- insert:` line itself.
 * @param bundlePatch - the bundle patch file's text.
 * @returns the region, ready to be nested under an `insert:` in another file.
 */
function machineryRegion(bundlePatch) {
  const insert = bundlePatch.indexOf('\n- insert:\n')
  const marker = bundlePatch.indexOf(MARKER)
  if (insert < 0 || marker < 0) throw new Error('the bundle patch lost its `- insert:` list or its generated-rows marker')
  return bundlePatch.slice(insert + '\n- insert:\n'.length, marker).replace(/\s+$/, '')
}

/**
 * Regenerate the web overlay: its hand-written head (prose up to the insert
 * list) and tail (the example rows) are kept verbatim; the machinery region
 * between them is copied from the bundle patch.
 * @param bundlePatch - the (freshly generated) bundle patch text.
 * @returns the overlay file's full text.
 */
function generateOverlay(bundlePatch) {
  const onDisk = readFileSync(OVERLAY_PATH, 'utf8')
  const machineryStart = onDisk.indexOf(OVERLAY_MACHINERY_START)
  const insertStart = machineryStart < 0 ? -1 : onDisk.lastIndexOf('\n- insert:\n', machineryStart)
  const tailStart = onDisk.indexOf(OVERLAY_EXAMPLE_START)
  if (insertStart < 0 || tailStart < 0 || tailStart < machineryStart) {
    throw new Error(`the web overlay lost one of its region markers (${OVERLAY_PATH})`)
  }
  const head = onDisk.slice(0, insertStart + 1)
  const tail = onDisk.slice(tailStart)
  return `${head}- insert:\n${OVERLAY_MACHINERY_START}\n${machineryRegion(bundlePatch)}\n${tail}`
}

/** The production application and client rosters declared by the deployment descriptor. */
function deployedRosters() {
  const descriptor = parseYaml(readFileSync(join(ROOT, 'packages/bundle/app-harness/deployment.yml'), 'utf8'))
  return {
    applications: new Set((descriptor?.applications ?? []).map(row => row.package)),
    clients: new Set(descriptor?.client?.packages ?? []),
  }
}

/** 收集各包的 dsh.appRow 声明（examples 先、client 后，各按包名序——setup.mjs 同惯例）。 */
function collectRows() {
  const rows = []
  const deployed = deployedRosters()
  const readRow = (dir, allowed) => {
    const pkgFile = join(dir, 'package.json')
    if (!existsSync(pkgFile)) return
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
    } catch {
      return
    }
    const row = pkg === null || typeof pkg !== 'object' ? undefined : pkg.dsh?.appRow
    if (row === undefined || !allowed.has(pkg.name)) return
    rows.push(row)
  }
  for (const dir of appHostDirs(ROOT)) readRow(dir, deployed.applications)
  for (const dir of appViewDirs(ROOT)) readRow(dir, deployed.clients)
  return rows
}

/** 渲染一行（setup.mjs 同款：config 值 `!!js ` 前缀原样输出、其余 JSON 字面量）。 */
function renderRow(row) {
  const lines = [`    - id: ${row.id}`, `      name: '${row.name}'`]
  if (typeof row.config === 'object' && row.config !== null) {
    lines.push('      config:')
    for (const [key, value] of Object.entries(row.config)) {
      lines.push(`        ${key}: ${typeof value === 'string' && value.startsWith('!!js ') ? value : JSON.stringify(value)}`)
    }
  }
  return lines.join('\n')
}

/** 生成完整 patch 内容：机制行（marker 前，不动）+ marker + 生成应用行。 */
function generate() {
  const source = readFileSync(PATCH_PATH, 'utf8')
  const markerIndex = source.indexOf(MARKER)
  const head = markerIndex < 0 ? source.replace(/\s+$/, '') : source.slice(0, markerIndex).replace(/\s+$/, '')
  const rows = collectRows().map(renderRow).join('\n')
  return `${head}\n\n${MARKER}\n    # 示例应用/视图行（真源 = 各包的 package.json \`dsh.appRow\` 声明）\n${rows}\n`
}

/** CLI: compare (and optionally rewrite) the two generated regions. */
function main() {
  const check = process.argv.includes('--check')
  const generated = generate()
  const onDisk = readFileSync(PATCH_PATH, 'utf8')
  // The overlay is generated FROM the bundle patch, so it is compared against
  // the freshly generated text — one run keeps the two in step by construction.
  const overlayGenerated = generateOverlay(generated)
  const overlayOnDisk = readFileSync(OVERLAY_PATH, 'utf8')
  const drift = []
  if (generated !== onDisk) drift.push('bundle patch (vs the dsh.appRow declarations)')
  if (overlayGenerated !== overlayOnDisk) drift.push('web overlay machinery rows (vs the bundle patch)')
  if (check) {
    if (drift.length === 0) {
      console.log('generate-bundle-patch: bundle patch and web overlay in sync')
    } else {
      console.error(`generate-bundle-patch: ${drift.join('; ')} drifted — run \`node scripts/generate-bundle-patch.mjs\` and commit the regenerated rows`)
      process.exit(1)
    }
    return
  }
  if (drift.length === 0) {
    console.log('generate-bundle-patch: unchanged')
    return
  }
  if (generated !== onDisk) {
    writeFileSync(PATCH_PATH, generated, 'utf8')
    console.log('generate-bundle-patch: regenerated application rows in packages/bundle/app-harness/cordis.patch.yml')
  }
  if (overlayGenerated !== overlayOnDisk) {
    writeFileSync(OVERLAY_PATH, overlayGenerated, 'utf8')
    console.log('generate-bundle-patch: regenerated the machinery rows in examples/web-application/cordis.yml')
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()

export { generate, generateOverlay, machineryRegion }
