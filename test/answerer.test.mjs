import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAnswerer } from '../lib/answerer.js'
import { normalizeConfig } from '../lib/config.js'

function harness() {
  let level = 0
  const listeners = {}
  const cards = []
  const patches = []
  const links = new Map()
  const disposers = []

  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    on(name, handler) {
      listeners[name] = handler
      return () => { delete listeners[name] }
    },
    get(name) {
      if (name === 'typertGateway') return { hasLiveClient: () => true }
      return undefined
    },
    emit() {},
    sessions: { get: () => undefined },
    sessionController: {
      resolveAgent: async () => ({ agent: { session: { id: 'session-1' } } }),
    },
  }

  const transport = {
    isAllowed: () => true,
    sendCard: async (card) => { cards.push(card); return { messageId: 'om_question' } },
    patchCard: async (messageId, card) => { patches.push({ messageId, card }) },
    sendText: async () => {},
    react: async () => true,
  }

  const registry = {
    ensureCode: () => 'abcxyz',
    label: async () => '测试会话',
    link(sessionId, messageId, link) { links.set(messageId, { ...link, sessionId }) },
    lookup: (messageId) => links.get(messageId),
  }

  const store = {
    pushLevel: () => level,
    setPushLevel: (next) => { level = next },
  }

  const answerer = createAnswerer({
    ctx,
    config: normalizeConfig({ answerMode: 'race' }),
    registry,
    transport,
    store,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  answerer.register()
  return {
    answerer,
    cards,
    patches,
    listeners,
    dispose() {
      for (const disposer of disposers) disposer()
    },
    setLevel(next) { level = next },
  }
}

test('L0 buffers a question, then promotion publishes it and a Lark answer resolves the request', async () => {
  const { answerer, cards, listeners, dispose, setLevel } = harness()
  try {
    const request = {
      agent: { id: 'session-1' },
      questions: [{
        id: 'q1',
        question: '继续吗？',
        options: [{ label: '继续' }, { label: '停止' }],
      }],
      wait: { callId: 'call-1' },
      signal: new AbortController().signal,
    }
    let resolveWeb
    const web = new Promise((resolve) => { resolveWeb = resolve })
    const listener = listeners['user-questions/request']
    assert.equal(typeof listener, 'function')
    const pending = listener(request, () => web)

    // L0: no card, but the request is buffered and Web still receives it via next().
    assert.equal(cards.length, 0)

    setLevel(1)
    const promoted = await answerer.promoteSuppressed()
    assert.equal(promoted, 1)
    assert.equal(cards.length, 1)
    assert.match(JSON.stringify(cards[0]), /需要你的确认/)

    const result = await answerer.answerFromChoice('om_question', { qid: 'q1', label: '继续' }, 'ou_me')
    assert.equal(result.ok, true)
    const answer = await pending
    assert.deepEqual(answer.answers, [{ id: 'q1', selected: ['继续'] }])
    resolveWeb?.({ answers: [] })
  } finally {
    dispose()
  }
})


test('approval card includes the exact command and retains it after a Lark decision', async () => {
  const { answerer, cards, patches, listeners, dispose, setLevel } = harness()
  try {
    setLevel(1)
    const session = {
      id: 'session-1',
      snapshotEvents: () => [{
        type: 'tool/call',
        data: {
          callId: 'call-1',
          name: 'bash',
          arguments: JSON.stringify({
            command: 'rm -rf /tmp/demo',
            justification: 'cleanup the test directory',
          }),
        },
      }],
    }
    const agent = { id: 'session-1', session }
    const request = {
      agent,
      toolName: 'bash',
      callId: 'call-1',
      reason: '需要提升沙箱权限',
      signal: new AbortController().signal,
    }
    const pending = listeners['approval/request'](request, () => new Promise(() => {}))
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(cards.length, 1)
    assert.match(JSON.stringify(cards[0]), /rm -rf \/tmp\/demo/)
    assert.match(JSON.stringify(cards[0]), /将要执行的命令/)

    const result = await answerer.answerApproval('session-1:call-1', 'allow', 'ou_me')
    assert.equal(result.ok, true)
    assert.equal(await pending, 'allowed-once')
    assert.ok(patches.length >= 1)
    const resolved = JSON.stringify(patches.at(-1).card)
    assert.match(resolved, /已允许/)
    assert.match(resolved, /rm -rf \/tmp\/demo/)
    assert.match(resolved, /需要提升沙箱权限/)
    assert.match(resolved, /处理来源：飞书/)
  } finally {
    dispose()
  }
})
