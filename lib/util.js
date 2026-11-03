/**
 * Small shared helpers. Kept dependency-free so every module can import it
 * without pulling in Host services.
 */

import { createHash, randomUUID } from 'node:crypto'
import { basename } from 'node:path'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Stable short session code. Six base32 characters carry 30 bits; collisions
 * are checked by the registry and extended to 7/8 characters when needed.
 * @param {string} sessionId
 * @param {number} [length]
 * @returns {string}
 */
export function sessionCode(sessionId, length = 6) {
  const digest = createHash('sha256').update(String(sessionId)).digest()
  let buffer = 0
  let bits = 0
  let out = ''
  for (const byte of digest) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(buffer >>> (bits - 5)) & 31]
      bits -= 5
      if (out.length === length) return out
    }
  }
  while (out.length < length) out += 'a'
  return out
}

/** @param {string} value @param {number} [length] */
export function sha1(value, length = 40) {
  return createHash('sha1').update(value).digest('hex').slice(0, length)
}

/** @returns {string} */
export function newId() {
  return randomUUID()
}

/**
 * @param {string} value
 * @param {number} max
 * @returns {string}
 */
export function truncate(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** @param {unknown} value */
export function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {unknown} value */
export function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== ''
}

/**
 * @param {string} text
 * @returns {object | undefined}
 */
export function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** @param {number} ms */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** @param {number} ms */
export function formatDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes < 60) return `${minutes}m${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
}

/** @param {number} ms */
export function formatTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** @param {string | undefined} cwd */
export function displayCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return ''
  return basename(cwd) || cwd
}

/**
 * Extract text blocks from a message content array.
 * @param {unknown} content
 * @returns {string}
 */
export function contentText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => isRecord(block) && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Escape a small set of markdown-sensitive characters for card body text.
 * Lark cards render markdown, so user content is placed in fenced or quoted
 * blocks where possible; this handles the inline cases.
 * @param {string} value
 */
export function escapeMarkdown(value) {
  return String(value ?? '').replace(/([\\`*_{}[\]()#+.!|>~-])/g, '\\$1')
}

/**
 * Prefix every line for a Lark markdown blockquote (the leading `>` is added
 * by the caller).
 * @param {string} value
 */
export function quoteLines(value) {
  return String(value ?? '').split('\n').join('\n> ')
}

/**
 * Parse a `/sessions` time range such as `30m`, `12h`, `1d`, `2w`.
 * An empty value means no filter.
 * @param {unknown} value
 * @returns {{ ms?: number, label: string, error?: string }}
 */
export function parseSessionRange(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === '') return { label: '全部' }
  const match = /^(\d+)\s*([mhdw])$/.exec(text)
  if (match === null) {
    return { label: text, error: '时间范围格式：30m / 12h / 1d / 2w（m=分钟，h=小时，d=天，w=周）。' }
  }
  const amount = Number.parseInt(match[1], 10)
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    return { label: text, error: '时间范围必须是正整数，例如 1d。' }
  }
  const unit = match[2]
  const factor = unit === 'm' ? 60 * 1000 : unit === 'h' ? 60 * 60 * 1000 : unit === 'd' ? 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000
  const unitText = unit === 'm' ? '分钟' : unit === 'h' ? '小时' : unit === 'd' ? '天' : '周'
  return { ms: Math.min(amount * factor, 365 * 24 * 60 * 60 * 1000), label: `最近 ${amount} ${unitText}` }
}

/**
 * Human friendly token count.
 * @param {number} count
 */
export function formatTokens(count) {
  if (!Number.isFinite(count) || count <= 0) return '0'
  if (count < 1000) return String(count)
  return `${(count / 1000).toFixed(1)}k`
}

/**
 * Coerce a value to a non-negative integer.
 * @param {unknown} value
 */
export function nonNegativeInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
}

/* ------------------------------------------------------------------------- */
/* Lark markdown image sanitization                                          */
/* ------------------------------------------------------------------------- */

/**
 * Lark Card 2.0 markdown images require an uploaded `img_key`; a normal
 * markdown image URL is not rendered and can make the card fall back to raw
 * markdown. Strip image markup outside fenced/inline code and leave a visible
 * placeholder instead. Code samples remain untouched.
 *
 * @param {unknown} value
 * @returns {{ text: string, stripped: boolean }}
 */
function sanitizeImages(value) {
  const text = String(value ?? '')
  // Capturing group makes the code segments odd indexes in `split`.
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g)
  let stripped = false
  for (let index = 0; index < segments.length; index += 1) {
    if (index % 2 === 1) continue
    let segment = segments[index]
    segment = segment.replace(/!\[[^\]]*\]\((?:[^()]|\([^)]*\))*\)/g, () => {
      stripped = true
      return '（图片已省略）'
    })
    segment = segment.replace(/!\[[^\]]*\]\[[^\]]*\]/g, () => {
      stripped = true
      return '（图片已省略）'
    })
    segment = segment.replace(/<img\b[^>]*>/gi, () => {
      stripped = true
      return '（图片已省略）'
    })
    segments[index] = segment
  }
  return { text: segments.join(''), stripped }
}

/**
 * Remove markdown/HTML images outside code blocks for Lark card markdown.
 * @param {unknown} value
 * @returns {string}
 */
export function stripImages(value) {
  return sanitizeImages(value).text
}

/**
 * Whether text contains image markup outside code blocks.
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasImages(value) {
  return sanitizeImages(value).stripped
}
