import assert from 'node:assert/strict'
import { test } from 'node:test'

import { createBtw } from '../lib/btw.js'
import { normalizeConfig } from '../lib/config.js'

test('btw dispatches shared fetch with an owner Peer (DSH 0.2.1 API)', async () => {
  const peer = { id: 'peer-test', principal: { kind: 'owner' }, interactions: 'none' }
  const peerCalls = []
  const fetchCalls = []
  const connection = {
    createPeer(options) {
      peerCalls.push(options)
      return peer
    },
    createSharedFetchHandler(channel) {
      assert.equal(channel, '/api')
      return {
        fetch: async (request, dispatchedPeer) => {
          // Simulate the 0.2.1-rc.5 handler, which dereferences peer.principal.
          if (dispatchedPeer?.principal?.kind !== 'owner') {
            throw new TypeError("Cannot read properties of undefined (reading 'principal')")
          }
          fetchCalls.push({ request, peer: dispatchedPeer })
          return new Response(JSON.stringify({ contextChars: 48000 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        },
      }
    },
  }
  const ctx = {
    get: (name) => (name === 'connection' ? connection : undefined),
  }
  const btw = createBtw({
    ctx,
    config: normalizeConfig({ btwMode: 'auto' }),
    registry: {},
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })

  const first = await btw.checkAvailable(true)
  const second = await btw.checkAvailable(true)
  assert.equal(first.available, true)
  assert.equal(second.available, true)
  assert.equal(peerCalls.length, 1)
  assert.deepEqual(peerCalls[0], { principal: { kind: 'owner' }, interactions: 'none' })
  assert.equal(fetchCalls.length, 2)
  assert.equal(fetchCalls[0].peer, peer)
  assert.equal(fetchCalls[0].request.method, 'GET')
  assert.match(fetchCalls[0].request.url, /\/api\/btw\.meta$/)
})
