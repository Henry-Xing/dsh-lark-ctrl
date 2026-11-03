import assert from 'node:assert/strict'
import { test } from 'node:test'

import { foldTurnStats, summarizeRun, reasonTextOf, errorMessageOf, isErrorReason } from '../lib/summary.js'

const events = [
  { type: 'turn/start', seq: 1, time: 1000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: 1100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '清理文件' }] } },
  { type: 'request/header', seq: 3, time: 1200, data: { header: { config: { model: 'deepseek-flash' } } } },
  { type: 'tool/call', seq: 4, time: 1300, data: { name: 'bash' } },
  { type: 'tool/call', seq: 5, time: 1400, data: { name: 'read' } },
  { type: 'assistant/message', seq: 6, time: 1500, data: { message: { content: [{ type: 'text', text: '已完成清理。' }] }, usage: { inputTokens: 100, outputTokens: 20 } } },
  { type: 'turn/end', seq: 7, time: 2500, data: { turn: 1, reason: { kind: 'completed' } } },
]

test('foldTurnStats collects the last turn', () => {
  const stats = foldTurnStats(events)
  assert.equal(stats.turn, 1)
  assert.equal(stats.startedAt, 1000)
  assert.equal(stats.endedAt, 2500)
  assert.equal(stats.userText, '清理文件')
  assert.equal(stats.assistantText, '已完成清理。')
  assert.equal(stats.toolCalls, 2)
  assert.deepEqual(stats.toolNames, ['bash', 'read'])
  assert.deepEqual(stats.usage, { inputTokens: 100, outputTokens: 20 })
  assert.equal(stats.model, 'deepseek-flash')
  assert.equal(stats.reason.kind, 'completed')
})

test('summarizeRun prefers the in-memory run and falls back to the log', () => {
  const session = {
    header: { cwd: '/tmp/cleanup' },
    snapshotEvents: () => events,
  }
  const summary = summarizeRun({
    session,
    title: '清理',
    run: {
      startedAt: 1000,
      userText: '',
      assistantText: '',
      toolCalls: 0,
      toolNames: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      reason: undefined,
      model: '',
    },
    maxChars: 1000,
    now: 3500,
  })
  assert.equal(summary.title, '清理')
  assert.equal(summary.durationText, '2s')
  assert.equal(summary.toolCalls, 2)
  assert.equal(summary.assistantText, '已完成清理。')
  assert.equal(summary.model, 'deepseek-flash')
  assert.equal(summary.cwd, '/tmp/cleanup')
})

test('reason helpers', () => {
  assert.equal(reasonTextOf({ kind: 'completed' }), '已完成')
  assert.equal(reasonTextOf({ kind: 'aborted' }), '已停止')
  assert.equal(reasonTextOf({ kind: 'error', error: { message: 'boom' } }), '失败')
  assert.equal(errorMessageOf({ kind: 'error', error: { message: 'boom' } }), 'boom')
  assert.equal(isErrorReason({ kind: 'error', error: {} }), true)
  assert.equal(isErrorReason({ kind: 'completed' }), false)
})

test('summarizeRun strips images before truncation and flags them', () => {
  const longImage = `![截图](data:image/png;base64,${'A'.repeat(5000)})`
  const summary = summarizeRun({
    session: { header: {}, snapshotEvents: () => [] },
    title: '图片',
    run: {
      startedAt: 1000,
      userText: '帮我看图',
      assistantText: `完成。${longImage}然后结束。`,
      toolCalls: 0,
      toolNames: [],
      usage: { inputTokens: 0, outputTokens: 0 },
      reason: { kind: 'completed' },
      model: 'm',
    },
    maxChars: 1000,
    now: 2000,
  })
  assert.equal(summary.imagesOmitted, true)
  assert.match(summary.assistantText, /（图片已省略）/)
  assert.doesNotMatch(summary.assistantText, /!\[/)
  assert.match(summary.userText, /帮我看图/)
})
