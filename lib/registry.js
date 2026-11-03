/**
 * Session-code registry and the message-id → session index.
 *
 * The code is deterministic (`sha256(sessionId)` base32), so it survives
 * restarts without stored state; the store only records overrides for the
 * rare collision and the long `message_id` table used for reply routing.
 */

import { sessionCode, truncate } from './util.js'

const SESSION_CACHE_MS = 3000

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createRegistry({ ctx, store, config, logger }) {
  /** @type {{ at: number, sessions: SessionRow[] } | undefined} */
  let cache

  /**
   * @typedef {object} SessionRow
   * @property {string} sessionId
   * @property {string} title
   * @property {boolean} running
   * @property {number} updatedAt
   * @property {boolean} agentAvailable
   * @property {string} [cwd]
   * @property {string} [agentPreset]
   */

  /**
   * @param {number} [maxAgeMs]
   * @returns {Promise<SessionRow[]>}
   */
  async function listSessions(maxAgeMs = SESSION_CACHE_MS) {
    if (cache !== undefined && Date.now() - cache.at < maxAgeMs) return cache.sessions
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 10000)
    try {
      const result = await ctx.sessionController.list({}, controller.signal)
      const items = Array.isArray(result?.items) ? result.items : []
      const sessions = []
      for (const item of items) {
        if (typeof item?.sessionId !== 'string' || item.sessionId === '') continue
        if (!config.includeSubagents && item.origin === 'subagent') continue
        const title = typeof item.projections?.values?.title === 'string' ? item.projections.values.title : ''
        sessions.push({
          sessionId: item.sessionId,
          title,
          running: item.running === true,
          updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : 0,
          agentAvailable: item.agentAvailable === true,
          cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
          agentPreset: typeof item.agentPreset === 'string' ? item.agentPreset : undefined,
        })
      }
      cache = { at: Date.now(), sessions }
      return sessions
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Return the stable display code for a session, assigning a longer code when
   * the six-character prefix is already owned by another session.
   * @param {string} sessionId
   * @returns {string}
   */
  function ensureCode(sessionId) {
    const existing = store.codeOverride(sessionId)
    if (existing !== undefined) return existing
    for (let length = 6; length <= 9; length += 1) {
      const candidate = sessionCode(sessionId, length)
      const owner = store.sessionForCode(candidate)
      if (owner === undefined || owner === sessionId) {
        store.setCode(sessionId, candidate)
        return candidate
      }
    }
    // Deterministic last resort: a longer digest is effectively collision-free.
    const fallback = sessionCode(sessionId, 12)
    store.setCode(sessionId, fallback)
    return fallback
  }

  /**
   * Resolve a user-supplied code to a session. Codes are not secrets; the
   * authorization boundary is the open_id allowlist.
   * @param {string} code
   * @returns {Promise<string | undefined>}
   */
  async function resolveCode(code) {
    const normalized = String(code ?? '').trim().toLowerCase()
    if (!/^[a-z2-7]{6,12}$/.test(normalized)) return undefined
    const known = store.sessionForCode(normalized)
    if (known !== undefined) return known

    const sessions = await listSessions()
    const matches = sessions.filter((row) => {
      const own = store.codeOverride(row.sessionId)
      if (own !== undefined) return own === normalized
      return sessionCode(row.sessionId, normalized.length) === normalized
    })
    if (matches.length === 0) return undefined
    if (matches.length > 1) {
      logger.warn(`[lark] session code ${normalized} matches ${matches.length} sessions; using the most recent`)
    }
    const row = matches[0]
    store.setCode(row.sessionId, normalized)
    return row.sessionId
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<SessionRow | undefined>}
   */
  async function describe(sessionId) {
    const sessions = await listSessions()
    const found = sessions.find((row) => row.sessionId === sessionId)
    if (found !== undefined) return found
    const live = ctx.sessions.get(sessionId)
    if (live === undefined) return undefined
    let title = ''
    try {
      const titleValue = ctx.sessionProjections?.snapshot?.(live)?.values?.title
      if (typeof titleValue === 'string') title = titleValue
    } catch {
      // projections are best-effort here
    }
    return {
      sessionId,
      title,
      running: ctx.agents.get(sessionId)?.status === 'running',
      updatedAt: live.header.createdAt,
      agentAvailable: ctx.agents.get(sessionId) !== undefined,
      cwd: live.header.cwd,
    }
  }

  /**
   * @param {string} sessionId
   * @param {string} messageId
   * @param {object} link
   */
  function link(sessionId, messageId, link) {
    if (!messageId) return
    store.linkMessage(messageId, { ...link, sessionId })
  }

  /** @param {string} messageId */
  function lookup(messageId) {
    return store.lookupMessage(messageId)
  }

  /** @param {string} sessionId */
  function rememberLast(sessionId) {
    store.setLastSession(sessionId)
  }

  /** @returns {string | undefined} */
  function lastSession() {
    return store.lastSession()
  }

  /**
   * Best-effort short label for a session.
   * @param {string} sessionId
   * @param {number} [max]
   */
  async function label(sessionId, max = 80) {
    const row = await describe(sessionId)
    const title = row?.title?.trim()
    if (title) return truncate(title, max)
    return sessionId
  }

  return {
    listSessions,
    ensureCode,
    resolveCode,
    describe,
    link,
    lookup,
    rememberLast,
    lastSession,
    label,
    invalidate() {
      cache = undefined
    },
  }
}
