import assert from 'node:assert/strict'
import { test } from 'node:test'

import { sessionCode, quoteLines, truncate, formatDuration, formatTokens, parseSessionRange, stripImages, hasImages } from '../lib/util.js'

test('session codes are stable, short and base32', () => {
  const id = 'session-e97db8f8-9076-4752-a872-75a08b3945cb'
  const code = sessionCode(id)
  assert.equal(code, sessionCode(id))
  assert.equal(code.length, 6)
  assert.match(code, /^[a-z2-7]+$/)
  assert.notEqual(sessionCode(id, 7), code)
})

test('quoteLines prefixes continuation lines', () => {
  assert.equal(quoteLines('a\nb'), 'a\n> b')
})

test('truncate keeps the cap', () => {
  assert.equal(truncate('abcdef', 4).length, 4)
  assert.equal(truncate('abc', 4), 'abc')
})

test('duration and token formatting', () => {
  assert.equal(formatDuration(1000), '1s')
  assert.equal(formatDuration(62000), '1m02s')
  assert.equal(formatTokens(12345), '12.3k')
})


test('session range parses units and rejects bad input', () => {
  assert.equal(parseSessionRange('').ms, undefined)
  assert.equal(parseSessionRange('30m').ms, 30 * 60 * 1000)
  assert.equal(parseSessionRange('12h').ms, 12 * 60 * 60 * 1000)
  assert.equal(parseSessionRange('1d').ms, 24 * 60 * 60 * 1000)
  assert.equal(parseSessionRange('2w').ms, 14 * 24 * 60 * 60 * 1000)
  assert.match(parseSessionRange('1x').error, /时间范围格式/)
  assert.match(parseSessionRange('0d').error, /正整数/)
})

test('stripImages removes image markup outside code blocks', () => {
  assert.equal(
    stripImages('前 ![截图](https://example.com/a.png) 后'),
    '前 （图片已省略） 后',
  )
  assert.equal(
    stripImages('![x](https://example.com/a_(b).png)'),
    '（图片已省略）',
  )
  assert.equal(
    stripImages('```\n![x](https://example.com/a.png)\n```\n<img src="x">'),
    '```\n![x](https://example.com/a.png)\n```\n（图片已省略）',
  )
  assert.equal(hasImages('`![x](y)`'), false)
  assert.equal(hasImages('![x](y)'), true)
  assert.equal(hasImages('普通文字'), false)
})
