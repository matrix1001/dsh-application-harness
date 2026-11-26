#!/usr/bin/env node
/**
 * Validate the repository's own skill directories: frontmatter identity,
 * bounded SKILL.md size, and resolvable local links in the skill and its
 * references. Skills are repository artifacts; nothing is installed.
 * @module scripts/check-skills
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(ROOT, 'skills')
const MAX_SKILL_BYTES = 8192

/** Local, non-anchor markdown links in one document. */
function localLinks(text) {
  return [...text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)]
    .map(match => match[1])
    .filter(target => !/^(?:https?:|#|mailto:)/u.test(target))
    .map(target => target.split('#')[0])
    .filter(target => target !== '')
}

/** Validate one skill directory. */
function checkSkill(dir) {
  const name = dir.split('/').at(-1)
  const skillPath = join(dir, 'SKILL.md')
  const problems = []
  if (!existsSync(skillPath)) return [`${relative(ROOT, skillPath)} is missing`]
  const text = readFileSync(skillPath, 'utf8')
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES) problems.push(`${relative(ROOT, skillPath)} exceeds ${String(MAX_SKILL_BYTES)} bytes`)
  const front = /^---\n([\s\S]*?)\n---/u.exec(text)
  if (front === null) problems.push(`${relative(ROOT, skillPath)} has no frontmatter`)
  else {
    const declared = /^name:\s*(\S+)/mu.exec(front[1])?.[1]
    if (declared !== name) problems.push(`${relative(ROOT, skillPath)} name ${String(declared)} does not match ${name}`)
    if (!/^description:\s*\S+/mu.test(front[1])) problems.push(`${relative(ROOT, skillPath)} has no description`)
  }
  for (const target of localLinks(text)) {
    const path = resolve(dir, target)
    if (!existsSync(path)) problems.push(`${relative(ROOT, skillPath)} links to missing ${target}`)
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'templates') continue
    const sub = join(dir, entry.name)
    for (const file of readdirSync(sub)) {
      if (!file.endsWith('.md')) continue
      const path = join(sub, file)
      for (const target of localLinks(readFileSync(path, 'utf8'))) {
        if (!existsSync(resolve(sub, target))) problems.push(`${relative(ROOT, path)} links to missing ${target}`)
      }
    }
  }
  return problems
}

function main() {
  if (!existsSync(SKILLS)) { console.log('check-skills: no skills/ directory'); return }
  const dirs = readdirSync(SKILLS, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => join(SKILLS, entry.name))
    .filter(dir => statSync(dir).isDirectory())
  const problems = dirs.flatMap(checkSkill)
  console.log(`check-skills: ${String(dirs.length)} skill(s) checked`)
  if (problems.length === 0) return
  console.error(`check-skills: FAIL — ${String(problems.length)} problem(s)`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}

main()
