/**
 * Two long-running lark-cli event consumers with readiness probes, backoff,
 * and durable deduplication. lark-cli treats stdin EOF as a graceful shutdown,
 * so the child's stdin is kept open for the lifetime of the bridge.
 */

import { delay } from './util.js'

const KEYS = {
  message: 'im.message.receive_v1',
  card: 'card.action.trigger',
}
const READY_TIMEOUT_MS = 30000
const CARD_RECHECK_MS = 10 * 60 * 1000

/**
 * @param {object} deps
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./lark-cli.js').createLarkCli>} deps.cli
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 * @param {(event: Record<string, any>) => void} deps.onMessage
 * @param {(event: Record<string, any>) => void} deps.onCardAction
 * @param {(state: BridgeState) => void} [deps.onState]
 */
export function createEventBridge({ config, cli, store, logger, onMessage, onCardAction, onState }) {
  /**
   * @typedef {object} BridgeState
   * @property {boolean} messageReady
   * @property {boolean} cardReady
   * @property {string} cardHint
   * @property {string} lastError
   */

  const state = {
    messageReady: false,
    cardReady: false,
    cardHint: '',
    lastError: '',
  }

  /** @type {Map<string, { stop: () => void }>} */
  const consumers = new Map()
  /** @type {Map<string, NodeJS.Timeout>} */
  const pendingRestarts = new Map()
  const attempts = new Map()
  let stopped = false
  let cardRecheck

  function publish() {
    onState?.({ ...state })
  }

  /**
   * @param {string} key
   * @param {(event: Record<string, any>) => void} handler
   * @param {string} dedupePrefix
   */
  function spawnConsumer(key, handler, dedupePrefix) {
    if (stopped) return
    if (consumers.has(key)) return
    let ready = false
    let readyTimer
    const consumer = cli.consume(key, {
      onReady() {
        ready = true
        state.lastError = ''
        if (key === KEYS.message) state.messageReady = true
        if (key === KEYS.card) state.cardReady = true
        attempts.set(key, 0)
        publish()
        logger.info(`[lark] event consumer ready: ${key}`)
        if (readyTimer !== undefined) clearTimeout(readyTimer)
      },
      onEvent(event) {
        try {
          const id = dedupeId(key, event)
          if (id !== undefined && store.rememberEvent(`${dedupePrefix}:${id}`)) return
          const result = handler(event)
          if (result !== undefined && typeof result.catch === 'function') {
            result.catch((error) => logger.warn(`[lark] ${key} handler failed: ${String(error)}`))
          }
        } catch (error) {
          logger.warn(`[lark] ${key} handler failed: ${String(error)}`)
        }
      },
      onExit(exit) {
        consumers.delete(key)
        if (readyTimer !== undefined) clearTimeout(readyTimer)
        if (stopped) return
        if (!ready) {
          if (key === KEYS.message) state.messageReady = false
          if (key === KEYS.card) state.cardReady = false
          state.lastError = exit.error?.message ?? `exit code ${exit.code ?? 'null'}`
          publish()
        }
        if (exit.error !== undefined) {
          logger.warn(`[lark] ${key} consumer exited: ${exit.error.message}`)
        } else {
          logger.warn(`[lark] ${key} consumer exited (code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'none'})`)
        }
        if (key === KEYS.card) {
          // A blocked callback permission is an expected deployment state; do
          // not spin. Re-probe on the slow path.
          void scheduleCardConsumer(CARD_RECHECK_MS)
          return
        }
        scheduleRestart(key, handler, dedupePrefix)
      },
    })
    consumers.set(key, consumer)
    readyTimer = setTimeout(() => {
      if (stopped || ready) return
      logger.warn(`[lark] ${key} consumer did not become ready in ${READY_TIMEOUT_MS}ms; restarting`)
      consumer.stop()
    }, READY_TIMEOUT_MS)
    readyTimer.unref?.()
  }

  /**
   * @param {string} key
   * @param {(event: Record<string, any>) => void} handler
   * @param {string} dedupePrefix
   */
  function scheduleRestart(key, handler, dedupePrefix) {
    if (stopped || pendingRestarts.has(key)) return
    const attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)
    const wait = Math.min(60000, 1000 * 2 ** Math.min(6, attempt - 1))
    const timer = setTimeout(() => {
      pendingRestarts.delete(key)
      spawnConsumer(key, handler, dedupePrefix)
    }, wait)
    timer.unref?.()
    pendingRestarts.set(key, timer)
  }

  /** @param {number} waitMs */
  async function scheduleCardConsumer(waitMs) {
    if (stopped) return
    if (cardRecheck !== undefined) clearTimeout(cardRecheck)
    cardRecheck = setTimeout(() => {
      cardRecheck = undefined
      void startCardConsumer()
    }, waitMs)
    cardRecheck.unref?.()
  }

  async function startCardConsumer() {
    if (stopped) return
    if (config.answerMode === 'off' && config.approvalMode === 'off') return
    let probe
    try {
      probe = await cli.probeEvent(KEYS.card)
    } catch (error) {
      state.cardReady = false
      state.lastError = String(error)
      publish()
      logger.warn(`[lark] card callback probe failed: ${String(error)}`)
      await scheduleCardConsumer(CARD_RECHECK_MS)
      return
    }
    if (probe.status !== 'ready') {
      state.cardReady = false
      state.cardHint = probe.hint ?? ''
      publish()
      logger.warn(
        `[lark] card callbacks unavailable (${probe.status}${probe.detail ? `: ${probe.detail}` : ''}). ` +
        '卡片按钮/表单将不可用，文字回复答题仍然可用。' +
        (probe.hint ? ` 开通链接: ${probe.hint}` : ''),
      )
      await scheduleCardConsumer(CARD_RECHECK_MS)
      return
    }
    spawnConsumer(KEYS.card, onCardAction, 'card')
  }

  async function start() {
    // Message events are the primary inbound path; start them without waiting
    // for the slower card-callback probe.
    spawnConsumer(KEYS.message, onMessage, 'message')
    void startCardConsumer()
  }

  function stop() {
    stopped = true
    if (cardRecheck !== undefined) clearTimeout(cardRecheck)
    cardRecheck = undefined
    for (const timer of pendingRestarts.values()) clearTimeout(timer)
    pendingRestarts.clear()
    for (const consumer of consumers.values()) consumer.stop()
    consumers.clear()
    state.messageReady = false
    state.cardReady = false
    publish()
  }

  return {
    start,
    stop,
    state,
    /** Probe again immediately; used by `/status` diagnostics. */
    async recheck() {
      if (cardRecheck !== undefined) clearTimeout(cardRecheck)
      cardRecheck = undefined
      await startCardConsumer()
    },
  }
}

/** @param {string} key @param {Record<string, any>} event */
function dedupeId(key, event) {
  if (key === KEYS.card) return typeof event.event_id === 'string' ? event.event_id : undefined
  if (typeof event.message_id === 'string') return event.message_id
  if (typeof event.id === 'string') return event.id
  return typeof event.event_id === 'string' ? event.event_id : undefined
}

export { KEYS }
