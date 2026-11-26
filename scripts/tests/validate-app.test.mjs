import assert from 'node:assert/strict'
import { test } from 'node:test'
import { resolve } from 'node:path'
import { parseValidateArgs, validationPaths, webUrlOf } from '../validate-app.mjs'

test('parseValidateArgs accepts the isolated validation flags', () => {
  assert.deepEqual(parseValidateArgs(['--app', 'notes', '--port', '3200', '--keep']), {
    app: 'notes', port: 3200, keep: true, help: false,
  })
  assert.equal(parseValidateArgs(['--app', 'notes', '--root', 'tmp/x']).root, resolve('tmp/x'))
  assert.equal(parseValidateArgs(['--help']).help, true)
})

test('parseValidateArgs rejects missing or malformed values', () => {
  assert.throws(() => parseValidateArgs(['--app']), /needs a value/u)
  assert.throws(() => parseValidateArgs(['--app', 'Notes']), /stable application id/u)
  assert.throws(() => parseValidateArgs(['--app', 'notes', '--port', 'x']), /integer/u)
  assert.throws(() => parseValidateArgs(['--app', 'notes', '--port', '-1']), /integer/u)
  assert.throws(() => parseValidateArgs(['--app', 'notes', '--other']), /unknown argument/u)
})

test('webUrlOf extracts the listening URL and ignores other lines', () => {
  assert.equal(webUrlOf('dsh web: http://127.0.0.1:3200/?token=x'), 'http://127.0.0.1:3200/?token=x')
  assert.equal(webUrlOf('starting'), undefined)
})

test('validationPaths stays under the configured root', () => {
  const paths = validationPaths('/srv/root', 'notes')
  assert.equal(paths.base, '/srv/root/validation-notes')
  assert.equal(paths.home, '/srv/root/validation-notes/home')
  assert.equal(paths.workspace, '/srv/root/validation-notes/workspace')
})
