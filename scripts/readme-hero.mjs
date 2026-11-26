#!/usr/bin/env node
/**
 * Generate the README hero figure: the application page and its right-hand
 * application-area conversation, drawn from the real UI's structure and tokens
 * (the shared 48px top row, the divider, the dock tab strip; the app reader on
 * the left, the transcript and composer on the right).
 *
 * The figure is a MOCK, not a screenshot: it is composed for the README and
 * says so in its alt text. Keep it in step with the product tokens it names.
 *
 * Usage:
 *   node scripts/readme-hero.mjs           # write docs/assets/readme/hero.svg
 *   node scripts/readme-hero.mjs --check   # fail when the committed file drifted
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUTPUT = join(ROOT, 'docs/assets/readme/hero.svg')
const W = 956
const H = 656
const X = 28
const Y = 28
const WW = 900
const WH = 600

const app = {
  text: '#1d2129', text2: '#4e5969', muted: '#86909c',
  border: '#e5e6eb', borderSoft: '#eef0f2', panel: '#ffffff', bg: '#f7f8fa',
  accent: '#4d6bfe', accentSoft: '#eef2ff',
}
const pf = {
  ink: '#0f1115', ink2: '#61666b', ink3: '#81858c',
  line: '#ebeef2', bubble: '#edf3fe', surface: '#f9fafb',
  accent: '#4176e6',
}

const esc = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

function measure(text, size) {
  let width = 0
  for (const char of text) width += /[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? size : size * 0.60
  return width
}

function wrap(text, size, maxWidth) {
  const lines = []
  let line = ''
  for (const char of text) {
    const next = line + char
    if (measure(next, size) > maxWidth && line !== '') {
      lines.push(line)
      line = char === ' ' ? '' : char
    } else {
      line = next
    }
  }
  if (line !== '') lines.push(line)
  // Keep the last line from stranding one or two characters.
  while (lines.length > 1 && measure(lines[lines.length - 1], size) < size * 2.4) {
    const previous = lines[lines.length - 2]
    const chars = [...previous]
    if (chars.length < 2) break
    const moved = chars.pop()
    lines[lines.length - 2] = chars.join('').trimEnd()
    lines[lines.length - 1] = moved + lines[lines.length - 1]
  }
  return lines
}

const parts = []
const push = (value) => parts.push(value)

const text = (x, y, value, { size = 13, weight = 400, fill = app.text, anchor = 'start', opacity } = {}) =>
  push(`<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${fill}"${anchor === 'start' ? '' : ` text-anchor="${anchor}"`}${opacity === undefined ? '' : ` opacity="${opacity}"`}>${esc(value)}</text>`)

function paragraph(x, y, value, { size = 13, lh = 21, fill = app.text2, weight = 400, maxWidth } = {}) {
  const lines = wrap(value, size, maxWidth)
  lines.forEach((line, index) => text(x, y + index * lh, line, { size, fill, weight }))
  return y + lines.length * lh
}

const rect = (x, y, w, h, { r = 0, fill = 'none', stroke, sw = 1 } = {}) =>
  push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}"${stroke === undefined ? '' : ` stroke="${stroke}" stroke-width="${sw}"`}/>`)

const hline = (x1, x2, y, { stroke = app.borderSoft, sw = 1 } = {}) =>
  push(`<path d="M${x1} ${y}H${x2}" stroke="${stroke}" stroke-width="${sw}"/>`)

const vline = (x, y1, y2, { stroke = app.borderSoft, sw = 1 } = {}) =>
  push(`<path d="M${x} ${y1}V${y2}" stroke="${stroke}" stroke-width="${sw}"/>`)

const chip = (x, y, label, { size = 11, height = 16, fill = app.accentSoft, color = app.accent } = {}) => {
  const w = Math.round(measure(label, size) + 10)
  rect(x, y, w, height, { r: 5, fill })
  text(x + w / 2, y + height / 2 + size * 0.36, label, { size, fill: color, anchor: 'middle' })
  return w
}

/** 12px line-art app icons, one per built-in application. */
function icon(kind, x, y, { color = '#adb2b8' } = {}) {
  const c = color
  const g = `stroke="${c}" stroke-width="1.3" fill="none" stroke-linecap="round" stroke-linejoin="round"`
  if (kind === 'git') {
    push(`<g transform="translate(${x} ${y})"><circle cx="3.4" cy="2.8" r="1.6" ${g}/><circle cx="3.4" cy="9.2" r="1.6" ${g}/><circle cx="8.8" cy="5.4" r="1.6" ${g}/><path d="M3.4 4.4V7.6" ${g}/><path d="M4.9 5.4h2.3" ${g}/></g>`)
  } else if (kind === 'home') {
    push(`<g transform="translate(${x} ${y})"><path d="M1.4 5.4L6 1.6l4.6 3.8" ${g}/><path d="M2.5 5.2v5h7v-5" ${g}/></g>`)
  } else if (kind === 'inbox') {
    push(`<g transform="translate(${x} ${y})"><path d="M1.4 6.6h3l.9 1.6h3.4l.9-1.6h3" ${g}/><path d="M1.4 6.6l1.4-4.2h6.4l1.4 4.2v3.6H1.4z" ${g}/></g>`)
  } else if (kind === 'note') {
    push(`<g transform="translate(${x} ${y})"><path d="M2 1.6h6.4l2 2v7H2z" ${g}/><path d="M4 6h4M4 8.2h3" ${g}/></g>`)
  } else if (kind === 'todo') {
    push(`<g transform="translate(${x} ${y})"><path d="M1.6 3.2l1.2 1.2 2-2.2" ${g}/><path d="M1.6 8.4l1.2 1.2 2-2.2" ${g}/><path d="M7 3h3.4M7 8.6h3.4" ${g}/></g>`)
  }
}

// ---------------------------------------------------------------- canvas
push(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="hero-title hero-desc" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif">`)
push(`<title id="hero-title">同一个应用：人在页面里读，AI 在右侧应用区会话里调用它</title>`)
push(`<desc id="hero-desc">左边是信息收件箱的阅读页，右边是同属这个应用的应用区会话；AI 读完正文整理出三条待办，写入前在同一入口弹出确认。</desc>`)
push(`<defs>
  <clipPath id="frame"><rect x="${X}" y="${Y}" width="${WW}" height="${WH}" rx="18"/></clipPath>
  <filter id="frame-shadow" x="-8%" y="-10%" width="116%" height="128%">
    <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#0f1115" flood-opacity="0.13"/>
  </filter>
  <linearGradient id="page" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#f7f9fc"/>
    <stop offset="1" stop-color="#eef2f8"/>
  </linearGradient>
</defs>`)
rect(0, 0, W, H, { fill: 'url(#page)' })
push(`<g clip-path="url(#frame)">`)

// ---------------------------------------------------------------- shared top row
rect(X, Y, WW, 48, { fill: '#ffffff' })
hline(X, X + WW, Y + 48, { stroke: pf.line })

push(`<path d="M${X + 21} ${Y + 18}L${X + 15} ${Y + 24}L${X + 21} ${Y + 30}" fill="none" stroke="${app.text2}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)

const tabs = [
  { kind: 'git', label: 'Git 浏览', w: 86 },
  { kind: 'home', label: '主页', w: 58 },
  { kind: 'inbox', label: '信息收件箱', w: 102, active: true },
  { kind: 'note', label: '笔记', w: 56 },
  { kind: 'todo', label: '待办', w: 56 },
]
let tabX = X + 40
for (const tab of tabs) {
  if (tab.active === true) rect(tabX, Y + 8, tab.w, 32, { r: 8, fill: app.accentSoft })
  icon(tab.kind, tabX + 11, Y + 18, { color: tab.active === true ? app.accent : '#adb2b8' })
  text(tabX + 30, Y + 28, tab.label, { size: 13, fill: tab.active === true ? app.accent : app.text2, weight: tab.active === true ? 500 : 400 })
  tabX += tab.w + 4
}

for (let i = 0; i < 4; i += 1) {
  rect(tabX + 8 + (i % 2) * 9, Y + 17 + Math.floor(i / 2) * 9, 6, 6, { r: 1.5, fill: '#adb2b8' })
}
push(`<path d="M${tabX + 46} ${Y + 20}v8M${tabX + 42} ${Y + 24}h8" stroke="${app.text2}" stroke-width="1.4" stroke-linecap="round"/>`)

vline(X + 520, Y, Y + WH, { stroke: '#00000014' })

rect(X + 536, Y + 9, 172, 30, { r: 8, fill: pf.surface, stroke: pf.line })
push(`<circle cx="${X + 550}" cy="${Y + 24}" r="3" fill="${app.accent}"/>`)
text(X + 560, Y + 29, '整理收件箱要点', { size: 12, fill: app.text })
push(`<path d="M${X + 696} ${Y + 21.6}l4.8 4.8M${X + 700.8} ${Y + 21.6}l-4.8 4.8" stroke="${app.muted}" stroke-width="1.2" stroke-linecap="round"/>`)
push(`<path d="M${X + 726} ${Y + 20}v8M${X + 722} ${Y + 24}h8" stroke="${app.text2}" stroke-width="1.4" stroke-linecap="round"/>`)
push(`<circle cx="${X + 836}" cy="${Y + 20}" r="1.3" fill="${app.text2}"/><circle cx="${X + 836}" cy="${Y + 24}" r="1.3" fill="${app.text2}"/><circle cx="${X + 836}" cy="${Y + 28}" r="1.3" fill="${app.text2}"/>`)
rect(X + 854, Y + 14, 26, 20, { r: 5, stroke: app.border })
push(`<path d="M${X + 866} ${Y + 16}v16" stroke="${app.border}" stroke-width="1.1"/>`)
push(`<path d="M${X + 873} ${Y + 22}l-3 2 3 2" fill="none" stroke="${app.text2}" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/>`)

// ---------------------------------------------------------------- app pane
hline(X, X + 520, Y + 91, { stroke: app.borderSoft })
text(X + 20, Y + 75, '收件箱', { size: 13, fill: app.accent, weight: 500 })
chip(X + 64, Y + 63, '3', { fill: app.accentSoft, color: app.accent })
push(`<path d="M${X + 20} ${Y + 89}H${X + 76}" stroke="${app.accent}" stroke-width="2"/>`)
text(X + 96, Y + 75, '稍后读', { size: 13, fill: app.text2 })
chip(X + 140, Y + 63, '1', { fill: app.bg, color: app.muted })
text(X + 170, Y + 75, '来源', { size: 13, fill: app.text2 })

// tools row: search + add + refresh, as the narrow layout puts them on one line
const toolButtonW = (label) => Math.round(measure(label, 12) + 20)
const toolsRight = X + 500
let toolX = toolsRight - toolButtonW('刷新')
rect(toolX, Y + 101, toolButtonW('刷新'), 28, { r: 6, fill: '#ffffff', stroke: app.border })
text(toolX + toolButtonW('刷新') / 2, Y + 119, '刷新', { size: 12, fill: app.text2, anchor: 'middle' })
toolX -= toolButtonW('添加链接') + 8
rect(toolX, Y + 101, toolButtonW('添加链接'), 28, { r: 6, fill: '#ffffff', stroke: app.border })
text(toolX + toolButtonW('添加链接') / 2, Y + 119, '添加链接', { size: 12, fill: app.text2, anchor: 'middle' })
const searchW = toolX - 8 - (X + 20)
rect(X + 20, Y + 101, searchW, 28, { r: 6, fill: app.bg, stroke: app.border })
text(X + 32, Y + 119, '搜索标题、摘要、正文', { size: 12, fill: app.muted })
hline(X, X + 520, Y + 141, { stroke: app.borderSoft })

// reader head: back (narrow layout keeps it), source, time
push(`<path d="M${X + 26} ${Y + 158}l-5 5 5 5" fill="none" stroke="${app.text2}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>`)
text(X + 40, Y + 168, 'matrix1001/dsh-application-harness', { size: 12, fill: app.muted })
text(X + 500, Y + 168, '11月26日 13:54', { size: 12, fill: app.muted, anchor: 'end' })
text(X + 20, Y + 200, 'v0.1.0：内置应用、公开操作与统一入口', { size: 19, weight: 600, fill: app.text })

const action = (x, label) => {
  const w = Math.round(measure(label, 12) + 20)
  rect(x, Y + 214, w, 26, { r: 6, fill: '#ffffff', stroke: app.border })
  text(x + w / 2, Y + 231, label, { size: 12, fill: app.text2, anchor: 'middle' })
  return w
}
let actionX = X + 20
actionX += action(actionX, '打开原文 ↗') + 8
actionX += action(actionX, '标为未读') + 8
action(actionX, '收藏')
let rightX = X + 500
for (const label of ['存笔记', '转任务']) {
  const w = Math.round(measure(label, 12) + 20)
  rightX -= w
  const emphasise = label === '转任务'
  rect(rightX, Y + 214, w, 26, { r: 6, fill: '#ffffff', stroke: emphasise ? '#c9d7ff' : app.border })
  text(rightX + w / 2, Y + 231, label, { size: 12, fill: emphasise ? app.accent : app.text2, anchor: 'middle' })
  rightX -= 8
}

const bodyX = X + 20
const bodyW = 480
let y = Y + 268
text(bodyX, y, '这个版本包含', { size: 15, weight: 600, fill: app.text })
y += 26
for (const item of [
  '五个内置应用：主页、笔记、待办、信息收件箱、Git 浏览。',
  '运行时、存储、页面外壳、权限和 AI 接入由框架提供，应用只写自己的领域操作。',
  '应用通过公开操作互相协作，目标应用仍按自己的业务校验处理请求。',
]) {
  push(`<circle cx="${bodyX + 3}" cy="${y - 4}" r="2.2" fill="${app.text2}"/>`)
  y = paragraph(bodyX + 16, y, item, { maxWidth: bodyW - 16 })
  y += 5
}
y += 10
text(bodyX, y, '一次调用经过什么', { size: 15, weight: 600, fill: app.text })
y += 26
y = paragraph(bodyX, y, '页面、会话和应用接口走同一条路径：应用声明、参数校验、授权或确认、调用历史。', { maxWidth: bodyW })
y += 22
text(bodyX, y, '已知边界', { size: 15, weight: 600, fill: app.text })
y += 26
for (const item of [
  '当前只在 Linux 上验证过，macOS 和 Windows 尚未验证。',
  '试验阶段，接口和应用集合仍可能变化。',
]) {
  push(`<circle cx="${bodyX + 3}" cy="${y - 4}" r="2.2" fill="${app.text2}"/>`)
  y = paragraph(bodyX + 16, y, item, { maxWidth: bodyW - 16 })
  y += 5
}


// ---------------------------------------------------------------- dock: transcript + composer
const dockX = X + 540
const dockW = 340

/** One muted row for a public operation the assistant ran. */
function opRow(y, label, detail) {
  push(`<g transform="translate(${dockX} ${y - 9})"><rect width="12" height="12" rx="3.5" fill="none" stroke="#b9bfc9" stroke-width="1.1"/><path d="M4 6h4M6.6 4.2L8.4 6 6.6 7.8" fill="none" stroke="#b9bfc9" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/></g>`)
  text(dockX + 20, y, label, { size: 12, fill: label === '转任务' ? app.accent : app.text2 })
  text(dockX + 20 + measure(label, 12) + 8, y, detail, { size: 12, fill: app.muted })
}

const userLines = ['@信息收件箱 @待办 把这篇内容的决定', '整理成 3 条待办。']
const bubbleW = Math.max(...userLines.map((l) => measure(l, 13))) + 32
const bubbleH = 20 + userLines.length * 20
rect(dockX + dockW - bubbleW, Y + 64, bubbleW, bubbleH, { r: 12, fill: pf.bubble })
const bubbleX = dockX + dockW - bubbleW
userLines.forEach((l, index) => text(bubbleX + 16, Y + 84 + index * 20, l, { size: 13, fill: app.text }))

// the assistant reads the entry, then hands work to another application
let stepY = Y + 64 + bubbleH + 28
opRow(stepY, '读取', '信息收件箱 · 正文')
stepY += 26
stepY = paragraph(dockX, stepY, '这篇讲的是首个 Release 包含什么、一次调用要经过哪些检查，以及当前的验证边界。', { size: 13, lh: 21, maxWidth: dockW }) + 14
text(dockX, stepY, '已经按正文整理了 3 条，确认后写入待办：', { size: 13, fill: app.text })
stepY += 26
for (const [label, due] of [
  ['补 macOS 和 Windows 的验证记录', '11月28日'],
  ['整理五个内置应用的公开操作清单', '11月29日'],
  ['把安装步骤补进上手文档', '12月1日'],
]) {
  rect(dockX, stepY - 11, 11, 11, { r: 3, stroke: '#cfd3d6' })
  text(dockX + 19, stepY, label, { size: 13, fill: app.text })
  text(dockX + dockW, stepY, due, { size: 11, fill: app.muted, anchor: 'end' })
  stepY += 26
}
stepY -= 8
rect(dockX, stepY, dockW, 88, { r: 10, fill: '#ffffff', stroke: app.border })
text(dockX + 14, stepY + 24, '转任务', { size: 13, weight: 500, fill: app.accent })
text(dockX + 14 + measure('转任务', 13) + 8, stepY + 24, '待办 · 创建 3 条', { size: 13, weight: 500, fill: app.text })
text(dockX + 14, stepY + 44, '确认后写入待办，并带上这篇文章的来源。', { size: 12, fill: app.muted })
const allowW = 52
rect(dockX + dockW - 14 - allowW, stepY + 54, allowW, 26, { r: 6, fill: app.accent })
text(dockX + dockW - 14 - allowW / 2, stepY + 71, '允许', { size: 12, fill: '#ffffff', anchor: 'middle' })
rect(dockX + dockW - 14 - allowW - 8 - allowW, stepY + 54, allowW, 26, { r: 6, fill: '#ffffff', stroke: app.border })
text(dockX + dockW - 14 - allowW - 8 - allowW / 2, stepY + 71, '拒绝', { size: 12, fill: app.text2, anchor: 'middle' })

// composer, pinned to the bottom of the dock
const composerY = Y + WH - 96
text(dockX + 2, composerY - 12, '标准模式', { size: 12, fill: app.muted })
push(`<path d="M${dockX + 56} ${composerY - 17}l3 3 3-3" fill="none" stroke="${app.muted}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`)
rect(dockX, composerY, dockW, 76, { r: 18, fill: '#ffffff', stroke: '#dbe0e8' })
text(dockX + 16, composerY + 30, '继续提问，或选择应用', { size: 13, fill: app.muted })
push(`<path d="M${dockX + 24} ${composerY + 52}v10M${dockX + 19} ${composerY + 57}h10" stroke="${app.text2}" stroke-width="1.4" stroke-linecap="round"/>`)
push(`<circle cx="${dockX + dockW - 26}" cy="${composerY + 56}" r="13" fill="${app.accent}"/>`)
push(`<path d="M${dockX + dockW - 26} ${composerY + 62}v-11M${dockX + dockW - 31} ${composerY + 56}l5-5 5 5" fill="none" stroke="#ffffff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`)

push(`</g>`)
push(`<rect x="${X + 0.5}" y="${Y + 0.5}" width="${WW - 1}" height="${WH - 1}" rx="18" fill="none" stroke="#dfe5ee" filter="url(#frame-shadow)"/>`)
push(`</svg>`)

export function renderHero() {
  return `${parts.join('\n')}\n`
}

/** The committed figure path. */
export function heroPath() {
  return OUTPUT
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const svg = renderHero()
  if (process.argv.includes('--check')) {
    const committed = readFileSync(OUTPUT, 'utf8')
    if (committed.replaceAll('\r\n', '\n') !== svg) {
      console.error('docs/assets/readme/hero.svg is out of date — run: node scripts/readme-hero.mjs')
      process.exitCode = 1
    } else {
      console.log('docs/assets/readme/hero.svg is up to date')
    }
  } else {
    writeFileSync(OUTPUT, svg)
    console.log(`wrote ${OUTPUT}`)
  }
}
