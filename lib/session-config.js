/**
 * Read and mutate a Session's mode/model/thinking/permission configuration.
 *
 * The Session projection is the source of truth for the current selection;
 * `permissionPresets.current()` is a fallback for profiles that do not project
 * the permission cell. Mutations go through the same Host services the Web UI
 * uses, so they are visible there immediately.
 */

import { parseModel } from './session-create.js'

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @returns {Promise<{
 *   session?: any,
 *   provider?: string,
 *   model?: string,
 *   modelValue?: string,
 *   effort?: string,
 *   permission?: string,
 *   agentPreset?: string,
 * }>}
 */
export async function readSessionConfig(ctx, sessionId) {
  let session = ctx.sessions.get(sessionId)
  if (session === undefined) {
    try {
      const resumed = await ctx.sessionController.resolveAgent(sessionId)
      session = resumed?.agent?.session
    } catch {
      session = undefined
    }
  }
  if (session === undefined) return {}

  let values = {}
  try {
    values = ctx.sessionProjections?.snapshot?.(session)?.values ?? {}
  } catch {
    values = {}
  }

  const selection = values.modelSelection?.next ?? values.modelSelection?.lastUsed ?? undefined
  let permission = typeof values.permissions?.currentValue === 'string'
    ? values.permissions.currentValue
    : undefined
  if (permission === undefined && ctx.get('permissionPresets') !== undefined) {
    try {
      permission = ctx.get('permissionPresets').current(session)
    } catch {
      permission = undefined
    }
  }

  const provider = typeof selection?.provider === 'string' ? selection.provider : undefined
  const model = typeof selection?.model === 'string' ? selection.model : undefined
  const effort = typeof selection?.reasoningEffort === 'string' ? selection.reasoningEffort : ''
  const agentPreset = typeof values.agentPreset === 'string' ? values.agentPreset : undefined

  return {
    session,
    provider,
    model,
    modelValue: provider !== undefined && model !== undefined ? `${provider}::${model}` : '',
    effort,
    permission,
    agentPreset,
  }
}

/**
 * Apply permission/model/thinking changes to a live (or resumable) Session.
 * Permission changes apply immediately; model/effort apply to the next request,
 * so this is safe while a turn is running.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {{ permission?: string, model?: string, effort?: string }} input
 * @returns {Promise<any>} the live Session
 */
export async function applySessionConfig(ctx, sessionId, input) {
  const config = await readSessionConfig(ctx, sessionId)
  if (config.session === undefined) throw new Error('会话无法恢复为 live，暂时不能修改配置。')

  if (typeof input.permission === 'string' && input.permission !== '') {
    const service = ctx.get('permissionPresets')
    if (service === undefined) throw new Error('权限预设服务不可用。')
    service.set(config.session, input.permission)
  }

  if (typeof input.model === 'string' && input.model !== '') {
    const parsed = parseModel(input.model)
    if (parsed === undefined) throw new Error('模型选项无效。')
    await ctx.sessionController.selectModel({
      sessionId,
      provider: parsed.provider,
      model: parsed.model,
      ...(typeof input.effort === 'string' && input.effort !== ''
        ? { reasoningEffort: input.effort }
        : {}),
    })
  } else if (typeof input.effort === 'string' && input.effort !== '') {
    throw new Error('选择 Thinking effort 前需要先选择模型。')
  }

  return config.session
}

/**
 * Validate a model/effort/permission choice against the options rendered on
 * the card. Returns a user-facing message, or undefined when valid.
 * @param {{ models?: any[], permissions?: any[] }} options
 * @param {{ permission?: string, model?: string, effort?: string }} input
 * @returns {string | undefined}
 */
export function validateConfigChoice(options, input) {
  if (typeof input.permission === 'string' && input.permission !== '') {
    if (!(options.permissions ?? []).some((option) => option.value === input.permission)) {
      return '权限选项已失效，请刷新卡片后重试。'
    }
  }
  if (typeof input.model === 'string' && input.model !== '') {
    const model = (options.models ?? []).find((option) => option.value === input.model)
    if (model === undefined) return '模型选项已失效，请刷新卡片后重试。'
    if (typeof input.effort === 'string' && input.effort !== ''
      && !(model.efforts ?? []).includes(input.effort)) {
      return '该模型不支持所选的 Thinking effort。'
    }
  } else if (typeof input.effort === 'string' && input.effort !== '') {
    return '选择 Thinking effort 前需要先选择模型。'
  }
  return undefined
}
