import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeConfig } from '../lib/config.js'

test('defaults are stable', () => {
  const config = normalizeConfig(undefined)
  assert.equal(config.larkCli, 'lark-cli')
  assert.equal(config.identity, 'bot')
  assert.equal(config.answerMode, 'race')
  assert.equal(config.approvalMode, 'always')
  assert.equal(config.btwMode, 'auto')
  assert.equal(config.defaultTarget, 'last')
  assert.equal(config.idleGraceMs, 3000)
  assert.deepEqual(config.allowUsers, [])
  assert.deepEqual(config.warnings, [])
})

test('invalid enums fall back with warnings', () => {
  const config = normalizeConfig({ answerMode: 'nope', approvalMode: 'x', btwMode: 'y', defaultTarget: 'z' })
  assert.equal(config.answerMode, 'race')
  assert.equal(config.approvalMode, 'always')
  assert.equal(config.btwMode, 'auto')
  assert.equal(config.defaultTarget, 'last')
  assert.equal(config.warnings.length, 4)
})

test('allowUsers only keeps open_ids and deduplicates', () => {
  const config = normalizeConfig({ allowUsers: ['ou_a', 'ou_a', 'not-an-id', 3] })
  assert.deepEqual(config.allowUsers, ['ou_a'])
})

test('numeric bounds are clamped', () => {
  const config = normalizeConfig({ summaryMaxChars: 1, idleGraceMs: 999999, btwTimeoutMs: 1 })
  assert.equal(config.summaryMaxChars, 200)
  assert.equal(config.idleGraceMs, 30000)
  assert.equal(config.btwTimeoutMs, 5000)
})
