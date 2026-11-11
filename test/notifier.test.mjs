import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createNotifier, isArchiveConfigured } from '../lib/notifier.js'
import { normalizeConfig } from '../lib/config.js'

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('start card is patched when the prompt and title arrive after the initial send', async () => {
  const handlers = {}
  const cards = []
  const patches = []
  let title = ''
  const session = {
    id: 's1',
    header: { cwd: '/tmp/project' },
    snapshotEvents: () => [],
  }
  const agent = { id: 's1', status: 'running', session }
  const ctx = {
    effect(fn) { return fn() },
    on(name, handler) { handlers[name] = handler; return () => {} },
    agents: { get: () => agent },
    sessionProjections: {
      snapshot: () => ({ values: { title } }),
    },
  }
  const transport = {
    sendCard: async (card) => { cards.push(card); return { messageId: 'om_start' } },
    patchCard: async (messageId, card) => { patches.push({ messageId, card }) },
    sendText: async () => ({ messageId: 'om_text' }),
  }
  const registry = {
    ensureCode: () => 'abcxyz',
    describe: async () => ({ title }),
    rememberLast: () => {},
    link: () => {},
  }
  const notifier = createNotifier({
    ctx,
    config: normalizeConfig({ notifySessionStart: true }),
    registry,
    transport,
    store: { pushLevel: () => 2 },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  const dispose = notifier.register()

  handlers['agent/status']({ agent, status: 'running' })
  await wait(900)
  assert.equal(cards.length, 1)
  assert.match(JSON.stringify(cards[0]), /没有新的用户输入/)

  title = '真实标题'
  handlers['session/event'](session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '实现功能' }] },
  })
  handlers['session/event'](session, { type: 'session/title', data: { title } })
  await wait(700)

  assert.ok(patches.length >= 1)
  const latest = JSON.stringify(patches.at(-1).card)
  assert.match(latest, /实现功能/)
  assert.match(latest, /真实标题/)
  dispose()
})


test('archive button config sees both profile and Lark-stored URLs', () => {
  assert.equal(isArchiveConfigured({ archiveParentUrl: '' }, { archiveParentUrl: () => 'https://example.feishu.cn/wiki/archive' }), true)
  assert.equal(isArchiveConfigured({ archiveParentUrl: 'https://example.feishu.cn/wiki/archive' }, undefined), true)
  assert.equal(isArchiveConfigured({ archiveParentUrl: '' }, { archiveParentUrl: () => '' }), false)
})
