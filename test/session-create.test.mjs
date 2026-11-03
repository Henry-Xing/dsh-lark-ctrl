import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  applySessionOptions,
  createSessionOnly,
  loadCreationOptions,
  parseModel,
  sendSessionPrompt,
} from '../lib/session-create.js'

test('model option values split provider and model', () => {
  assert.deepEqual(parseModel('deepseek-official::deepseek-flash'), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
  })
  assert.equal(parseModel('missing-separator'), undefined)
})

test('loadCreationOptions builds agent/model/permission options and defaults', async () => {
  const ctx = {
    get(name) {
      if (name === 'agentPresets') {
        return {
          defaultId: 'standard',
          list: async () => [
            { id: 'standard', name: 'Standard' },
            { id: 'broken', name: 'Broken', broken: 'no compose' },
          ],
        }
      }
      if (name === 'permissionPresets') {
        return {
          catalog: () => ({
            options: [{ value: 'safe', name: 'Safe', description: 'read only' }],
            defaultPreset: 'safe',
          }),
        }
      }
      return undefined
    },
    sessionController: {
      modelCatalog: async () => ({
        default: { provider: 'p', model: 'm', reasoningEffort: 'high' },
        groups: [{
          id: 'p',
          name: 'Provider',
          models: [{
            id: 'm',
            name: 'Model',
            reasoning: { defaultEffort: 'high', efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] },
          }],
        }],
      }),
    },
  }
  const options = await loadCreationOptions(ctx)
  assert.deepEqual(options.agentPresets, [{ value: 'standard', text: 'Standard', description: undefined }])
  assert.deepEqual(options.models, [{
    value: 'p::m',
    text: 'Provider · Model',
    provider: 'p',
    model: 'm',
    efforts: ['low', 'high'],
    defaultEffort: 'high',
  }])
  assert.deepEqual(options.efforts, [{ value: '', text: '默认（模型决定）' }, { value: 'low', text: 'Low' }, { value: 'high', text: 'High' }])
  assert.deepEqual(options.permissions, [{ value: 'safe', text: 'Safe', description: 'read only' }])
  assert.deepEqual(options.defaults, { agentPreset: 'standard', model: 'p::m', effort: 'high', permission: 'safe' })
})

test('create/apply/prompt run in the required order', async () => {
  const order = []
  const ctx = {
    get(name) {
      if (name === 'permissionPresets') {
        return { set: () => order.push('permission') }
      }
      return undefined
    },
    sessions: {
      get: () => ({ id: 's1', header: {}, projects: {} }),
    },
    sessionController: {
      create: async (request) => {
        order.push(['create', request])
        return { sessionId: 's1', agentPreset: request.agentPreset }
      },
      resolveAgent: async () => ({ agent: { session: { id: 's1' } } }),
      selectModel: async (request) => order.push(['model', request]),
      prompt: async (request) => order.push(['prompt', request]),
    },
  }

  const created = await createSessionOnly(ctx, { workspaceId: 'w1', agentPreset: 'standard' })
  assert.equal(created.sessionId, 's1')
  await applySessionOptions(ctx, 's1', { permission: 'safe', model: 'p::m', effort: 'high' })
  await sendSessionPrompt(ctx, 's1', 'hello', 'req-1')

  assert.deepEqual(order[0], ['create', { workspaceId: 'w1', agentPreset: 'standard' }])
  assert.deepEqual(order.slice(1), [
    'permission',
    ['model', { sessionId: 's1', provider: 'p', model: 'm', reasoningEffort: 'high' }],
    ['prompt', { requestId: 'req-1', sessionId: 's1', mode: 'queue', content: [{ type: 'text', text: 'hello' }] }],
  ])
})
