import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createAnswerer } from '../lib/answerer.js'
import { normalizeConfig } from '../lib/config.js'

function harness() {
  let level = 0
  const listeners = {}
  const cards = []
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
    patchCard: async () => {},
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
