/**
 * Workspace grouping and creation over `ctx.workspaceRegistry`.
 *
 * The registry is an optional Host capability: profiles without a workspace
 * surface keep the plugin active, but `/workspaces` and workspace-scoped
 * session creation report that it is unavailable.
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve } from 'node:path'

import { truncate } from './util.js'

export class WorkspaceUnavailableError extends Error {
  constructor() {
    super('当前部署未启用 workspace（ctx.workspaceRegistry 不可用）')
    this.name = 'WorkspaceUnavailableError'
    this.code = 'workspace-unavailable'
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {any}
 */
export function requireRegistry(ctx) {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined) throw new WorkspaceUnavailableError()
  return registry
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id
 */
export function findWorkspace(ctx, id) {
  return requireRegistry(ctx).get(id)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} options
 * @param {number} [options.timeRangeMs]
 * @param {boolean} [options.includeSubagents]
 * @param {number} [options.maxWorkspaces]
 * @param {number} [options.maxWorkspaceSessions]
 * @returns {Promise<{ groups: Array<{ workspace: any, sessions: any[] }>, ungrouped: any[], truncated: boolean, workspaceCount: number }>}
 */
export async function listGroups(ctx, options = {}) {
  const registry = requireRegistry(ctx)
  const [summaries] = await Promise.all([
    listSessions(ctx),
  ])
  const archived = new Set(registry.archivedSessionIds ?? [])
  const byId = new Map(summaries.map((summary) => [summary.sessionId, summary]))
  const cutoff = options.timeRangeMs === undefined ? undefined : Date.now() - options.timeRangeMs
  const includeSubagents = options.includeSubagents === true
  const maxWorkspaces = options.maxWorkspaces ?? 10
  const maxSessions = options.maxWorkspaceSessions ?? 20

  const allWorkspaces = registry.list()
  const groupedIds = new Set(allWorkspaces.flatMap((workspace) => workspace.sessionIds ?? []))
  let truncated = false

  const groups = []
  for (const workspace of allWorkspaces) {
    const sessions = []
    for (const sessionId of workspace.sessionIds ?? []) {
      if (archived.has(sessionId)) continue
      const summary = byId.get(sessionId)
      if (summary === undefined) continue
      if (!includeSubagents && summary.origin === 'subagent') continue
      if (cutoff !== undefined && summary.updatedAt < cutoff) continue
      sessions.push(summary)
    }
    sessions.sort((left, right) => right.updatedAt - left.updatedAt)
    if (cutoff !== undefined && sessions.length === 0) continue
    groups.push({ workspace, sessions })
  }

  let sessionBudget = maxSessions
  const limitedGroups = []
  for (const group of groups) {
    if (limitedGroups.length >= maxWorkspaces) {
      truncated = true
      break
    }
    let sessions = group.sessions
    if (sessions.length > sessionBudget) {
      sessions = sessions.slice(0, sessionBudget)
      truncated = true
    }
    sessionBudget -= sessions.length
    limitedGroups.push({ workspace: group.workspace, sessions })
    if (sessionBudget <= 0 && groups.length > limitedGroups.length) truncated = true
  }

  const ungrouped = summaries
    .filter((summary) => !groupedIds.has(summary.sessionId))
    .filter((summary) => !archived.has(summary.sessionId))
    .filter((summary) => includeSubagents || summary.origin !== 'subagent')
    .filter((summary) => cutoff === undefined || summary.updatedAt >= cutoff)
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, Math.max(0, sessionBudget))

  // Directory status is intentionally best-effort: a moved project must not
  // hide its history.
  await Promise.all(limitedGroups.map(async (group) => {
    try {
      const status = await group.workspace.status()
      group.workspaceView = {
        id: group.workspace.id,
        title: group.workspace.title,
        path: group.workspace.path,
        missingDir: status === 'missing-dir',
      }
    } catch {
      group.workspaceView = {
        id: group.workspace.id,
        title: group.workspace.title,
        path: group.workspace.path,
        missingDir: false,
      }
    }
  }))

  return {
    groups: limitedGroups.map((group) => ({ workspace: group.workspaceView, sessions: group.sessions })),
    ungrouped,
    truncated,
    workspaceCount: groups.length,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} id
 */
export async function listWorkspaceDetail(ctx, id) {
  const registry = requireRegistry(ctx)
  const workspace = registry.get(id)
  if (workspace === undefined) return undefined
  const summaries = await listSessions(ctx)
  const archived = new Set(registry.archivedSessionIds ?? [])
  const byId = new Map(summaries.map((summary) => [summary.sessionId, summary]))
  const sessions = []
  for (const sessionId of workspace.sessionIds ?? []) {
    if (archived.has(sessionId)) continue
    const summary = byId.get(sessionId)
    if (summary !== undefined && summary.origin !== 'subagent') sessions.push(summary)
  }
  sessions.sort((left, right) => right.updatedAt - left.updatedAt)
  let missingDir = false
  try {
    missingDir = (await workspace.status()) === 'missing-dir'
  } catch {
    missingDir = false
  }
  return {
    workspace: {
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      missingDir,
    },
    sessions,
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} rawPath
 * @param {string} [title]
 * @returns {Promise<{ workspace: any, created: boolean }>}
 */
export async function createWorkspace(ctx, rawPath, title = '') {
  const registry = requireRegistry(ctx)
  const path = normalizeAbsolutePath(rawPath)
  if (path === undefined) {
    throw new Error('路径必须是绝对路径（可以用 ~/ 开头）。')
  }
  // Reuse an existing registration without requiring a write.
  try {
    const existing = await registry.resolveByPath(path)
    if (existing !== undefined) return { workspace: existing, created: false }
  } catch {
    // A missing path is expected here; mkdir below creates it.
  }
  try {
    await mkdir(path, { recursive: true })
  } catch (error) {
    throw new Error(`无法创建目录 ${path}：${error instanceof Error ? error.message : String(error)}`)
  }
  const workspace = await registry.create(path, typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined)
  return { workspace, created: true }
}

/**
 * @param {string} input
 * @returns {string | undefined}
 */
export function normalizeAbsolutePath(input) {
  let text = String(input ?? '').trim()
  if (text === '') return undefined
  if (text === '~') text = homedir()
  else if (text.startsWith('~/')) text = `${homedir()}/${text.slice(2)}`
  if (!isAbsolute(text)) return undefined
  return resolve(text)
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @returns {Promise<any[]>}
 */
async function listSessions(ctx) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  try {
    const result = await ctx.sessionController.list({}, controller.signal)
    return Array.isArray(result?.items) ? result.items : []
  } finally {
    clearTimeout(timer)
  }
}

/** @param {any} workspace */
export function workspaceTitle(workspace) {
  return truncate(workspace?.title || workspace?.path || 'workspace', 80)
}
