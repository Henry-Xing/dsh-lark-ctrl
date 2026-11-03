import assert from 'node:assert/strict'
import { test } from 'node:test'

import { applySessionConfig, readSessionConfig } from '../lib/session-config.js'

function fakeContext() {
  const calls = []
  const session = { id: 's1' }
  const ctx = {
    sessions: { get: () => session },
    sessionProjections: {
      snapshot: () => ({
        values: {
          modelSelection: { next: { provider: 'p', model: 'm', reasoningEffort: 'high' } },
          permissions: { currentValue: 'safe' },
          agentPreset: 'standard',
        },
      }),
    },
    get(name) {
      if (name === 'permissionPresets') {
        return {
          current: () => 'safe',
          set: (target, preset) => calls.push(['permission', target.id, preset]),
        }
      }
      return undefined
    },
    sessionController: {
      selectModel: async (request) => calls.push(['model', request]),
      resolveAgent: async () => ({ agent: { session } }),
    },
  }
  return { ctx, session, calls }
}

test('readSessionConfig reads mode, model, thinking effort and permission from projections', async () => {
  const { ctx } = fakeContext()
  const config = await readSessionConfig(ctx, 's1')
  assert.equal(config.modelValue, 'p::m')
  assert.equal(config.effort, 'high')
  assert.equal(config.permission, 'safe')
  assert.equal(config.agentPreset, 'standard')
  assert.equal(config.session.id, 's1')
})

test('applySessionConfig writes permission then model/effort', async () => {
  const { ctx, session, calls } = fakeContext()
  const result = await applySessionConfig(ctx, 's1', { permission: 'safe', model: 'p::m', effort: 'high' })
  assert.equal(result, session)
  assert.deepEqual(calls, [
    ['permission', 's1', 'safe'],
    ['model', { sessionId: 's1', provider: 'p', model: 'm', reasoningEffort: 'high' }],
  ])
})

test('applySessionConfig rejects an effort without a model', async () => {
  const { ctx } = fakeContext()
  await assert.rejects(
    () => applySessionConfig(ctx, 's1', { effort: 'high' }),
    /选择 Thinking effort/,
  )
})
