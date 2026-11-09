/**
 * Long-answer archive for `/btw`-free full answers.
 *
 * The archive is a Wiki-hosted docx. Its body is the only source of truth:
 *
 *   h1  2026-11-09
 *   h2  #abc123
 *   p   [dsh-lark] 14:30 · 会话标题
 *
 * No archive structure is persisted locally. Every mutation fetches the parent
 * document, parses its current XML, and inserts/deletes against the latest
 * revision. That also makes concurrent DSH hosts converge through revision
 * retries and leaves user edits intact.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { contentText, truncate } from './util.js'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CODE_RE = /^#[a-z2-7]{4,12}$/i
const MARKER = '[dsh-lark]'
const RETRY_LIMIT = 3

/** @param {unknown} value */
export function xmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/** @param {unknown} value */
export function xmlAttr(value) {
  return xmlText(value).replaceAll('\n', '&#10;')
}

/** @param {unknown} value */
export function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
}

/** @param {string} value */
export function stripXmlTags(value) {
  return decodeXml(String(value ?? '').replace(/<[^>]*>/g, '')).trim()
}

/**
 * @param {string} value
 * @returns {{ url: string, origin: string } | undefined}
 */
export function parseParentUrl(value) {
  let url
  try {
    url = new URL(String(value ?? '').trim())
  } catch {
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  if (!url.pathname.startsWith('/wiki/') && !url.pathname.startsWith('/docx/')) return undefined
  return { url: url.toString(), origin: url.origin }
}

/**
 * Parse the archive parent's XML. Only top-level h1/h2/p blocks are relevant;
 * nested user content is ignored unless it is one of our marked link paragraphs.
 * @param {string} xml
 */
export function parseArchiveDoc(xml) {
  const blocks = []
  const entries = []
  const pattern = /<(h1|h2|p)\b([^>]*)>([\s\S]*?)<\/\1>/g
  let currentDate
  let currentCode
  let match
  while ((match = pattern.exec(String(xml ?? ''))) !== null) {
    const tag = match[1]
    const attrs = match[2]
    const inner = match[3]
    const idMatch = /\bid="([^"]*)"/.exec(attrs)
    const id = idMatch === null ? undefined : idMatch[1]
    const text = stripXmlTags(inner)
    const block = { tag, id, text }
    blocks.push(block)
    if (tag === 'h1') {
      currentDate = DATE_RE.test(text) ? text : undefined
      currentCode = undefined
      continue
    }
    if (tag === 'h2') {
      currentCode = CODE_RE.test(text) ? text : undefined
      continue
    }
    const link = /<a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(inner)
    if (link === null) continue
    const linkText = stripXmlTags(link[2])
    if (!linkText.includes(MARKER)) continue
    entries.push({
      date: currentDate,
      code: currentCode,
      blockId: id,
      url: decodeXml(link[1]),
      text: linkText,
    })
  }
  return { blocks, entries }
}

/**
 * @param {ReturnType<typeof parseArchiveDoc>} doc
 * @param {string} date
 */
export function dateBlockOf(doc, date) {
  return doc.blocks.find((block) => block.tag === 'h1' && block.text === date)
}

/**
 * @param {ReturnType<typeof parseArchiveDoc>} doc
 * @param {string} date
 * @param {string} code
 */
export function codeBlockOf(doc, date, code) {
  const heading = dateBlockOf(doc, date)
  if (heading === undefined) return undefined
  const start = doc.blocks.indexOf(heading)
  const target = `#${code}`
  for (let index = start + 1; index < doc.blocks.length; index += 1) {
    const block = doc.blocks[index]
    if (block.tag === 'h1') break
    if (block.tag === 'h2' && block.text === target) return block
  }
  return undefined
}

/**
 * @param {{ date: string, code: string, url: string, time: string, title: string }} entry
 */
export function linkParagraph(entry) {
  const label = `${MARKER} ${entry.time} · ${entry.title}`
  return `<p><a href="${xmlAttr(entry.url)}">${xmlText(label)}</a></p>`
}

/**
 * @param {ReturnType<typeof parseArchiveDoc>} doc
 * @param {{ date: string, code: string, url: string, time: string, title: string }} entry
 * @returns {{ command: 'append' | 'block_insert_after', blockId?: string, content: string }}
 */
export function planArchiveInsert(doc, entry) {
  const date = dateBlockOf(doc, entry.date)
  if (date === undefined || date.id === undefined) {
    return {
      command: 'append',
      content: `<h1>${xmlText(entry.date)}</h1><h2>#${xmlText(entry.code)}</h2>${linkParagraph(entry)}`,
    }
  }
  const code = codeBlockOf(doc, entry.date, entry.code)
  if (code !== undefined && code.id !== undefined) {
    return { command: 'block_insert_after', blockId: code.id, content: linkParagraph(entry) }
  }
  return {
    command: 'block_insert_after',
    blockId: date.id,
    content: `<h2>#${xmlText(entry.code)}</h2>${linkParagraph(entry)}`,
  }
}

/**
 * @param {ReturnType<typeof parseArchiveDoc>} doc
 * @param {string} cutoff YYYY-MM-DD
 */
export function entriesBefore(doc, cutoff) {
  return doc.entries
    .filter((entry) => typeof entry.date === 'string' && entry.date < cutoff)
    .sort((left, right) => `${left.date}:${left.code}:${left.url}`.localeCompare(`${right.date}:${right.code}:${right.url}`))
}

/** @param {string} value */
export function validateCutoff(value) {
  const text = String(value ?? '').trim()
  if (!DATE_RE.test(text)) return undefined
  const date = new Date(`${text}T00:00:00Z`)
  if (!Number.isFinite(date.getTime())) return undefined
  return date.toISOString().slice(0, 10) === text ? text : undefined
}

/** @param {Date} when */
export function dateLabel(when) {
  return `${when.getFullYear()}-${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')}`
}

/** @param {Date} when */
export function timeLabel(when) {
  return `${String(when.getHours()).padStart(2, '0')}:${String(when.getMinutes()).padStart(2, '0')}`
}

/**
 * Convert Markdown/HTML image references into plain links. Feishu import may
 * try to download remote images; links keep the answer complete without making
 * archiving depend on an external image host.
 * @param {string} answer
 */
export function imagesToLinks(answer) {
  const text = String(answer ?? '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, url) => {
      const label = String(alt ?? '').trim() || '图片'
      return `[${label}](${url})`
    })
    .replace(/<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi, (_match, url) => `[图片](${url})`)
  return text
}

/**
 * @param {object} input
 * @param {string} input.answer
 * @param {string} input.code
 * @param {string} input.title
 * @param {Date} input.when
 * @param {string} [input.userText]
 */
export function formatAnswerDoc(input) {
  const date = dateLabel(input.when)
  const time = timeLabel(input.when)
  const answer = imagesToLinks(input.answer)
  const user = truncate(String(input.userText ?? '').trim(), 500)
  const lines = [
    `**会话**：#${input.code} · ${truncate(input.title || '会话', 100)}`,
    `**时间**：${date} ${time}`,
    ...(user !== '' ? ['', `**用户输入**：`, ...user.split('\n').map((line) => `> ${line}`)] : []),
    '',
    '---',
    '',
    answer,
  ]
  return lines.join('\n')
}

/**
 * @param {object} deps
 * @param {import('@deepseek-ai/cordis').Context} deps.ctx
 * @param {ReturnType<import('./config.js').normalizeConfig>} deps.config
 * @param {ReturnType<import('./lark-cli.js').createLarkCli>} deps.cli
 * @param {ReturnType<import('./registry.js').createRegistry>} deps.registry
 * @param {{ info: Function, warn: Function, debug: Function }} deps.logger
 */
export function createArchive({ ctx, config, cli, registry, logger }) {
  /** @returns {boolean} */
  function configured() {
    return typeof config.archiveParentUrl === 'string' && config.archiveParentUrl.trim() !== ''
  }

  /**
   * @param {string[]} args
   * @param {{ timeout?: number, allowFailure?: boolean, cwd?: string }} [options]
   */
  function userCli(args, options = {}) {
    return cli.run([...args, '--as', 'user'], { timeout: 60000, ...options })
  }

  /** @returns {Promise<any>} */
  async function resolveParent() {
    if (!configured()) throw new Error('未配置 archiveParentUrl；请在 profile 的 dsh-lark-ctrl 配置里填写归档 wiki 文档 URL。')
    const parsed = parseParentUrl(config.archiveParentUrl)
    if (parsed === undefined) throw new Error('archiveParentUrl 必须是 /wiki/ 或 /docx/ 的飞书文档 URL。')
    const { json } = await userCli([
      'wiki', '+node-get', '--node-token', parsed.url, '--format', 'json',
    ])
    const node = json?.data
    if (node === undefined || typeof node.node_token !== 'string') {
      throw new Error('无法解析归档父文档，请检查 URL 与权限。')
    }
    if (node.obj_type !== 'docx') {
      throw new Error(`归档父文档必须是 docx，当前为 ${String(node.obj_type ?? 'unknown')}。`)
    }
    return {
      url: parsed.url,
      origin: parsed.origin,
      nodeToken: node.node_token,
      objToken: node.obj_token,
      spaceId: node.space_id,
      title: typeof node.title === 'string' ? node.title : '',
    }
  }

  /**
   * @param {Awaited<ReturnType<typeof resolveParent>>} parent
   */
  async function fetchParent(parent) {
    const { json } = await userCli([
      'docs', '+fetch', '--doc', parent.url, '--doc-format', 'xml',
      '--detail', 'with-ids', '--format', 'json',
    ])
    const document = json?.data?.document
    if (document === undefined || typeof document.content !== 'string') {
      throw new Error('无法读取归档父文档内容。')
    }
    return {
      revisionId: typeof document.revision_id === 'number' || (typeof document.revision_id === 'string' && document.revision_id !== '')
        ? document.revision_id
        : undefined,
      content: document.content,
      doc: parseArchiveDoc(document.content),
    }
  }

  /**
   * @param {any} parent
   * @param {{ date: string, code: string, url: string, time: string, title: string }} entry
   */
  async function insertLink(parent, entry) {
    let lastError
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
      const current = await fetchParent(parent)
      const plan = planArchiveInsert(current.doc, entry)
      const args = [
        'docs', '+update', '--doc', parent.url, '--doc-format', 'xml',
        '--command', plan.command,
      ]
      if (plan.blockId !== undefined) args.push('--block-id', plan.blockId)
      args.push('--content', plan.content)
      if (current.revisionId !== undefined) args.push('--revision-id', String(current.revisionId))
      try {
        await userCli(args)
        return
      } catch (error) {
        lastError = error
        if (!isConflict(error) || attempt === RETRY_LIMIT - 1) throw error
        await sleep(150 * (attempt + 1))
      }
    }
    throw lastError ?? new Error('写入归档索引失败。')
  }

  /**
   * Delete one marked link paragraph by URL, refetching after a revision conflict.
   * @param {any} parent
   * @param {string} url
   */
  async function deleteLink(parent, url) {
    let lastError
    for (let attempt = 0; attempt < RETRY_LIMIT; attempt += 1) {
      const current = await fetchParent(parent)
      const entry = current.doc.entries.find((candidate) => candidate.url === url)
      if (entry === undefined || entry.blockId === undefined) return
      const args = [
        'docs', '+update', '--doc', parent.url, '--doc-format', 'xml',
        '--command', 'block_delete', '--block-id', entry.blockId,
      ]
      if (current.revisionId !== undefined) args.push('--revision-id', String(current.revisionId))
      try {
        await userCli(args)
        return
      } catch (error) {
        lastError = error
        if (!isConflict(error) || attempt === RETRY_LIMIT - 1) throw error
        await sleep(150 * (attempt + 1))
      }
    }
    throw lastError ?? new Error('删除归档索引失败。')
  }

  /**
   * @param {string} sessionId
   * @param {number | undefined} turn
   */
  async function readAnswer(sessionId, turn) {
    let events = []
    const live = ctx.sessions.get(sessionId)
    if (live !== undefined) {
      events = live.snapshotEvents()
    } else {
      try {
        const inspected = await ctx.sessionController.inspect(sessionId)
        events = Array.isArray(inspected?.events) ? inspected.events : []
      } catch (error) {
        logger.warn(`[lark] archive inspect failed: ${String(error)}`)
      }
      if (events.length === 0 && ctx.sessionQuery?.readSession !== undefined) {
        try {
          const snapshot = await ctx.sessionQuery.readSession(sessionId)
          events = Array.isArray(snapshot?.events) ? snapshot.events : []
        } catch (error) {
          logger.warn(`[lark] archive session read failed: ${String(error)}`)
        }
      }
    }
    const assistant = events
      .filter((event) => event?.type === 'assistant/message')
      .filter((event) => turn === undefined || event?.data?.turn === turn)
      .at(-1)
    if (assistant === undefined) throw new Error('找不到对应的完整回答。')
    const answer = contentText(assistant.data?.message?.content)
    if (answer === '') throw new Error('完整回答为空。')
    const user = events
      .filter((event) => event?.type === 'user/message')
      .filter((event) => turn === undefined || (event?.data?.turn ?? 0) <= turn)
      .at(-1)
    return {
      answer,
      userText: user === undefined ? '' : contentText(user.data?.content),
    }
  }

  /**
   * @param {object} input
   * @param {string} input.sessionId
   * @param {number} [input.turn]
   */
  async function archiveAnswer(input) {
    const parent = await resolveParent()
    const code = registry.ensureCode(input.sessionId)
    const title = await registry.label(input.sessionId)
    const { answer, userText } = await readAnswer(input.sessionId, input.turn)
    const when = new Date()
    const content = formatAnswerDoc({ answer, code, title, when, userText })
    const dir = await mkdtemp(join(tmpdir(), 'dsh-lark-archive-'))
    let created
    try {
      await writeFile(join(dir, 'answer.md'), content, 'utf8')
      const { json } = await userCli([
        'docs', '+create', '--doc-format', 'markdown',
        '--content', '@./answer.md',
        '--title', truncate(`#${code} ${title || '回答'}`, 80),
        '--parent-token', parent.nodeToken,
        '--format', 'json',
      ], { cwd: dir, timeout: 120000 })
      const document = json?.data?.document
      if (document === undefined || typeof document.document_id !== 'string') {
        throw new Error('飞书文档创建未返回 document_id。')
      }
      created = {
        documentId: document.document_id,
        url: typeof document.url === 'string' && document.url !== ''
          ? document.url
          : `${parent.origin}/docx/${document.document_id}`,
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
    try {
      await insertLink(parent, {
        date: dateLabel(when),
        code,
        url: created.url,
        time: timeLabel(when),
        title: truncate(title || '会话', 80),
      })
      return { ...created, parentUrl: parent.url, parentTitle: parent.title, indexed: true }
    } catch (error) {
      return {
        ...created,
        parentUrl: parent.url,
        parentTitle: parent.title,
        indexed: false,
        warning: `文档已创建，但写入归档索引失败：${String(error)}`,
      }
    }
  }

  /** @param {string} cutoff */
  async function planDelete(cutoff) {
    const parent = await resolveParent()
    const current = await fetchParent(parent)
    const entries = entriesBefore(current.doc, cutoff)
    return {
      parent,
      cutoff,
      count: entries.length,
      dates: [...new Set(entries.map((entry) => entry.date))].filter(Boolean),
      entries,
    }
  }

  /** @param {string} cutoff */
  async function deleteBefore(cutoff) {
    const parent = await resolveParent()
    const current = await fetchParent(parent)
    const entries = entriesBefore(current.doc, cutoff)
    let deleted = 0
    const failed = []
    for (const entry of entries) {
      let documentGone = false
      const removal = await userCli([
        'wiki', '+node-delete', '--node-token', entry.url, '--yes',
      ], { allowFailure: true, timeout: 60000 })
      if (removal.failure !== undefined) {
        if (isNotFound(removal.failure)) documentGone = true
        else {
          failed.push({ url: entry.url, error: failureText(removal.failure) })
          continue
        }
      } else {
        documentGone = true
      }
      if (!documentGone) continue
      try {
        await deleteLink(parent, entry.url)
        deleted += 1
      } catch (error) {
        failed.push({ url: entry.url, error: `文档已删除，但索引链接删除失败：${String(error)}` })
      }
    }
    return { cutoff, deleted, failed, total: entries.length }
  }

  async function status() {
    if (!configured()) {
      return { configured: false, parentUrl: config.archiveParentUrl, parentTitle: '', error: undefined }
    }
    try {
      const parent = await resolveParent()
      return { configured: true, parentUrl: parent.url, parentTitle: parent.title, error: undefined }
    } catch (error) {
      return {
        configured: true,
        parentUrl: config.archiveParentUrl,
        parentTitle: '',
        error: String(error),
      }
    }
  }

  return {
    configured,
    status,
    archiveAnswer,
    planDelete,
    deleteBefore,
    validateCutoff,
  }
}

/** @param {any} error */
function isConflict(error) {
  const text = `${String(error?.code ?? '')} ${String(error?.subtype ?? '')} ${String(error?.message ?? '')}`
  return /revision|conflict|version|stale|409/i.test(text)
}

/** @param {any} failure */
function isNotFound(failure) {
  const text = failureText(failure)
  return /not.?found|131005|131012|404/i.test(text)
}

/** @param {any} failure */
function failureText(failure) {
  return `${String(failure?.subtype ?? '')} ${String(failure?.type ?? '')} ${String(failure?.message ?? '')}`.trim()
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
