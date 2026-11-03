import assert from 'node:assert/strict'
import { test } from 'node:test'

import { findHelpTopic, helpTopics } from '../lib/help.js'

test('help topics resolve commands, aliases and arguments', () => {
  assert.equal(findHelpTopic('/sessions').id, 'sessions')
  assert.equal(findHelpTopic('sessions').id, 'sessions')
  assert.equal(findHelpTopic('/sessions 1d').id, 'sessions')
  assert.equal(findHelpTopic('/push').id, 'level')
  assert.equal(findHelpTopic('/level 2').id, 'level')
  assert.equal(findHelpTopic('/workspace-create').id, 'workspace-create')
  assert.equal(findHelpTopic('#code').id, 'hash')
  assert.equal(findHelpTopic('/help').id, 'help')
  assert.equal(findHelpTopic('/does-not-exist'), undefined)
  assert.equal(findHelpTopic(''), undefined)
})

test('every help topic has usage, examples and a summary', () => {
  assert.ok(helpTopics().length >= 8)
  for (const topic of helpTopics()) {
    assert.equal(typeof topic.command, 'string')
    assert.ok(topic.command.startsWith('/') || topic.command.startsWith('#'))
    assert.equal(typeof topic.summary, 'string')
    assert.ok(Array.isArray(topic.usage) && topic.usage.length > 0)
    assert.ok(Array.isArray(topic.examples) && topic.examples.length > 0)
    for (const example of topic.examples) {
      assert.equal(typeof example.command, 'string')
      assert.equal(typeof example.note, 'string')
    }
  }
})
