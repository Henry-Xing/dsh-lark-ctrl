import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { createStore } from '../lib/store.js'
import { normalizeConfig } from '../lib/config.js'

const logger = { info: () => {}, warn: () => {}, debug: () => {} }

test('push level persists and defaults to the configured level', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-ctrl-store-'))
  try {
    const config = normalizeConfig({ storeDir: root, defaultPushLevel: 1 })
    const store = createStore(config, logger)
    await store.load()
    assert.equal(store.pushLevel(), 1)
    store.setPushLevel(0)
    await store.flush()

    const next = createStore(config, logger)
    await next.load()
    assert.equal(next.pushLevel(), 0)
    await next.dispose()

    store.setPushLevel(2)
    await store.dispose()
    const third = createStore(config, logger)
    await third.load()
    assert.equal(third.pushLevel(), 2)
    await third.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('creation links keep workspace and idempotency fields across reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-ctrl-store-'))
  try {
    const config = normalizeConfig({ storeDir: root })
    const store = createStore(config, logger)
    await store.load()
    store.linkMessage('om_card', {
      kind: 'session-create',
      sessionId: '',
      workspaceId: 'w1',
      requestId: 'req-1',
      createdSessionId: 's1',
      promptSent: true,
    })
    await store.flush()

    const next = createStore(config, logger)
    await next.load()
    const link = next.lookupMessage('om_card')
    assert.equal(link.workspaceId, 'w1')
    assert.equal(link.requestId, 'req-1')
    assert.equal(link.createdSessionId, 's1')
    assert.equal(link.promptSent, true)
    await next.dispose()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
