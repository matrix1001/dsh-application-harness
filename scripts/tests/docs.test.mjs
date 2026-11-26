/**
 * Script-plane tests for the documentation set (`node --test`, NOT vitest —
 * vitest collects `packages/∗/∗​/tests/**` only).
 *
 * What a green run proves, and what it does not: every local link resolves,
 * every anchor exists, every referenced script and command name exists, every
 * document is registered in the map, the type marker is present, and the prose
 * stays inside the budget recorded in `scripts/doc-budget.json`. It does NOT
 * prove that the facts are correct — a cited test can exist and the sentence
 * beside it can still be wrong. Facts stay a review responsibility.
 *
 * The budget is a ratchet: the number may only go down. Lower it in the same
 * change that shortens the prose, never to make a red run green.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { renderHero } from '../readme-hero.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DOCS = join(ROOT, 'docs')
const MAP = 'docs/README.md'
const BUDGET = JSON.parse(readFileSync(join(ROOT, 'scripts', 'doc-budget.json'), 'utf8'))

/** The type marker every document under `docs/` must carry. */
const MARKERS = {
  'docs/ARCHITECTURE.md': '> 类型：架构总览。',
  'docs/APPLICATION_DEVELOPMENT.md': '> 类型：任务指南。',
  'docs/DEVELOPMENT.md': '> 类型：操作手册。',
  'docs/START.md': '> 类型：上手教程。',
  'docs/REFERENCE.md': '> 类型：参考。',
  'docs/architecture/1-总体设计.md': '> 类型：目标设计。',
  'docs/architecture/2-统一JSON协议.md': '> 类型：目标设计。',
  'docs/architecture/3-权限与调用.md': '> 类型：目标设计。',
  'docs/architecture/4-应用结构与运行.md': '> 类型：目标设计。',
  'docs/architecture/5-平台能力.md': '> 类型：目标设计。',
  'docs/architecture/6-应用互联.md': '> 类型：目标设计。',
  'docs/architecture/7-页面与人机交互.md': '> 类型：目标设计。',
  'docs/architecture/8-会话接入.md': '> 类型：目标设计。',
  'docs/architecture/9-会话委托.md': '> 类型：目标设计。',
  'docs/architecture/10-应用开发支持.md': '> 类型：目标设计。',
  'docs/architecture/11-实现与验收.md': '> 类型：现状与验收。',
  'docs/architecture/12-开发安装与发布.md': '> 类型：目标设计。',
}

/** Aliases the vocabulary convention replaced; the old wording must not return. */
const BANNED_ALIASES = [/主对话/u, /应用区应用区/u, /代际\s*\d/u]

/** Files whose prose counts against the budget: everything a reader reads as prose. */
const DOC_FILES = ['README.md', 'AGENTS.md', ...readdirSync(DOCS).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`),
  ...readdirSync(join(DOCS, 'architecture')).filter((name) => name.endsWith('.md')).map((name) => `docs/architecture/${name}`)]

/** Every markdown file under `docs/`, recursively. */
function docsTree(dir = DOCS) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return docsTree(path)
    return entry.name.endsWith('.md') ? [relative(ROOT, path)] : []
  })
}

/** Every skill document under `skills/`, recursively. */
function skillTree() {
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return walk(path)
    return entry.name.endsWith('.md') ? [relative(ROOT, path)] : []
  })
  return walk(join(ROOT, 'skills'))
}

/** Every local markdown link, split into its file target and optional anchor. */
function localLinks(markdown) {
  const links = []
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const raw = match[1]
    if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) continue
    const hash = raw.indexOf('#')
    links.push({ target: hash === -1 ? raw : raw.slice(0, hash), fragment: hash === -1 ? '' : raw.slice(hash + 1) })
  }
  return links
}

/** GitHub-style heading slugs, including duplicate suffixes. */
function anchorsOf(markdown) {
  const withoutFences = markdown.replace(/```[\s\S]*?```/gu, '')
  const counts = new Map()
  const anchors = new Set()
  for (const match of withoutFences.matchAll(/^#{1,6}\s+(.+?)\s*$/gmu)) {
    const text = match[1]
      .replace(/<[^>]*>/gu, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/gu, '$1')
      .replace(/[`*_~]/gu, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, '')
      .trim()
      .replace(/\s+/gu, '-')
    if (text === '') continue
    const count = counts.get(text) ?? 0
    counts.set(text, count + 1)
    anchors.add(count === 0 ? text : `${text}-${count}`)
  }
  return anchors
}

/** Prose lines: outside fences, not headings, not table rows, longer than the budget. */
function proseLines(markdown) {
  const lines = []
  let fenced = false
  for (const line of markdown.split('\n')) {
    if (/^\s*```/u.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    const text = line.trim()
    if (text === '' || /^#/u.test(text) || /^\|/u.test(text)) continue
    lines.push(text.replace(/^> ?/u, ''))
  }
  return lines
}

/** The `pnpm …` and `node scripts/…` commands written inside fenced blocks. */
function fencedCommands(markdown) {
  return [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/gu)].flatMap(([, body]) => body.split('\n'))
}

const SCRIPTS = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {}

test('relative links in the documentation resolve', () => {
  for (const file of DOC_FILES) {
    const markdown = readFileSync(join(ROOT, file), 'utf8')
    const missing = localLinks(markdown)
      .filter((link) => link.target !== '' && !existsSync(resolve(ROOT, dirname(file), link.target)))
    assert.deepEqual(missing.map((link) => link.target), [], `${file} links a path that does not exist`)
  }
})

test('anchors in the documentation exist', () => {
  for (const file of DOC_FILES) {
    const markdown = readFileSync(join(ROOT, file), 'utf8')
    for (const link of localLinks(markdown)) {
      if (link.fragment === '') continue
      const target = link.target === '' ? join(ROOT, file) : resolve(ROOT, dirname(file), link.target)
      if (!existsSync(target) || !target.endsWith('.md')) continue
      const fragment = decodeURIComponent(link.fragment)
      assert.ok(anchorsOf(readFileSync(target, 'utf8')).has(fragment), `${file} links a missing anchor: ${link.target}#${fragment}`)
    }
  }
})

test('referenced scripts and package commands exist', () => {
  for (const file of DOC_FILES) {
    const markdown = readFileSync(join(ROOT, file), 'utf8')
    for (const match of markdown.matchAll(/scripts\/[\w./-]+\.mjs/gu)) {
      assert.ok(existsSync(join(ROOT, match[0])), `${file} references a missing script: ${match[0]}`)
    }
    for (const line of fencedCommands(markdown)) {
      for (const match of line.matchAll(/\bpnpm run ([\w:-]+)/gu)) {
        assert.ok(Object.hasOwn(SCRIPTS, match[1]), `${file} references a missing package script: ${match[1]}`)
      }
    }
  }
})

test('skill documents link and name existing files and commands', () => {
  for (const file of skillTree()) {
    const markdown = readFileSync(join(ROOT, file), 'utf8')
    for (const link of localLinks(markdown)) {
      if (link.target === '') continue
      const target = resolve(ROOT, dirname(file), link.target)
      assert.ok(existsSync(target), `${file} links a path that does not exist: ${link.target}`)
      if (link.fragment !== '' && target.endsWith('.md')) {
        assert.ok(anchorsOf(readFileSync(target, 'utf8')).has(decodeURIComponent(link.fragment)), `${file} links a missing anchor: ${link.target}#${link.fragment}`)
      }
    }
    for (const match of markdown.matchAll(/scripts\/[\w./-]+\.mjs/gu)) {
      assert.ok(existsSync(join(ROOT, match[0])), `${file} references a missing script: ${match[0]}`)
    }
    for (const match of markdown.matchAll(/\bpnpm run ([\w:-]+)/gu)) {
      assert.ok(Object.hasOwn(SCRIPTS, match[1]), `${file} references a missing package script: ${match[1]}`)
    }
  }
})

test('every document is registered in the map, and the map only lists documents that exist', () => {
  const map = readFileSync(join(ROOT, MAP), 'utf8')
  const listed = new Set(localLinks(map)
    .filter((link) => link.target.endsWith('.md'))
    .map((link) => relative(ROOT, resolve(ROOT, DOCS, link.target))))
  for (const path of docsTree()) {
    if (path === MAP) continue
    assert.ok(listed.has(path), `${path} is not registered in ${MAP}`)
  }
  for (const path of listed) {
    assert.ok(existsSync(join(ROOT, path)), `${MAP} lists a document that does not exist: ${path}`)
  }
})

test('documents carry their type marker', () => {
  for (const [file, marker] of Object.entries(MARKERS)) {
    const head = readFileSync(join(ROOT, file), 'utf8').split('\n').slice(0, 8).join('\n')
    assert.ok(head.includes(marker), `${file} is missing its type marker: ${marker}`)
  }
})

test('no conflict markers or replaced vocabulary remain', () => {
  for (const file of DOC_FILES) {
    const markdown = readFileSync(join(ROOT, file), 'utf8')
    assert.ok(!/^(<{7}|>{7}) /mu.test(markdown), `${file} contains a merge conflict marker`)
    for (const alias of BANNED_ALIASES) {
      assert.ok(!alias.test(markdown), `${file} uses replaced vocabulary: ${String(alias)}`)
    }
  }
})

test('the current-state table carries no drifting counts or version numbers', (t) => {
  const markdown = readFileSync(join(ROOT, 'docs/architecture/11-实现与验收.md'), 'utf8')
  const start = markdown.indexOf('## 5. 当前未完成与边界')
  const rest = markdown.slice(start + 1)
  const next = rest.search(/\n#{2,3} /u)
  const section = next === -1 ? markdown.slice(start) : markdown.slice(start, start + 1 + next)
  const table = section.split('\n').filter((line) => line.startsWith('|'))
  const drifting = table.filter((line) => /\d+\s*个/u.test(line) || /上限\s*\d+/u.test(line) || /v\d+\.\d+\.\d+/u.test(line))
  assert.deepEqual(drifting, [], 'the current-state table records a count or version that will drift')
  t.diagnostic(`current-state table rows: ${table.length - 2}`)
})

test('prose stays inside the ratchet budget', (t) => {
  const offenders = []
  let total = 0
  for (const file of DOC_FILES) {
    const long = proseLines(readFileSync(join(ROOT, file), 'utf8')).filter((line) => line.length > BUDGET.proseLineLimit)
    if (long.length === 0) continue
    total += long.length
    offenders.push(...long.map((line) => `${file}: ${line.slice(0, 60)}… (${line.length})`))
  }
  t.diagnostic(`long prose lines: ${total} (budget ${BUDGET.longProseLines})`)
  assert.ok(total <= BUDGET.longProseLines, `prose budget exceeded by ${total - BUDGET.longProseLines}:\n${offenders.join('\n')}`)
})

test('the README hero figure is the generator output', () => {
  const committed = readFileSync(join(ROOT, 'docs/assets/readme/hero.svg'), 'utf8')
  assert.equal(committed.replaceAll('\r\n', '\n'), renderHero(), 'docs/assets/readme/hero.svg is generated — edit scripts/readme-hero.mjs and rerun it')
})
