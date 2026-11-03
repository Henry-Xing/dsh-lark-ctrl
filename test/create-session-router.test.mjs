import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createRouter } from '../lib/router.js'
import { normalizeConfig } from '../lib/config.js'

test('session-create form creates, applies permission/model, sends prompt and patches the card', async () => {
  const order = []
  const links = new Map([
    ['om_create', { kind: 'session-create', sessionId: '', workspaceId: 'w1', requestId: 'req-1' }],
  ])
  const workspace = { id: 'w1', title: '测试工作区', path: '/tmp/work', sessionIds: [] }
  const transport = {
    isAllowed: () => true,
    sendCard: async () => ({ messageId: 'om_out' }),
    sendText: async (text) => { order.push(['text', text]); return { messageId: 'om_text' } },
    patchCard: async (messageId, card) => { order.push(['patch', messageId, card]) },
    react: async () => true,
  }
  const registry = {
    lookup: (id) => links.get(id),
    ensureCode: () => 'abcxyz',
    label: async () => '新会话',
    lastSession: () => undefined,
    resolveCode: async () => undefined,
    listSessions: async () => [],
    describe: async () => ({ title: 't' }),
    rememberLast: () => {},
    link: () => {},
  }
  const ctx = {
    get(name) {
      if (name === 'workspaceRegistry') return { get: () => workspace }
      if (name === 'permissionPresets') {
        return {
          catalog: () => ({ options: [{ value: 'safe', name: 'Safe' }], defaultPreset: 'safe' }),
          set: (session, name) => order.push(['permission', name]),
        }
      }
      return undefined
    },
    sessions: { get: () => ({ id: 's1' }) },
    sessionController: {
      create: async (request) => { order.push(['create', request]); return { sessionId: 's1', agentPreset: request.agentPreset } },
      resolveAgent: async () => ({ agent: { session: { id: 's1' } } }),
      modelCatalog: async () => ({
        default: { provider: 'p', model: 'm' },
        groups: [{
          id: 'p',
          name: 'Provider',
          models: [{ id: 'm', name: 'Model', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }],
        }],
      }),
      selectModel: async (request) => order.push(['model', request]),
      prompt: async (request) => order.push(['prompt', request]),
    },
    emit() {},
  }
  const store = {
    pushLevel: () => 2,
    setPushLevel: () => {},
    rememberEvent: () => false,
    linkMessage: (id, link) => links.set(id, link),
  }
  const router = createRouter({
    ctx,
    config: normalizeConfig({}),
    registry,
    transport,
    answerer: { promoteSuppressed: async () => 0, answerFromChoice: async () => ({ ok: true }), answerFromForm: async () => ({ ok: true }), answerApproval: async () => ({ ok: true }) },
    btw: { snapshot: async () => ({}) },
    store,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  await router.handleCardAction({
    event_id: 'e1',
    action_tag: 'button',
    message_id: 'om_create',
    operator_id: 'ou_me',
    form_value: JSON.stringify({
      agent_preset: 'standard',
      model: 'p::m',
      effort: 'high',
      permission: 'safe',
      prompt: '继续实现',
    }),
  })

  assert.deepEqual(order[0], ['create', { workspaceId: 'w1', agentPreset: 'standard' }])
  assert.deepEqual(order[1], ['permission', 'safe'])
  assert.deepEqual(order[2], ['model', { sessionId: 's1', provider: 'p', model: 'm', reasoningEffort: 'high' }])
  assert.deepEqual(order[3], ['prompt', { requestId: 'req-1', sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: '继续实现' }] }])
  assert.equal(order[4][0], 'patch')
  assert.match(JSON.stringify(order[4][2]), /abcxyz/)
  assert.equal(links.get('om_create').createdSessionId, 's1')
  assert.equal(links.get('om_create').promptSent, true)
})
