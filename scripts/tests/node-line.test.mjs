/**
 * Script-plane tests for the Node-line gate (`node --test`, NOT vitest —
 * vitest collects `packages/star/star/tests/star` only).
 *
 * The checked-in tree can only exhibit the in-sync case. Every drift rule is
 * exercised on a fixture: the running process, `engines.node`, `.nvmrc`, a
 * workflow pin, and the user-facing docs each have to follow the installed
 * platform manifest.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { verify } from '../verify-node-line.mjs'

const RANGE = '^24.22.3 || >=26.13.1'

/** Write one file, creating its directory. */
function put(root, file, text) {
  const path = join(root, file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

/** A fixture root that satisfies the gate as declared. */
function fixture(body) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-node-line-'))
  try {
    put(root, 'package.json', JSON.stringify({ engines: { node: RANGE } }))
    put(root, '.nvmrc', '24.22.3\n')
    put(root, '.github/workflows/ci.yml', '          node-version-file: .nvmrc\n')
    put(root, 'README.md', `Node.js \`${RANGE}\`\n`)
    put(root, 'docs/START.md', `| Node.js | \`${RANGE}\` |\n`)
    put(root, 'node_modules/@deepseek-ai/dsh/package.json', JSON.stringify({ engines: { node: RANGE } }))
    return body(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

/** Run the gate quietly and return its exit code. */
function run(root, nodeVersion = '24.22.3') {
  return verify({ root, nodeVersion, log: () => {}, error: () => {} })
}

test('accepts a tree where every Node fact follows the installed platform', () => {
  fixture((root) => assert.equal(run(root), 0))
})

test('refuses the running process below the platform floor', () => {
  fixture((root) => assert.equal(run(root, '24.19.0'), 1))
})

test('refuses a root engines value that drifted from the platform range', () => {
  fixture((root) => {
    put(root, 'package.json', JSON.stringify({ engines: { node: '>=24.9.0' } }))
    assert.equal(run(root), 1)
  })
})

test('refuses an .nvmrc that does not satisfy the range', () => {
  fixture((root) => {
    put(root, '.nvmrc', '24.9.0\n')
    assert.equal(run(root), 1)
  })
})

test('refuses a workflow pin that does not satisfy the range', () => {
  fixture((root) => {
    put(root, '.github/workflows/ci.yml', '          node-version: 24.9.0\n')
    assert.equal(run(root), 1)
  })
})

test('refuses docs that never name the range', () => {
  fixture((root) => {
    put(root, 'docs/START.md', '| Node.js | any |\n')
    assert.equal(run(root), 1)
  })
})
