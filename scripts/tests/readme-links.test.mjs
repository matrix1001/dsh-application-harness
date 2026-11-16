import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Every local markdown target (anchors and URLs are not files). */
function localTargets(markdown) {
  const targets = []
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split('#')[0]
    if (target === '' || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue
    targets.push(target)
  }
  return targets
}

test('relative links in the project and design documents point at real files', () => {
  const files = [
    'README.md', 'AGENTS.md', 'docs/ARCHITECTURE.md', 'docs/APPLICATION_DEVELOPMENT.md', 'docs/README.md',
    ...readdirSync(join(ROOT, 'docs/architecture')).filter(name => name.endsWith('.md')).map(name => `docs/architecture/${name}`),
  ]
  for (const file of files) {
    const markdown = readFileSync(join(ROOT, file), 'utf8')
    const missing = localTargets(markdown).filter(target => !existsSync(resolve(ROOT, dirname(file), target)))
    assert.deepEqual(missing, [], `${file} links a path that does not exist`)
  }
})

test('the package map and API reference stay visible', () => {
  const markdown = readFileSync(join(ROOT, 'README.md'), 'utf8')
  for (const target of ['AGENTS.md', 'docs/ARCHITECTURE.md', 'docs/APPLICATION_DEVELOPMENT.md']) {
    assert.ok(markdown.includes(target), `README no longer points at ${target}`)
  }
  const guide = readFileSync(join(ROOT, 'docs/APPLICATION_DEVELOPMENT.md'), 'utf8')
  for (const target of ['../packages/application/runtime/src/index.ts', '../packages/application/store/src/index.ts', '../scripts/api-snapshot.json']) {
    assert.ok(guide.includes(target), `application guide no longer points at ${target}`)
  }
})
