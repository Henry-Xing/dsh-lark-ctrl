/**
 * Deterministic run summaries. No model call: the card is built from the
 * committed Session log so a summary can never fail because of a provider.
 */

import { contentText, formatDuration, hasImages, nonNegativeInt, stripImages, truncate } from './util.js'

/**
 * Fold the last turn of a Session event array. Pure and testable.
 * @param {ReadonlyArray<Record<string, any>>} events
 * @returns {{
 *   turn: number,
 *   startedAt: number,
 *   endedAt: number,
 *   userText: string,
 *   assistantText: string,
 *   toolCalls: number,
 *   toolNames: string[],
 *   usage: { inputTokens: number, outputTokens: number },
 *   reason: Record<string, any> | undefined,
 *   model: string,
 * }}
 */
export function foldTurnStats(events) {
  let startIndex = -1
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.type === 'turn/start') {
      startIndex = index
      break
    }
  }
  const from = startIndex === -1 ? Math.max(0, events.length - 200) : startIndex
  const stats = {
    turn: 0,
    startedAt: 0,
    endedAt: 0,
    userText: '',
    assistantText: '',
    toolCalls: 0,
    toolNames: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    reason: undefined,
    model: '',
  }
  const toolNames = new Set()
  for (let index = from; index < events.length; index += 1) {
    const event = events[index]
    if (event === undefined) continue
    const data = event.data ?? {}
    switch (event.type) {
      case 'turn/start':
        stats.turn = nonNegativeInt(data.turn)
        stats.startedAt = nonNegativeInt(event.time)
        break
      case 'user/message':
        if (data.source?.kind === 'user' || data.source?.kind === undefined) {
          const text = contentText(data.content)
          if (text !== '') stats.userText = text
        }
        break
      case 'assistant/message': {
        const text = contentText(data.message?.content)
        if (text !== '') stats.assistantText = text
        stats.usage.inputTokens += nonNegativeInt(data.usage?.inputTokens)
        stats.usage.outputTokens += nonNegativeInt(data.usage?.outputTokens)
        break
      }
      case 'tool/call':
        stats.toolCalls += 1
        if (typeof data.name === 'string') toolNames.add(data.name)
        break
      case 'turn/end':
        stats.endedAt = nonNegativeInt(event.time)
        stats.reason = data.reason
        break
      case 'request/header': {
        const config = data.header?.config
        if (typeof config?.model === 'string') stats.model = config.model
        break
      }
      default:
        break
    }
  }
  stats.toolNames = [...toolNames]
  return stats
}

/**
 * @param {object} input
 * @param {Record<string, any>} input.session - live Session
 * @param {string} input.title
 * @param {Record<string, any>} [input.run] - in-memory run accumulator
 * @param {number} input.maxChars
 * @param {number} [input.now]
 */
export function summarizeRun({ session, title, run, maxChars, now = Date.now() }) {
  const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
  const stats = foldTurnStats(events)
  const startedAt = nonNegativeInt(run?.startedAt) || stats.startedAt
  const endedAt = stats.endedAt || now
  const durationMs = startedAt > 0 ? Math.max(0, endedAt - startedAt) : 0
  const rawAssistantText = run?.assistantText || stats.assistantText || ''
  const rawUserText = run?.userText || stats.userText || ''
  // Strip images before truncation: a long image URL/data URI would otherwise
  // be cut in half and remain as broken `![...](...` raw markdown on the card.
  const imagesOmitted = hasImages(rawAssistantText) || hasImages(rawUserText)
  const assistantText = truncate(stripImages(rawAssistantText), maxChars)
  const userText = truncate(stripImages(rawUserText), Math.max(200, Math.floor(maxChars / 3)))
  const usage = {
    inputTokens: nonNegativeInt(run?.usage?.inputTokens) || stats.usage.inputTokens,
    outputTokens: nonNegativeInt(run?.usage?.outputTokens) || stats.usage.outputTokens,
  }
  const reason = run?.reason ?? stats.reason
  return {
    title: title || '',
    userText,
    assistantText,
    imagesOmitted,
    durationMs,
    durationText: formatDuration(durationMs),
    toolCalls: nonNegativeInt(run?.toolCalls) || stats.toolCalls,
    toolNames: Array.isArray(run?.toolNames) && run.toolNames.length > 0 ? run.toolNames : stats.toolNames,
    usage,
    reason,
    reasonText: reasonTextOf(reason),
    errorMessage: errorMessageOf(reason),
    model: typeof run?.model === 'string' && run.model !== '' ? run.model : stats.model,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined,
    startedAt,
    endedAt,
  }
}

/** @param {unknown} reason */
export function reasonTextOf(reason) {
  const kind = typeof reason === 'object' && reason !== null && typeof reason.kind === 'string' ? reason.kind : ''
  switch (kind) {
    case 'completed':
      return '已完成'
    case 'aborted':
      return '已停止'
    case 'blocked':
      return '被阻塞'
    case 'error':
      return '失败'
    case 'max-tokens':
      return '达到输出上限'
    case 'interrupted':
      return '被中断'
    case 'forked':
      return '已分叉'
    default:
      return '已结束'
  }
}

/** @param {unknown} reason */
export function errorMessageOf(reason) {
  if (typeof reason !== 'object' || reason === null) return ''
  if (reason.kind !== 'error') return ''
  const error = reason.error
  if (typeof error?.message === 'string') return error.message
  if (typeof error === 'string') return error
  return ''
}

/** @param {unknown} reason */
export function isErrorReason(reason) {
  return typeof reason === 'object' && reason !== null && reason.kind === 'error'
}
