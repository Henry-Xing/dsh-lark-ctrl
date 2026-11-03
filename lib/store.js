/**
 * Durable bridge state: session-code overrides, message links (so a reply to
 * any notification routes back to its session), and the inbound event dedupe
 * set. One small JSON file, written atomically and debounced.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

import { isRecord } from './util.js'

const STATE_VERSION = 1
const MAX_LINKS = 1000
const MAX_SEEN = 2000
const FLUSH_DELAY_MS = 250

/**
 * @param {ReturnType<import('./config.js').normalizeConfig>} config
 * @param {{ info: Function, warn: Function }} logger
 */
export function createStore(config, logger) {
  const file = join(resolveStoreDir(config), 'state.json')
  let state = emptyState(config.defaultPushLevel)
  let loaded = false
  let dirty = false
  let timer
  let flushing = Promise.resolve()

  async function load() {
    if (loaded) return
    loaded = true
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = JSON.parse(raw)
      if (isRecord(parsed) && parsed.version === STATE_VERSION) {
        state = {
          version: STATE_VERSION,
          codes: sanitizeStringMap(parsed.codes),
          codeIndex: sanitizeStringMap(parsed.codeIndex),
          links: sanitizeLinks(parsed.links),
          seen: sanitizeSeen(parsed.seen),
          lastSessionId: typeof parsed.lastSessionId === 'string' ? parsed.lastSessionId : '',
          pushLevel: normalizeLevel(parsed.pushLevel, config.defaultPushLevel),
        }
      } else {
        logger.warn('[lark] store state has an unsupported shape; starting fresh')
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') logger.warn(`[lark] store read failed: ${String(error)}`)
    }
  }

  function scheduleFlush() {
    dirty = true
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      void flush()
    }, FLUSH_DELAY_MS)
    timer.unref?.()
  }

  async function flush() {
    if (!dirty) return flushing
    dirty = false
    const snapshot = JSON.stringify(state, null, 0)
    flushing = (async () => {
      try {
        await mkdir(dirname(file), { recursive: true })
        const temporary = `${file}.${process.pid}.tmp`
        await writeFile(temporary, snapshot, { encoding: 'utf8', mode: 0o600 })
        await rename(temporary, file)
      } catch (error) {
        dirty = true
        logger.warn(`[lark] store write failed: ${String(error)}`)
      }
    })()
    return flushing
  }

  return {
    async load() {
      await load()
    },

    /** @param {string} sessionId */
    codeOverride(sessionId) {
      return state.codes[sessionId]
    },

    /** @param {string} code */
    sessionForCode(code) {
      const sessionId = state.codeIndex[code]
      return typeof sessionId === 'string' ? sessionId : undefined
    },

    /**
     * @param {string} sessionId
     * @param {string} code
     */
    setCode(sessionId, code) {
      if (state.codes[sessionId] === code && state.codeIndex[code] === sessionId) return
      state.codes[sessionId] = code
      state.codeIndex[code] = sessionId
      trimStringMap(state.codes, MAX_LINKS)
      trimStringMap(state.codeIndex, MAX_LINKS)
      scheduleFlush()
    },

    /**
     * @param {string} messageId
     * @param {{ sessionId: string, kind: string, callId?: string, approvalKey?: string, at?: number }} link
     */
    linkMessage(messageId, link) {
      if (typeof messageId !== 'string' || messageId === '') return
      state.links[messageId] = { ...link, at: Date.now() }
      trimObject(state.links, MAX_LINKS)
      scheduleFlush()
    },

    /** @param {string} messageId */
    lookupMessage(messageId) {
      const link = state.links[messageId]
      return isRecord(link) ? link : undefined
    },

    /**
     * @param {string} id
     * @returns {boolean} true when this id was seen before
     */
    rememberEvent(id) {
      if (typeof id !== 'string' || id === '') return false
      if (state.seen[id] !== undefined) return true
      state.seen[id] = Date.now()
      trimObject(state.seen, MAX_SEEN)
      scheduleFlush()
      return false
    },

    /** @returns {0|1|2} */
    pushLevel() {
      return normalizeLevel(state.pushLevel, config.defaultPushLevel)
    },

    /** @param {number} level */
    setPushLevel(level) {
      const next = normalizeLevel(level, 2)
      if (state.pushLevel === next) return
      state.pushLevel = next
      scheduleFlush()
    },

    /** @param {string} sessionId */
    setLastSession(sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return
      if (state.lastSessionId === sessionId) return
      state.lastSessionId = sessionId
      scheduleFlush()
    },

    /** @returns {string | undefined} */
    lastSession() {
      return state.lastSessionId === '' ? undefined : state.lastSessionId
    },

    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await flush()
    },

    async dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await flush()
    },
  }
}

/** @param {ReturnType<import('./config.js').normalizeConfig>} config */
function resolveStoreDir(config) {
  if (config.storeDir !== '') {
    return isAbsolute(config.storeDir) ? config.storeDir : join(process.cwd(), config.storeDir)
  }
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'storages', 'lark')
}

/** @param {number} [pushLevel] */
function emptyState(pushLevel = 2) {
  return {
    version: STATE_VERSION,
    codes: {},
    codeIndex: {},
    links: {},
    seen: {},
    lastSessionId: '',
    pushLevel,
  }
}

/** @param {unknown} value @param {number} fallback */
function normalizeLevel(value, fallback) {
  return value === 0 || value === 1 || value === 2 ? value : fallback
}

/** @param {unknown} value */
function sanitizeStringMap(value) {
  if (!isRecord(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && key !== '' && item !== '') out[key] = item
  }
  return out
}

/** @param {unknown} value */
function sanitizeLinks(value) {
  if (!isRecord(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (!isRecord(item) || typeof item.sessionId !== 'string' || typeof item.kind !== 'string') continue
    out[key] = {
      sessionId: item.sessionId,
      kind: item.kind,
      ...(typeof item.callId === 'string' ? { callId: item.callId } : {}),
      ...(typeof item.approvalKey === 'string' ? { approvalKey: item.approvalKey } : {}),
      ...(typeof item.workspaceId === 'string' ? { workspaceId: item.workspaceId } : {}),
      ...(typeof item.requestId === 'string' ? { requestId: item.requestId } : {}),
      ...(typeof item.createdSessionId === 'string' ? { createdSessionId: item.createdSessionId } : {}),
      ...(item.promptSent === true ? { promptSent: true } : {}),
      at: typeof item.at === 'number' ? item.at : 0,
    }
  }
  return out
}

/** @param {unknown} value */
function sanitizeSeen(value) {
  if (!isRecord(value)) return {}
  const out = {}
  for (const [key, item] of Object.entries(value)) {
    if (key !== '' && typeof item === 'number') out[key] = item
  }
  return out
}

/** @param {Record<string, unknown>} object @param {number} cap */
function trimObject(object, cap) {
  const keys = Object.keys(object)
  if (keys.length <= cap) return
  keys.sort((left, right) => Number(object[left] ?? 0) - Number(object[right] ?? 0))
  for (const key of keys.slice(0, keys.length - cap)) delete object[key]
}

/** @param {Record<string, string>} object @param {number} cap */
function trimStringMap(object, cap) {
  const keys = Object.keys(object)
  if (keys.length <= cap) return
  for (const key of keys.slice(0, keys.length - cap)) delete object[key]
}
