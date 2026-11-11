import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

import { createArchive } from '../lib/archive.js'
import { normalizeConfig } from '../lib/config.js'
import {
  entriesBefore,
  formatAnswerDoc,
  parseArchiveDoc,
  parseParentUrl,
  planArchiveInsert,
  validateCutoff,
} from '../lib/archive.js'

const xml = [
  '<title id="t">dsh-lark回答</title>',
  '<h1 id="h1a">2026-11-08</h1>',
  '<h2 id="h2a">#abc234</h2>',
  '<p id="p1"><a href="https://example.feishu.cn/docx/a">[dsh-lark] 2026-11-08T02:00:00Z · 旧回答</a></p>',
  '<h2 id="h2b">#def567</h2>',
  '<h1 id="h1b">2026-11-09</h1>',
  '<h2 id="h2c">#ghi789</h2>',
  '<p id="p2"><a href="https://example.feishu.cn/docx/b">[dsh-lark] 2026-11-09T03:00:00Z · 新回答</a></p>',
].join('')

test('parses the date/code/link structure', () => {
  const doc = parseArchiveDoc(xml)
  assert.equal(doc.entries.length, 2)
  assert.deepEqual(doc.entries[0], {
    date: '2026-11-08',
    code: '#abc234',
    blockId: 'p1',
    url: 'https://example.feishu.cn/docx/a',
    text: '[dsh-lark] 2026-11-08T02:00:00Z · 旧回答',
    timestamp: '2026-11-08T02:00:00Z',
  })
  assert.deepEqual(doc.entries.map((entry) => entry.date), ['2026-11-08', '2026-11-09'])
})

test('plans insertion after an existing code heading', () => {
  const doc = parseArchiveDoc(xml)
  const plan = planArchiveInsert(doc, {
    date: '2026-11-09',
    code: 'ghi789',
    url: 'https://example.feishu.cn/docx/c',
    time: '12:00',
    title: '新回答',
  })
  assert.equal(plan.command, 'block_insert_after')
  assert.equal(plan.blockId, 'h2c')
  assert.match(plan.content, /docx\/c/)
  assert.match(plan.content, /\[dsh-lark\] 12:00/)
})

test('plans a code heading when the date exists and code is new', () => {
  const doc = parseArchiveDoc(xml)
  const plan = planArchiveInsert(doc, {
    date: '2026-11-09',
    code: 'new234',
    url: 'https://example.feishu.cn/docx/d',
    time: '12:01',
    title: '另一个回答',
  })
  assert.equal(plan.blockId, 'h1b')
  assert.match(plan.content, /^<h2>#new234<\/h2><p>/)
})

test('appends a new date section when the date is missing', () => {
  const doc = parseArchiveDoc(xml)
  const plan = planArchiveInsert(doc, {
    date: '2026-11-10',
    code: 'zzz234',
    url: 'https://example.feishu.cn/docx/e',
    time: '09:00',
    title: '新的一天',
  })
  assert.equal(plan.command, 'append')
  assert.match(plan.content, /^<h1>2026-11-10<\/h1>/)
})

test('selects only marked links before the cutoff', () => {
  const doc = parseArchiveDoc(xml)
  const entries = entriesBefore(doc, '2026-11-09')
  assert.equal(entries.length, 1)
  assert.equal(entries[0].date, '2026-11-08')
  assert.equal(entriesBefore(doc, '2026-11-08').length, 0)
  assert.equal(validateCutoff('2026-11-09'), '2026-11-09')
  assert.equal(validateCutoff('2026-02-31'), undefined)
  assert.equal(validateCutoff('11/09/2026'), undefined)
})

test('formats the full answer with metadata and image links', () => {
  const text = formatAnswerDoc({
    answer: '这里是完整回答。\n\n![截图](https://example.com/a.png)\n\n```js\nconsole.log(1)\n```',
    code: 'abc234',
    title: '测试会话',
    when: new Date(2026, 10, 9, 12, 34),
    userText: '用户问题',
  })
  assert.match(text, /#abc234/)
  assert.match(text, /2026-11-09 12:34/)
  assert.match(text, /\[截图\]\(https:\/\/example\.com\/a\.png\)/)
  assert.doesNotMatch(text, /!\[截图\]/)
  assert.match(text, /```js/)
})

test('parent URL parsing accepts wiki and docx links', () => {
  assert.deepEqual(parseParentUrl('https://example.feishu.cn/wiki/token'), {
    url: 'https://example.feishu.cn/wiki/token',
    origin: 'https://example.feishu.cn',
  })
  assert.equal(parseParentUrl('not-a-url'), undefined)
  assert.equal(parseParentUrl('https://example.feishu.cn/sheets/token'), undefined)
})


test('archiveAnswer creates a docx and inserts a marked link into the parent', async () => {
  const updates = []
  const cli = {
    async run(args, options = {}) {
      if (args[0] === 'wiki' && args[1] === '+node-get') {
        return { json: { data: {
          node_token: 'parent-node',
          obj_token: 'parent-obj',
          obj_type: 'docx',
          title: '归档',
          space_id: 'space',
        } } }
      }
      if (args[0] === 'docs' && args[1] === '+fetch') {
        return { json: { data: { document: {
          revision_id: 7,
          content: '<title id="t">归档</title><p id="empty"></p>',
        } } } }
      }
      if (args[0] === 'docs' && args[1] === '+create') {
        const written = await readFile(`${options.cwd}/answer.md`, 'utf8')
        assert.match(written, /完整回答/)
        return { json: { data: { document: {
          document_id: 'child-doc',
          url: 'https://example.feishu.cn/docx/child-doc',
        } } } }
      }
      if (args[0] === 'docs' && args[1] === '+update') {
        updates.push(args)
        return { json: { ok: true } }
      }
      throw new Error(`unexpected cli: ${args.join(' ')}`)
    },
  }
  const session = {
    snapshotEvents: () => [
      { type: 'user/message', data: { turn: 1, content: [{ type: 'text', text: '问题' }] } },
      { type: 'assistant/message', data: { turn: 1, message: { content: [{ type: 'text', text: '完整回答' }] } } },
    ],
  }
  const ctx = { sessions: { get: () => session } }
  const archive = createArchive({
    ctx,
    config: normalizeConfig({ archiveParentUrl: 'https://example.feishu.cn/wiki/parent-node' }),
    cli,
    registry: { ensureCode: () => 'abc234', label: async () => '测试标题' },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  const result = await archive.archiveAnswer({ sessionId: 's1', turn: 1 })
  assert.equal(result.url, 'https://example.feishu.cn/docx/child-doc')
  assert.equal(result.indexed, true)
  assert.equal(updates.length, 1)
  assert.match(updates[0].join(' '), /--command append/)
  assert.match(updates[0].join(' '), /\[dsh-lark\]/)
  assert.match(updates[0].join(' '), /child-doc/)
})

test('Lark-side archive URL override takes precedence and can be cleared', async () => {
  let saved = ''
  const cli = {
    async run(args) {
      if (args[0] === 'wiki' && args[1] === '+node-get') {
        return { json: { data: {
          node_token: 'node',
          obj_token: 'obj',
          obj_type: 'docx',
          title: '归档',
          space_id: 'space',
        } } }
      }
      throw new Error(`unexpected cli: ${args.join(' ')}`)
    },
  }
  const store = {
    archiveParentUrl: () => saved,
    setArchiveParentUrl: (url) => { saved = url },
  }
  const archive = createArchive({
    ctx: {},
    config: normalizeConfig({}),
    cli,
    registry: {},
    store,
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  assert.equal((await archive.status()).configured, false)
  const parent = await archive.setParentUrl('https://example.feishu.cn/wiki/archive')
  assert.equal(parent.title, '归档')
  const status = await archive.status()
  assert.equal(status.configured, true)
  assert.equal(status.source, 'lark')
  archive.clearParentUrl()
  assert.equal((await archive.status()).configured, false)
})

test('archiveAnswer returns the existing link instead of inserting the same answer twice', async () => {
  const at = new Date('2026-11-11T13:44:45Z')
  let creates = 0
  let updates = 0
  const cli = {
    async run(args) {
      if (args[0] === 'wiki' && args[1] === '+node-get') {
        return { json: { data: {
          node_token: 'parent-node',
          obj_token: 'parent-obj',
          obj_type: 'docx',
          title: '归档',
          space_id: 'space',
        } } }
      }
      if (args[0] === 'docs' && args[1] === '+fetch') {
        return { json: { data: { document: {
          revision_id: 1,
          content: '<title id="t">归档</title><h1 id="d">2026-11-11</h1><h2 id="c">#abc234</h2><p id="p"><a href="https://example.feishu.cn/docx/existing">[dsh-lark] 2026-11-11T13:44:45Z · 已回答</a></p>',
        } } } }
      }
      if (args[0] === 'docs' && args[1] === '+create') { creates += 1; throw new Error('must not create') }
      if (args[0] === 'docs' && args[1] === '+update') { updates += 1; throw new Error('must not update') }
      throw new Error(`unexpected cli: ${args.join(' ')}`)
    },
  }
  const session = {
    snapshotEvents: () => [
      { type: 'assistant/message', time: at.getTime(), data: { turn: 1, message: { content: [{ type: 'text', text: '已回答' }] } } },
    ],
  }
  const archive = createArchive({
    ctx: { sessions: { get: () => session } },
    config: normalizeConfig({ archiveParentUrl: 'https://example.feishu.cn/wiki/parent-node' }),
    cli,
    registry: { ensureCode: () => 'abc234', label: async () => '回答' },
    logger: { info: () => {}, warn: () => {}, debug: () => {} },
  })
  const result = await archive.archiveAnswer({ sessionId: 's1' })
  assert.equal(result.alreadyArchived, true)
  assert.equal(result.url, 'https://example.feishu.cn/docx/existing')
  assert.equal(creates, 0)
  assert.equal(updates, 0)
})
