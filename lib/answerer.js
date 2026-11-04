/**
 * Answerer for `user-questions/request` and `approval/request`.
 *
 * The listener is prepended to the Cordis waterfall, publishes a Lark card,
 * then races the Lark answer against the rest of the chain (the shipped Web
 * answerer). Whichever side answers first wins; the other card is patched to
 * reflect the settlement. Timed questions that expired keep their card and
 * fall back to the durable `ctx.userQuestions.answer()` path.
 */

import {
  buildApprovalCard,
  buildApprovalResolvedCard,
  buildAnsweredCard,
  buildExpiredQuestionCard,
  buildNoticeCard,
  buildQuestionCard,
  extractFormAnswers,
  fitCard,
  parseApprovalText,
  parseTextAnswer,
} from './cards.js'
import { newId, truncate } from './util.js'

const CONTINUED_TTL_MS = 24 * 60 * 60 * 1000
const MAX_QUESTIONS = 12

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./registry.js').createRegistry>} deps.registry
 * @param {ReturnType<import('./transport.js').createTransport>} deps.transport
 * @param {ReturnType<import('./store.js').createStore>} deps.store
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createAnswerer({ ctx, config, registry, transport, store, logger }) {
  /** @type {Map<string, QuestionEntry>} */
  const questions = new Map()
  /** @type {Map<string, ApprovalEntry>} */
  const approvals = new Map()
  let disposed = false
  let sweeper

  /**
   * @typedef {object} QuestionEntry
   * @property {string} key
   * @property {string} sessionId
   * @property {string} callId
   * @property {Array<Record<string, any>>} questions
   * @property {(answer: any) => void} resolve
   * @property {(error: Error) => void} reject
   * @property {'open'|'continued'|'answered'|'expired'} state
   * @property {string | undefined} messageId
   * @property {boolean} timed
   * @property {number} createdAt
   * @property {AbortController | undefined} [cancelSignal]
   * @property {boolean} [suppressed]
   */

  /**
   * @typedef {object} ApprovalEntry
   * @property {string} key
   * @property {string} sessionId
   * @property {string} toolName
   * @property {string | undefined} messageId
   * @property {(outcome: string) => void} resolve
   * @property {(error: Error) => void} reject
   * @property {'open'|'answered'|'expired'} state
   * @property {number} createdAt
   * @property {AbortController | undefined} [cancelSignal]
   * @property {boolean} [suppressed]
   * @property {any} [request]
   * @property {string} [reason]
   * @property {{ language: string, text: string } | undefined} [detail]
   */

  /**
   * Give one waterfall request a cancellable signal that still propagates the
   * caller's original cancellation. Aborting it after a Lark answer makes the
   * gateway send a `cancel` frame to Web clients, which settles their forwarded
   * waterfall instead of leaving the question panel open forever.
   * @param {any} request
   * @returns {AbortController | undefined}
   */
  function attachCancelSignal(request) {
    if (request === undefined || request === null) return undefined
    const controller = new AbortController()
    try {
      const original = request.signal
      const combined = original === undefined || original === null
        ? controller.signal
        : AbortSignal.any([original, controller.signal])
      request.signal = combined
      return controller
    } catch (error) {
      logger.debug?.(`[lark] cannot attach a per-question cancel signal: ${String(error)}`)
      return undefined
    }
  }

  /**
   * Nudge the client session list so its question-card reconciler removes a
   * card whose forwarded waterfall was just cancelled. A single event can
   * arrive before the client has processed the cancel frame, so send a few.
   * @param {string} sessionId
   */
  function nudgeClient(sessionId) {
    for (const wait of [80, 350, 1200]) {
      const timer = setTimeout(() => {
        if (disposed) return
        try {
          ctx.emit('api-session/activity', sessionId, Date.now())
        } catch (error) {
          logger.debug?.(`[lark] session activity nudge failed: ${String(error)}`)
        }
      }, wait)
      timer.unref?.()
    }
  }

  function register() {
    return ctx.effect(() => {
      const offQuestion = ctx.on('user-questions/request', onQuestion, { prepend: true })
      const offApproval = ctx.on('approval/request', onApproval, { prepend: true })
      sweeper = setInterval(sweep, 10 * 60 * 1000)
      sweeper.unref?.()
      return () => {
        disposed = true
        offQuestion()
        offApproval()
        if (sweeper !== undefined) clearInterval(sweeper)
        for (const entry of questions.values()) {
          entry.cancelSignal?.abort(new Error('lark bridge disposed'))
          if (entry.state === 'open') entry.reject(new Error('lark bridge disposed'))
        }
        for (const entry of approvals.values()) {
          entry.cancelSignal?.abort(new Error('lark bridge disposed'))
          if (entry.state === 'open') entry.resolve('cancelled')
        }
        questions.clear()
        approvals.clear()
      }
    }, 'lark: question and approval answerers')
  }

  /* --------------------------------------------------------------------- */
  /* user-questions                                                        */
  /* --------------------------------------------------------------------- */

  /**
   * @param {any} request
   * @param {() => Promise<any>} next
   */
  async function onQuestion(request, next) {
    if (disposed) return next()
    const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : undefined
    if (sessionId === undefined) return next()
    if (config.answerMode === 'off' || !config.notifyQuestion) return next()
    const publishNow = store.pushLevel() >= 1

    if (publishNow && config.answerMode === 'fallback' && hasLiveClient()) {
      void notifyOnly(sessionId, request.questions).catch((error) =>
        logger.warn(`[lark] question notice failed: ${String(error)}`),
      )
      return next()
    }

    const callId = String(request.wait?.callId ?? newId())
    const key = `${sessionId}:${callId}`
    if (questions.has(key)) return next()

    const questionList = sanitizeQuestions(request.questions)
    const answer = withResolvers()
    const cancelSignal = attachCancelSignal(request)
    /** @type {QuestionEntry} */
    const entry = {
      key,
      sessionId,
      callId,
      questions: questionList,
      resolve: answer.resolve,
      reject: answer.reject,
      state: 'open',
      messageId: undefined,
      timed: request.wait?.timed === true,
      createdAt: Date.now(),
      cancelSignal,
      suppressed: !publishNow,
    }
    questions.set(key, entry)

    // A cancelled/timed-out turn must not leave the listener waiting for a
    // card that can no longer apply. The card itself stays answerable for a
    // timed question (state=continued).
    request.signal?.addEventListener('abort', () => {
      if (entry.state === 'open') entry.state = entry.timed ? 'continued' : 'expired'
      entry.reject(new Error('question request aborted'))
    }, { once: true })

    if (publishNow) {
      try {
        await publishQuestion(entry)
      } catch (error) {
        questions.delete(key)
        logger.warn(`[lark] question card failed: ${String(error)}`)
        if (config.answerMode === 'exclusive') {
          throw new Error(`dsh-lark-ctrl could not deliver the question: ${String(error)}`)
        }
        if (!hasLiveClient()) {
          throw new Error(`dsh-lark-ctrl could not deliver the question and no Web client is connected: ${String(error)}`)
        }
        return next()
      }
    }

    if (publishNow && config.answerMode === 'exclusive') {
      try {
        return await answer.promise
      } finally {
        questions.delete(key)
      }
    }

    return await raceQuestion(entry, next, answer)
  }

  /**
   * @param {QuestionEntry} entry
   * @param {() => Promise<any>} next
   * @param {{ promise: Promise<any> }} answer
   */
  async function raceQuestion(entry, next, answer) {
    const downstream = next()
    const web = downstream.then(
      (value) => ({ source: 'web', ok: true, value }),
      (error) => ({ source: 'web', ok: false, error }),
    )
    const lark = answer.promise.then(
      (value) => ({ source: 'lark', ok: true, value }),
      (error) => ({ source: 'lark', ok: false, error }),
    )

    const first = await Promise.race([web, lark])
    if (first.source === 'lark') {
      // The Web forwarder may still be pending; attach a no-op rejection
      // handler so a later cancellation cannot become unhandled.
      void web.catch(() => {})
      if (!first.ok) {
        questions.delete(entry.key)
        throw first.error
      }
      entry.cancelSignal?.abort(new Error('answered on Lark'))
      nudgeClient(entry.sessionId)
      await patchAnswered(entry, first.value, 'lark')
      questions.delete(entry.key)
      return first.value
    }

    if (first.ok) {
      await patchAnswered(entry, first.value, 'web')
      questions.delete(entry.key)
      return first.value
    }

    const code = String(first.error?.code ?? '')
    if (code === 'NO_PROVIDER' && (entry.messageId !== undefined || entry.suppressed === true)) {
      // The Web has no answerer; a delivered card (or a suppressed request that
      // may be promoted when the push level rises) keeps the tool call open.
      const larkOutcome = await lark
      questions.delete(entry.key)
      if (larkOutcome.ok) {
        await patchAnswered(entry, larkOutcome.value, 'lark')
        return larkOutcome.value
      }
      throw larkOutcome.error
    }

    if (entry.timed && (code === 'ASK_TIMED_OUT' || code.includes('TIMED_OUT'))) {
      // Keep the card answerable; `answerFromForm` routes the late answer
      // through `ctx.userQuestions.answer()`.
      entry.state = 'continued'
      await patchTimedOut(entry)
      throw first.error
    }

    entry.state = 'expired'
    await patchExpired(entry, '提问已结束，未收到回答。')
    questions.delete(entry.key)
    throw first.error
  }

  /** @param {QuestionEntry} entry */
  async function publishQuestion(entry) {
    const code = registry.ensureCode(entry.sessionId)
    const title = await registry.label(entry.sessionId)
    const card = fitCard(
      buildQuestionCard({
        code,
        title,
        questions: entry.questions,
        statusNote: entry.timed ? '如果等待超时，仍可通过这张卡片回复；回答会作为后续消息进入会话。' : undefined,
      }),
    )
    const result = await transport.sendCard(card, {
      idempotencyKey: `q:${entry.sessionId}:${entry.callId}`,
    })
    entry.messageId = result.messageId
    entry.suppressed = false
    if (entry.messageId !== undefined) {
      registry.link(entry.sessionId, entry.messageId, {
        kind: 'question',
        callId: entry.callId,
      })
    }
  }

  /**
   * @param {QuestionEntry} entry
   * @param {any} answer
   * @param {'lark'|'web'} source
   */
  async function patchAnswered(entry, answer, source) {
    if (entry.messageId === undefined) return
    entry.state = 'answered'
    try {
      const code = registry.ensureCode(entry.sessionId)
      const title = await registry.label(entry.sessionId)
      const answers = Array.isArray(answer?.answers) ? answer.answers : []
      const card = fitCard(
        buildAnsweredCard({
          code,
          title,
          questions: entry.questions,
          answers,
          source,
        }),
      )
      await transport.patchCard(entry.messageId, card)
    } catch (error) {
      logger.warn(`[lark] question card patch failed: ${String(error)}`)
    }
  }

  /** @param {QuestionEntry} entry */
  async function patchTimedOut(entry) {
    if (entry.messageId === undefined) return
    try {
      const code = registry.ensureCode(entry.sessionId)
      const title = await registry.label(entry.sessionId)
      const card = fitCard(
        buildQuestionCard({
          code,
          title,
          questions: entry.questions,
          statusNote: '等待窗口已结束；现在回复仍会作为后续消息发送给会话。',
        }),
      )
      await transport.patchCard(entry.messageId, card)
    } catch (error) {
      logger.warn(`[lark] question timeout patch failed: ${String(error)}`)
    }
  }

  /** @param {QuestionEntry} entry @param {string} reason */
  async function patchExpired(entry, reason) {
    if (entry.messageId === undefined) return
    entry.state = 'expired'
    try {
      const code = registry.ensureCode(entry.sessionId)
      const title = await registry.label(entry.sessionId)
      await transport.patchCard(
        entry.messageId,
        fitCard(buildExpiredQuestionCard({ code, title, reason })),
      )
    } catch (error) {
      logger.warn(`[lark] question expiry patch failed: ${String(error)}`)
    }
  }

  /* --------------------------------------------------------------------- */
  /* approvals                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * @param {any} request
   * @param {() => Promise<any>} next
   */
  async function onApproval(request, next) {
    if (disposed) return next()
    const sessionId = typeof request?.agent?.id === 'string' ? request.agent.id : undefined
    if (sessionId === undefined) return next()
    if (config.approvalMode === 'off' || !config.notifyApproval) return next()
    const publishNow = store.pushLevel() >= 1
    if (publishNow && config.approvalMode === 'no-live-client' && hasLiveClient()) return next()

    const key = `${sessionId}:${request.callId ?? newId()}`
    if (approvals.has(key)) return next()
    const deferred = withResolvers()
    const cancelSignal = attachCancelSignal(request)
    /** @type {ApprovalEntry} */
    const entry = {
      key,
      sessionId,
      toolName: typeof request.toolName === 'string' ? request.toolName : 'unknown',
      messageId: undefined,
      resolve: deferred.resolve,
      reject: deferred.reject,
      state: 'open',
      createdAt: Date.now(),
      cancelSignal,
      suppressed: !publishNow,
      request,
    }
    approvals.set(key, entry)
    request.signal?.addEventListener('abort', () => {
      if (entry.state === 'open') entry.state = 'expired'
      deferred.reject(new Error('approval request aborted'))
    }, { once: true })

    if (publishNow) {
      try {
        await publishApproval(entry, request)
      } catch (error) {
        approvals.delete(key)
        logger.warn(`[lark] approval card failed: ${String(error)}`)
        if (config.approvalMode !== 'always' && !hasLiveClient()) {
          throw new Error(`dsh-lark-ctrl could not deliver the approval request: ${String(error)}`)
        }
        return next()
      }
    }

    const downstream = next()
    const web = downstream.then(
      (value) => ({ source: 'web', ok: true, value }),
      (error) => ({ source: 'web', ok: false, error }),
    )
    const lark = deferred.promise.then(
      (value) => ({ source: 'lark', ok: true, value }),
      (error) => ({ source: 'lark', ok: false, error }),
    )
    const first = await Promise.race([web, lark])
    if (first.source === 'lark') {
      void web.catch(() => {})
      approvals.delete(key)
      if (!first.ok) {
        await patchApprovalExpired(entry)
        throw first.error
      }
      entry.cancelSignal?.abort(new Error('approval decided on Lark'))
      nudgeClient(entry.sessionId)
      await patchApprovalResolved(entry, first.value, 'lark')
      return first.value
    }
    if (first.ok) {
      approvals.delete(key)
      await patchApprovalResolved(entry, first.value, 'web')
      return first.value
    }
    const code = String(first.error?.code ?? '')
    if (code === 'NO_PROVIDER' && (entry.messageId !== undefined || entry.suppressed === true)) {
      const larkOutcome = await lark
      approvals.delete(key)
      if (larkOutcome.ok) {
        await patchApprovalResolved(entry, larkOutcome.value, 'lark')
        return larkOutcome.value
      }
      throw larkOutcome.error
    }
    approvals.delete(key)
    await patchApprovalExpired(entry)
    throw first.error
  }

  /**
   * Find the exact tool/call event that the approval request points at. DSH
   * intentionally does not duplicate arguments on the approval request; the
   * already-presented tool call is the authoritative source for the command
   * the user is being asked to approve.
   * @param {any} request
   * @returns {{ language: string, text: string } | undefined}
   */
  function approvalDetailOf(request) {
    try {
      const session = request?.agent?.session
      const events = typeof session?.snapshotEvents === 'function' ? session.snapshotEvents() : []
      const callId = request?.callId === undefined ? undefined : String(request.callId)
      let call
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event?.type !== 'tool/call') continue
        if (callId !== undefined && String(event.data?.callId) !== callId) continue
        if (callId === undefined && event.data?.name !== request.toolName) continue
        call = event
        break
      }
      if (call === undefined) return undefined
      return approvalArgumentsDetail(call.data?.arguments)
    } catch {
      return undefined
    }
  }

  /** @param {unknown} raw */
  function approvalArgumentsDetail(raw) {
    if (raw === undefined || raw === null) return undefined
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
    if (typeof text !== 'string' || text.trim() === '') return undefined
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      return { language: 'text', text: truncate(text, 6000) }
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (typeof parsed.command === 'string' && parsed.command.trim() !== '') {
        return { language: 'bash', text: truncate(parsed.command, 6000) }
      }
      if (typeof parsed.cmd === 'string' && parsed.cmd.trim() !== '') {
        return { language: 'bash', text: truncate(parsed.cmd, 6000) }
      }
      return { language: 'json', text: truncate(JSON.stringify(parsed, null, 2), 6000) }
    }
    return { language: 'text', text: truncate(text, 6000) }
  }

  /** @param {ApprovalEntry} entry @param {any} request */
  async function publishApproval(entry, request) {
    const code = registry.ensureCode(entry.sessionId)
    const title = await registry.label(entry.sessionId)
    const display = request.displayReason
    const reason = typeof display?.['zh-CN'] === 'string'
      ? display['zh-CN']
      : typeof display?.['zh_cn'] === 'string'
        ? display['zh_cn']
        : typeof display?.en === 'string'
          ? display.en
          : typeof request.reason === 'string'
            ? request.reason
            : ''
    const detail = approvalDetailOf(request)
    entry.reason = reason
    entry.detail = detail
    const card = fitCard(
      buildApprovalCard({
        code,
        title,
        toolName: entry.toolName,
        reason,
        detail,
        approvalKey: entry.key,
      }),
    )
    const result = await transport.sendCard(card, {
      idempotencyKey: `a:${entry.sessionId}:${entry.key}`,
    })
    entry.messageId = result.messageId
    entry.suppressed = false
    if (entry.messageId !== undefined) {
      registry.link(entry.sessionId, entry.messageId, {
        kind: 'approval',
        approvalKey: entry.key,
      })
    }
  }

  /**
   * @param {ApprovalEntry} entry
   * @param {string} outcome
   * @param {'lark' | 'web'} [source]
   */
  async function patchApprovalResolved(entry, outcome, source) {
    if (entry.messageId === undefined) return
    entry.state = 'answered'
    try {
      const code = registry.ensureCode(entry.sessionId)
      await transport.patchCard(
        entry.messageId,
        fitCard(buildApprovalResolvedCard({
          code,
          outcome,
          toolName: entry.toolName,
          reason: entry.reason,
          detail: entry.detail,
          source,
          decidedAt: Date.now(),
        })),
      )
    } catch (error) {
      logger.warn(`[lark] approval patch failed: ${String(error)}`)
    }
  }

  /** @param {ApprovalEntry} entry */
  async function patchApprovalExpired(entry) {
    if (entry.messageId === undefined) return
    entry.state = 'expired'
    try {
      const code = registry.ensureCode(entry.sessionId)
      await transport.patchCard(
        entry.messageId,
        fitCard(buildApprovalResolvedCard({
          code,
          outcome: 'expired',
          toolName: entry.toolName,
          reason: entry.reason,
          detail: entry.detail,
          decidedAt: Date.now(),
        })),
      )
    } catch (error) {
      logger.warn(`[lark] approval expiry patch failed: ${String(error)}`)
    }
  }

  /* --------------------------------------------------------------------- */
  /* inbound answers                                                       */
  /* --------------------------------------------------------------------- */

  /**
   * Handle a form submit on a question card. Returns a result the router can
   * turn into a short text acknowledgement; card state is patched here.
   *
   * @param {string} messageId
   * @param {unknown} formValue
   * @param {string} operatorId
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function answerFromForm(messageId, formValue, operatorId) {
    const link = registry.lookup(messageId)
    if (link === undefined) return { ok: false, error: '这张卡片已过期，找不到对应的问题。' }
    if (!transport.isAllowed(operatorId)) return { ok: false, error: '你没有权限操作这个会话。' }
    const entry = questions.get(`${link.sessionId}:${link.callId}`)
    if (entry === undefined) return { ok: false, error: '问题已结束或已答复。' }
    if (entry.state === 'answered') return { ok: false, error: '这个问题已经回答过了。' }
    const parsed = extractFormAnswers(formValue, entry.questions)
    if (parsed.error !== undefined) return { ok: false, error: parsed.error }
    const allSkipped = parsed.answers.every((item) => item.selected.length === 0 && item.custom === undefined)
    if (allSkipped) return { ok: false, error: '请先选择一个选项，或填写自定义回答。' }
    return await applyQuestionAnswer(entry, parsed.answers, 'lark')
  }

  /**
   * Handle a one-tap option button on a single-question card.
   *
   * @param {string} messageId
   * @param {Record<string, any>} value
   * @param {string} operatorId
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function answerFromChoice(messageId, value, operatorId) {
    const link = registry.lookup(messageId)
    if (link === undefined) return { ok: false, error: '这张卡片已过期，找不到对应的问题。' }
    if (!transport.isAllowed(operatorId)) return { ok: false, error: '你没有权限操作这个会话。' }
    const entry = questions.get(`${link.sessionId}:${link.callId}`)
    if (entry === undefined || entry.state === 'answered') {
      return { ok: false, error: '问题已结束或已答复。' }
    }
    if (entry.questions.length !== 1) {
      return { ok: false, error: '这个问题包含多个问题，请使用卡片表单提交。' }
    }
    const question = entry.questions[0]
    const label = typeof value.label === 'string' ? value.label : ''
    const option = (question.options ?? []).find((item) => String(item.label) === label)
    if (option === undefined) return { ok: false, error: '选项已失效，请重新打开卡片。' }
    if (typeof value.qid === 'string' && value.qid !== String(question.id)) {
      return { ok: false, error: '问题已变化，请重新打开卡片。' }
    }
    return await applyQuestionAnswer(entry, [{ id: String(question.id), selected: [String(option.label)] }], 'lark')
  }

  /**
   * Handle a plain-text reply to a question or approval card.
   *
   * @param {string} messageId
   * @param {string} text
   * @param {string} operatorId
   * @returns {Promise<{ ok: boolean, error?: string, handled?: boolean }>}
   */
  async function answerFromText(messageId, text, operatorId) {
    const link = registry.lookup(messageId)
    if (link === undefined) return { ok: false, error: '找不到这条消息对应的会话。' }
    if (!transport.isAllowed(operatorId)) return { ok: false, error: '你没有权限操作这个会话。' }

    if (link.kind === 'question') {
      if (!config.allowTextReply) return { ok: false, error: '文字回复答题已关闭，请使用卡片。' }
      const entry = questions.get(`${link.sessionId}:${link.callId}`)
      if (entry === undefined) return { ok: false, error: '问题已结束或已答复。' }
      const parsed = parseTextAnswer(text, entry.questions)
      if (parsed.error !== undefined) return { ok: false, error: parsed.error }
      return await applyQuestionAnswer(entry, parsed.answers, 'lark')
    }

    if (link.kind === 'approval') {
      const decision = parseApprovalText(text)
      if (decision === undefined) return { ok: false, error: '请回复 1（允许）或 2（拒绝）。' }
      return await answerApproval(String(link.approvalKey ?? ''), decision, operatorId)
    }

    return { ok: false, error: '这条消息不是提问卡。', handled: false }
  }

  /**
   * @param {QuestionEntry} entry
   * @param {Array<Record<string, any>>} answers
   * @param {'lark'|'web'} source
   */
  async function applyQuestionAnswer(entry, answers, source) {
    if (entry.state === 'open') {
      try {
        entry.resolve({ answers })
        logger.info(`[lark] question ${entry.callId} answered from ${source}`)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String(error) }
      }
    }
    if (entry.state === 'continued') {
      const resumed = await ctx.sessionController.resolveAgent(entry.sessionId)
      if (resumed?.error !== undefined || resumed?.agent === undefined) {
        return { ok: false, error: '会话已关闭，无法投递回答。' }
      }
      try {
        const accepted = ctx.userQuestions.answer(resumed.agent, entry.callId, { answers })
        if (accepted === true) {
          entry.state = 'answered'
          entry.cancelSignal?.abort(new Error('answered on Lark'))
          nudgeClient(entry.sessionId)
          await patchAnswered(entry, { answers }, source)
          questions.delete(entry.key)
          return { ok: true }
        }
        entry.state = 'expired'
        await patchExpired(entry, '问题已失效，回答未能投递。')
        questions.delete(entry.key)
        return { ok: false, error: '问题已失效。' }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        if (message.includes('REPLY_QUEUED')) return { ok: false, error: '这个问题已经有一个回答在排队了。' }
        return { ok: false, error: message }
      }
    }
    return { ok: false, error: '问题已结束。' }
  }

  /**
   * @param {string} key
   * @param {'allow'|'reject'} decision
   * @param {string} operatorId
   */
  async function answerApproval(key, decision, operatorId) {
    if (!transport.isAllowed(operatorId)) return { ok: false, error: '你没有权限操作这个会话。' }
    const entry = approvals.get(key)
    if (entry === undefined || entry.state !== 'open') {
      return { ok: false, error: '审批请求已结束。' }
    }
    const outcome = decision === 'allow' ? 'allowed-once' : 'rejected'
    entry.resolve(outcome)
    logger.info(`[lark] approval ${key} decided: ${outcome}`)
    return { ok: true }
  }

  /* --------------------------------------------------------------------- */
  /* helpers                                                               */
  /* --------------------------------------------------------------------- */

  /** @param {string} sessionId @param {any} questionsValue */
  async function notifyOnly(sessionId, questionsValue) {
    if (!config.notifyQuestion) return
    const code = registry.ensureCode(sessionId)
    const title = await registry.label(sessionId)
    const message = `DSH 有一个新的提问（${sanitizeQuestions(questionsValue).length} 个问题），请在 Web 端回答；回复本消息也可以查看状态。`
    const result = await transport.sendCard(fitCard(buildNoticeCard(message, code)), {
      idempotencyKey: `qn:${sessionId}:${Date.now()}`,
    })
    if (result.messageId) registry.link(sessionId, result.messageId, { kind: 'notice' })
    logger.info(`[lark] question notice sent for ${code}${title ? ` (${truncate(title, 40)})` : ''}`)
  }

  function hasLiveClient() {
    try {
      const gateway = ctx.get('typertGateway')
      return gateway?.hasLiveClient?.() === true
    } catch {
      return false
    }
  }

  function sweep() {
    const cutoff = Date.now() - CONTINUED_TTL_MS
    for (const [key, entry] of questions) {
      if (entry.state === 'continued' && entry.createdAt < cutoff) questions.delete(key)
    }
    for (const [key, entry] of approvals) {
      if (entry.state !== 'open' && entry.createdAt < cutoff) approvals.delete(key)
    }
  }

  /**
   * Publish cards for requests buffered while the push level was 0.
   * Called after `/level` or the level card raises the level to 1 or 2.
   * @returns {Promise<number>} number of cards published
   */
  async function promoteSuppressed() {
    if (disposed) return 0
    let published = 0
    for (const entry of questions.values()) {
      if (entry.suppressed !== true || entry.messageId !== undefined) continue
      if (entry.state !== 'open' && entry.state !== 'continued') continue
      try {
        await publishQuestion(entry)
        published += 1
      } catch (error) {
        logger.warn(`[lark] suppressed question promotion failed: ${String(error)}`)
      }
    }
    for (const entry of approvals.values()) {
      if (entry.suppressed !== true || entry.messageId !== undefined) continue
      if (entry.state !== 'open') continue
      if (config.approvalMode === 'no-live-client' && hasLiveClient()) continue
      try {
        await publishApproval(entry, entry.request)
        published += 1
      } catch (error) {
        logger.warn(`[lark] suppressed approval promotion failed: ${String(error)}`)
      }
    }
    return published
  }

  return {
    register,
    promoteSuppressed,
    answerFromForm,
    answerFromChoice,
    answerFromText,
    answerApproval,
    /** @param {string} messageId */
    linkFor(messageId) {
      return registry.lookup(messageId)
    },
    /** @param {string} key */
    approvalPending(key) {
      return approvals.get(key)?.state === 'open'
    },
  }
}

/** @param {unknown} value */
function sanitizeQuestions(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value.slice(0, MAX_QUESTIONS)) {
    if (typeof item !== 'object' || item === null) continue
    const options = Array.isArray(item.options)
      ? item.options
          .filter((option) => typeof option?.label === 'string')
          .map((option) => ({
            label: option.label,
            ...(typeof option.description === 'string' ? { description: option.description } : {}),
          }))
      : []
    out.push({
      id: String(item.id ?? out.length),
      question: String(item.question ?? ''),
      ...(typeof item.header === 'string' ? { header: item.header } : {}),
      ...(typeof item.detail === 'string' ? { detail: truncate(item.detail, 6000) } : {}),
      ...(options.length > 0 ? { options } : {}),
      ...(item.multiSelect === true ? { multiSelect: true } : {}),
      ...(item.intent?.kind === 'plan-review'
        ? {
            intent: {
              kind: 'plan-review',
              approve: String(item.intent.approve ?? ''),
            },
          }
        : {}),
    })
  }
  return out
}

function withResolvers() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}
