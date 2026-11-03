import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  createWorkspace,
  listGroups,
  normalizeAbsolutePath,
} from '../lib/workspaces.js'

const now = Date.now()

function fakeContext({ workspaces, sessions, existing } = {}) {
  const workspaceList = workspaces ?? []
  const registry = {
    list: () => workspaceList,
    get: (id) => workspaceList.find((workspace) => workspace.id === id),
    archivedSessionIds: [],
    resolveByPath: async (path) => existing?.(path),
    create: async (path, title) => ({ id: 'created', path, title: title ?? 'created' }),
  }
  return {
    get: (name) => (name === 'workspaceRegistry' ? registry : undefined),
    sessionController: {
      list: async () => ({ items: sessions ?? [] }),
    },
    registry,
  }
}

function summary(sessionId, updatedAt, extra = {}) {
  return {
    sessionId,
    updatedAt,
    running: false,
    origin: undefined,
    projections: { values: { title: `title-${sessionId}` } },
    ...extra,
  }
}

test('absolute paths normalize ~ and reject relative paths', () => {
  assert.equal(normalizeAbsolutePath('/tmp/x'), '/tmp/x')
  assert.match(normalizeAbsolutePath('~/x'), /\/x$/)
  assert.equal(normalizeAbsolutePath('relative/path'), undefined)
  assert.equal(normalizeAbsolutePath(''), undefined)
})

test('listGroups filters by time, hides empty groups, and separates ungrouped sessions', async () => {
  const workspace = {
    id: 'w1',
    title: 'One',
    path: '/tmp/one',
    sessionIds: ['s1', 's2', 's3'],
    status: async () => 'ok',
  }
  const empty = {
    id: 'w2',
    title: 'Empty',
    path: '/tmp/two',
    sessionIds: [],
    status: async () => 'missing-dir',
  }
  const ctx = fakeContext({
    workspaces: [workspace, empty],
    sessions: [
      summary('s1', now),
      summary('s2', now - 2 * 24 * 60 * 60 * 1000),
      summary('s3', now, { origin: 'subagent' }),
      summary('s4', now),
    ],
  })
  const data = await listGroups(ctx, {
    timeRangeMs: 24 * 60 * 60 * 1000,
    maxWorkspaces: 10,
    maxWorkspaceSessions: 20,
  })
  assert.equal(data.groups.length, 1)
  assert.deepEqual(data.groups[0].sessions.map((item) => item.sessionId), ['s1'])
  assert.equal(data.groups[0].workspace.missingDir, false)
  assert.deepEqual(data.ungrouped.map((item) => item.sessionId), ['s4'])
})

test('listGroups shows empty workspaces without a time filter', async () => {
  const ctx = fakeContext({
    workspaces: [{ id: 'w1', title: 'Empty', path: '/tmp/one', sessionIds: [], status: async () => 'ok' }],
    sessions: [],
  })
  const data = await listGroups(ctx, { maxWorkspaces: 10, maxWorkspaceSessions: 20 })
  assert.equal(data.groups.length, 1)
  assert.equal(data.groups[0].sessions.length, 0)
})

test('createWorkspace mkdirs a missing directory and reuses an existing registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lark-ctrl-ws-'))
  const missing = join(root, 'a', 'b')
  const ctx = fakeContext({ workspaces: [], sessions: [] })
  ctx.registry.resolveByPath = async () => {
    throw new Error('missing')
  }
  const created = await createWorkspace(ctx, missing, 'AB')
  assert.equal(created.created, true)
  assert.equal(created.workspace.path, missing)
  assert.equal((await stat(missing)).isDirectory(), true)

  const existing = { id: 'existing', path: missing, title: 'AB', sessionIds: [] }
  ctx.registry.resolveByPath = async () => existing
  const again = await createWorkspace(ctx, missing, '')
  assert.equal(again.created, false)
  assert.equal(again.workspace.id, 'existing')
  await rm(root, { recursive: true, force: true })
})

test('createWorkspace rejects relative paths without touching the registry', async () => {
  const ctx = fakeContext({ workspaces: [], sessions: [] })
  await assert.rejects(() => createWorkspace(ctx, 'relative/path'), /绝对路径/)
})
