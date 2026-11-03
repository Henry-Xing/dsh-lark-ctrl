/**
 * `/btw`: a deterministic status snapshot plus an optional natural-language
 * side question delegated to the installed `dsh-btw` plugin.
 *
 * `dsh-btw` registers `POST /api/btw.ask` in the Host's `ctx.connection`
 * Fetch-route table. A Host plugin can dispatch that exact route through
 * `connection.createSharedFetchHandler('/api')` without going through the
 * browser/HTTP admission fence. When the route is absent (plugin not
 * installed, or its contract changed) `/btw` degrades to the snapshot.
 */

import { foldTurnStats } from './summary.js'
import { formatDuration, formatTime, nonNegativeInt, truncate } from './util.js'

const AVAILABILITY_TTL_MS = 60000

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./registry.js').createRegistry>} deps.registry
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createBtw({ ctx, config, registry, logger }) {
  /** @type {{ at: number, available: boolean, reason: string } | undefined} */
  let availability

  /**
   * Probe (and cache) whether the dsh-btw route is dispatchable.
   * @param {boolean} [force]
   * @returns {Promise<{ available: boolean, reason: string }>}
   */
  async function checkAvailable(force = false) {
    if (config.btwMode === 'off') return { available: false, reason: 'btwMode=off' }
    if (config.btwMode === 'snapshot') return { available: false, reason: 'btwMode=snapshot' }
    if (!force && availability !== undefined && Date.now() - availability.at < AVAILABILITY_TTL_MS) {
      return { available: availability.available, reason: availability.reason }
    }
    const handler = sharedHandler()
    if (handler === undefined) {
      availability = { at: Date.now(), available: false, reason: 'ctx.connection 不可用' }
      return availability
    }
    const metaRoute = metaRouteOf(config.btwRoute)
    if (metaRoute === '') {
      availability = { at: Date.now(), available: false, reason: '无法推导 btw 探活路由' }
      return availability
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    try {
      const response = await handler.fetch(
        new Request(`http://dsh-lark-ctrl.local${metaRoute}`, {
          method: 'GET',
          signal: controller.signal,
        }),
      )
      const available = response.ok
      availability = {
        at: Date.now(),
        available,
        reason: available ? '' : `dsh-btw ${metaRoute} 返回 ${response.status}`,
      }
      return availability
    } catch (error) {
      availability = { at: Date.now(), available: false, reason: `dsh-btw 探活失败：${String(error)}` }
      return availability
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param {string} sessionId
   * @returns {Promise<{ code: string, sessionId: string, title: string, running: boolean, statusText: string, lastUser: string, lastAssistant: string, tools: string[], pending: number, queued: number, model: string, cwd?: string, elapsed?: string }>}
   */
  async function snapshot(sessionId) {
    const row = await registry.describe(sessionId)
    const code = registry.ensureCode(sessionId)
    const live = ctx.sessions.get(sessionId)
    const agent = ctx.agents.get(sessionId)
    let events = []
    let header = live?.header
    if (live !== undefined) {
      events = live.snapshotEvents()
    } else {
      try {
        if (ctx.sessionQuery?.readSession !== undefined) {
          const snap = await ctx.sessionQuery.readSession(sessionId)
          header = snap.session
          events = snap.events
        } else {
          const inspection = await ctx.sessionController.inspect(sessionId)
          header = inspection?.meta
          events = inspection?.events ?? []
        }
      } catch (error) {
        logger.warn(`[lark] btw snapshot read failed: ${String(error)}`)
      }
    }
    const stats = foldTurnStats(events)
    const running = row?.running === true || agent?.status === 'running'
    const openTurn = running ? events.findLast?.((event) => event.type === 'turn/start') : undefined
    const elapsed = running && openTurn?.time
      ? formatDuration(Date.now() - openTurn.time)
      : undefined
    const pending = pendingQuestionCount(live)
    return {
      code,
      sessionId,
      title: row?.title || '',
      running,
      statusText: running ? '运行中' : '空闲',
      lastUser: truncate(stats.userText, 600),
      lastAssistant: truncate(stats.assistantText, 1200),
      tools: stats.toolNames.slice(0, 8),
      pending,
      queued: queuedCount(agent),
      model: modelOf(live, events),
      cwd: typeof header?.cwd === 'string' ? header.cwd : row?.cwd,
      elapsed,
      lastActivity: formatTime(nonNegativeInt(events.at(-1)?.time)),
    }
  }

  /**
   * Ask dsh-btw a side question.
   * @param {string} sessionId
   * @param {string} question
   * @param {AbortSignal} [outerSignal]
   * @returns {Promise<{ ok: true, answer: string, model?: string, finish?: string } | { ok: false, unavailable?: boolean, busy?: boolean, message: string }>}
   */
  async function ask(sessionId, question, outerSignal) {
    const text = String(question ?? '').trim()
    if (text === '') return { ok: false, message: '问题为空。' }
    if (text.length > 4000) return { ok: false, message: '问题过长（上限 4000 字）。' }
    if (config.btwMode === 'off') return { ok: false, message: 'btw 已关闭。' }
    if (config.btwMode === 'snapshot') {
      return { ok: false, unavailable: true, message: '当前 btwMode=snapshot，只提供状态快照。' }
    }

    const probe = await checkAvailable()
    if (!probe.available) {
      return { ok: false, unavailable: true, message: probe.reason || '未安装 dsh-btw。' }
    }
    const handler = sharedHandler()
    if (handler === undefined) {
      return { ok: false, unavailable: true, message: 'ctx.connection 不可用。' }
    }

    // dsh-btw only answers for a live Session; resuming a cold one is enough.
    let resumed
    try {
      resumed = await ctx.sessionController.resolveAgent(sessionId)
    } catch (error) {
      return { ok: false, message: `会话无法恢复为 live：${String(error)}` }
    }
    if (resumed?.agent === undefined) {
      return { ok: false, message: '会话无法恢复为 live，暂时不能旁问。' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('btw timeout')), config.btwTimeoutMs)
    const signal = outerSignal === undefined ? controller.signal : AbortSignal.any([outerSignal, controller.signal])
    try {
      const response = await handler.fetch(
        new Request(`http://dsh-lark-ctrl.local${config.btwRoute}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, question: text }),
          signal,
        }),
      )
      if (response.status === 404 || response.status === 405) {
        availability = { at: Date.now(), available: false, reason: `dsh-btw ${config.btwRoute} 返回 ${response.status}` }
        return { ok: false, unavailable: true, message: '未找到 dsh-btw 的旁问路由。' }
      }
      if (response.status === 409) {
        return { ok: false, busy: true, message: '该会话已有一个旁问在进行，请稍后再试。' }
      }
      if (!response.ok) {
        const body = await safeJson(response)
        return { ok: false, message: body?.error?.message ?? `dsh-btw 返回 ${response.status}` }
      }
      return await readSse(response, signal)
    } catch (error) {
      const message = controller.signal.aborted ? '旁问超时。' : `旁问失败：${String(error)}`
      return { ok: false, message }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * @param {Response} response
   * @param {AbortSignal} signal
   */
  async function readSse(response, signal) {
    if (response.body === null) return { ok: false, message: 'dsh-btw 返回了空响应。' }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let answer = ''
    let model = ''
    try {
      while (true) {
        signal.throwIfAborted()
        const { done, value } = await reader.read()
        if (done === true) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          boundary = buffer.indexOf('\n\n')
          const line = chunk
            .split('\n')
            .map((item) => item.trim())
            .filter((item) => item.startsWith('data:'))
            .map((item) => item.slice(5).trim())
            .join('')
          if (line === '') continue
          let event
          try {
            event = JSON.parse(line)
          } catch {
            continue
          }
          if (event?.type === 'start' && typeof event.entry?.model === 'string') model = event.entry.model
          if (event?.type === 'delta' && typeof event.text === 'string') answer += event.text
          if (event?.type === 'done') {
            const entry = event.entry ?? {}
            const final = typeof entry.answer === 'string' && entry.answer !== '' ? entry.answer : answer
            return {
              ok: true,
              answer: final,
              model: typeof entry.model === 'string' ? entry.model : model,
              finish: typeof entry.finish === 'string' ? entry.finish : undefined,
            }
          }
          if (event?.type === 'error') {
            return { ok: false, message: event.error?.message ?? 'dsh-btw 生成失败。' }
          }
        }
      }
      if (answer !== '') return { ok: true, answer, model }
      return { ok: false, message: 'dsh-btw 没有返回内容。' }
    } finally {
      try {
        await reader.cancel()
      } catch {
        // ignore
      }
    }
  }

  /** @returns {{ fetch: (request: Request) => Promise<Response> } | undefined} */
  function sharedHandler() {
    try {
      const connection = ctx.get('connection')
      if (connection?.createSharedFetchHandler === undefined) return undefined
      return connection.createSharedFetchHandler('/api')
    } catch {
      return undefined
    }
  }

  /** @param {any} liveSession */
  function pendingQuestionCount(liveSession) {
    if (liveSession === undefined) return 0
    try {
      const state = ctx.sessionProjections?.stateOf?.(liveSession, 'userQuestions')
      const active = state?.questions?.active
      if (Array.isArray(active)) return active.length
      const view = ctx.sessionProjections?.snapshot?.(liveSession)?.values?.userQuestions
      return Array.isArray(view?.active) ? view.active.length : 0
    } catch {
      return 0
    }
  }

  /** @param {any} agent */
  function queuedCount(agent) {
    try {
      return (agent?.inbox?.nextTurn?.length ?? 0) + (agent?.inbox?.nextStep?.length ?? 0)
    } catch {
      return 0
    }
  }

  /** @param {any} liveSession @param {ReadonlyArray<any>} events */
  function modelOf(liveSession, events) {
    try {
      const context = liveSession?.requestContext?.()
      if (typeof context?.model === 'string') return context.model
    } catch {
      // ignore
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type === 'request/header' && typeof event.data?.header?.config?.model === 'string') {
        return event.data.header.config.model
      }
    }
    return ''
  }

  return {
    checkAvailable,
    snapshot,
    ask,
    /** Invalidated by tests and after a failed route call. */
    resetAvailability() {
      availability = undefined
    },
  }
}

/** @param {string} route */
function metaRouteOf(route) {
  if (typeof route !== 'string') return ''
  if (route.endsWith('.ask')) return `${route.slice(0, -4)}.meta`
  return ''
}

/** @param {Response} response */
async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return undefined
  }
}
