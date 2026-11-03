/**
 * Configuration normalization for the dsh-lark-ctrl bundle.
 *
 * The bundle deliberately does not export a `Config` schema: it is installed
 * into a profile whose node_modules may not resolve `@deepseek-ai/schemastery`,
 * and a host-only plugin has no build step. Normalization is therefore manual
 * and defensive; unknown keys are ignored instead of failing activation.
 */

import { isRecord } from './util.js'

const DEFAULTS = {
  larkCli: 'lark-cli',
  identity: 'bot',

  targetUserId: '',
  targetChatId: '',
  allowUsers: [],

  notifySessionStart: true,
  notifySessionEnd: true,
  notifyQuestion: true,
  notifyApproval: true,
  approvalMode: 'always',
  includeSubagents: false,
  startupMessage: true,

  answerMode: 'race',
  allowTextReply: true,

  summaryMaxChars: 1500,
  idleGraceMs: 3000,

  btwMode: 'auto',
  btwRoute: '/api/btw.ask',
  btwTimeoutMs: 60000,

  defaultPushLevel: 2,
  maxWorkspaces: 10,
  maxWorkspaceSessions: 20,

  defaultTarget: 'last',
  maxPromptChars: 8000,
  maxInboundPerMinute: 30,

  language: 'zh-CN',
  storeDir: '',
  debug: false,
}

const APPROVAL_MODES = new Set(['always', 'no-live-client', 'off'])
const ANSWER_MODES = new Set(['race', 'fallback', 'exclusive', 'off'])
const BTW_MODES = new Set(['auto', 'snapshot', 'off'])
const DEFAULT_TARGETS = new Set(['last', 'require-hash'])

/**
 * Merge one Loader row's config over the defaults.
 * @param {unknown} raw - the row's config object.
 * @returns {typeof DEFAULTS & { warnings: string[] }}
 */
export function normalizeConfig(raw) {
  const input = isRecord(raw) ? raw : {}
  const warnings = []

  const identity = input.identity === 'user' ? 'user' : 'bot'
  if (input.identity !== undefined && input.identity !== 'bot' && input.identity !== 'user') {
    warnings.push(`identity must be "bot" or "user"; using "bot"`)
  }

  const approvalMode = pick(input.approvalMode, APPROVAL_MODES, DEFAULTS.approvalMode, warnings, 'approvalMode')
  const answerMode = pick(input.answerMode, ANSWER_MODES, DEFAULTS.answerMode, warnings, 'answerMode')
  const btwMode = pick(input.btwMode, BTW_MODES, DEFAULTS.btwMode, warnings, 'btwMode')
  const defaultTarget = pick(input.defaultTarget, DEFAULT_TARGETS, DEFAULTS.defaultTarget, warnings, 'defaultTarget')

  const allowUsers = Array.isArray(input.allowUsers)
    ? [...new Set(input.allowUsers.filter((value) => typeof value === 'string' && value.startsWith('ou_')))]
    : []

  return {
    larkCli: text(input.larkCli, DEFAULTS.larkCli),
    identity,

    targetUserId: text(input.targetUserId, DEFAULTS.targetUserId),
    targetChatId: text(input.targetChatId, DEFAULTS.targetChatId),
    allowUsers,

    notifySessionStart: bool(input.notifySessionStart, DEFAULTS.notifySessionStart),
    notifySessionEnd: bool(input.notifySessionEnd, DEFAULTS.notifySessionEnd),
    notifyQuestion: bool(input.notifyQuestion, DEFAULTS.notifyQuestion),
    notifyApproval: bool(input.notifyApproval, DEFAULTS.notifyApproval),
    approvalMode,
    includeSubagents: bool(input.includeSubagents, DEFAULTS.includeSubagents),
    startupMessage: bool(input.startupMessage, DEFAULTS.startupMessage),

    answerMode,
    allowTextReply: bool(input.allowTextReply, DEFAULTS.allowTextReply),

    summaryMaxChars: integer(input.summaryMaxChars, DEFAULTS.summaryMaxChars, 200, 6000),
    idleGraceMs: integer(input.idleGraceMs, DEFAULTS.idleGraceMs, 300, 30000),

    btwMode,
    btwRoute: route(input.btwRoute, DEFAULTS.btwRoute, warnings),
    btwTimeoutMs: integer(input.btwTimeoutMs, DEFAULTS.btwTimeoutMs, 5000, 600000),

    defaultPushLevel: integer(input.defaultPushLevel, DEFAULTS.defaultPushLevel, 0, 2),
    maxWorkspaces: integer(input.maxWorkspaces, DEFAULTS.maxWorkspaces, 1, 50),
    maxWorkspaceSessions: integer(input.maxWorkspaceSessions, DEFAULTS.maxWorkspaceSessions, 1, 100),

    defaultTarget,
    maxPromptChars: integer(input.maxPromptChars, DEFAULTS.maxPromptChars, 1, 100000),
    maxInboundPerMinute: integer(input.maxInboundPerMinute, DEFAULTS.maxInboundPerMinute, 1, 600),

    language: input.language === 'en' ? 'en' : 'zh-CN',
    storeDir: text(input.storeDir, DEFAULTS.storeDir),
    debug: bool(input.debug, DEFAULTS.debug),

    warnings,
  }
}

/**
 * @param {unknown} value
 * @param {string} fallback
 */
function text(value, fallback) {
  return typeof value === 'string' ? value.trim() : fallback
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 */
function bool(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {number} minimum
 * @param {number} maximum
 */
function integer(value, fallback, minimum, maximum) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.max(minimum, Math.min(maximum, Math.trunc(value)))
}

/**
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @param {string} fallback
 * @param {string[]} warnings
 * @param {string} name
 */
function pick(value, allowed, fallback, warnings, name) {
  if (typeof value === 'string' && allowed.has(value)) return value
  if (value !== undefined) warnings.push(`${name} must be one of ${[...allowed].join('|')}; using ${fallback}`)
  return fallback
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @param {string[]} warnings
 */
function route(value, fallback, warnings) {
  const candidate = text(value, fallback)
  if (!candidate.startsWith('/api/')) {
    warnings.push(`btwRoute must start with /api/; using ${fallback}`)
    return fallback
  }
  return candidate
}

export { DEFAULTS }
