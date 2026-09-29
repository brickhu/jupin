import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { ARTICLE_ID_LENGTH } from './constants/index'
import { articleIdOf } from './article-id'

/**
 * ⚠️⚠️ 这个测试**唯一的作用**是给纯实现的 sha256 拍板：
 *    `articleIdOf` 不能用 `node:crypto`（shared 要被小程序构建依赖，那边没有内置模块），
 *    所以 shared 里是一份手写的 sha256。手写实现有写错的风险 ⇒
 *    这里拿 `node:crypto` 的结果**逐字节对拍**（含中文、emoji、超长文本、边界长度）。
 *
 * ⚠️ 也守"归一化只有 trim"这一条：改口径必须配一次全量重命名，不能顺手做。
 */
const nodeHash = (text: string): string =>
  createHash('sha256').update(text.trim()).digest('hex').slice(0, ARTICLE_ID_LENGTH)

describe('articleIdOf —— 纯实现 sha256 必须与 node:crypto 一致', () => {
  const cases = [
    '',
    'Hello world.',
    '  Hello world.  ', // 首尾空格被 trim
    'Everything should be made as simple as possible, but not simpler.',
    '简单就是终极的复杂。', // 多字节 UTF-8
    'Don’t count the days, make the days count.', // 弯引号
    'emoji 混排 🎧🇨🇳 也要一致',
    'a'.repeat(55), // padding 边界：55 / 56 / 63 / 64 / 65
    'a'.repeat(56),
    'a'.repeat(63),
    'a'.repeat(64),
    'a'.repeat(65),
    'b'.repeat(119),
    'c'.repeat(120),
    'x'.repeat(5000), // 多块
    '\n换行与\t制表符',
  ]

  it.each(cases)('文本 %#（长度 %s）与 node:crypto 一致', (text) => {
    expect(articleIdOf(text)).toBe(nodeHash(text))
  })

  it('id 长度恒为 ARTICLE_ID_LENGTH，且全为小写十六进制', () => {
    for (const text of cases) {
      const id = articleIdOf(text)
      expect(id).toHaveLength(ARTICLE_ID_LENGTH)
      expect(id).toMatch(/^[0-9a-f]+$/)
    }
  })

  it('归一化只有 trim：大小写与内部空白**不**折叠（折叠会让历史 id 全部失配）', () => {
    expect(articleIdOf('Hello')).not.toBe(articleIdOf('hello'))
    expect(articleIdOf('a b')).not.toBe(articleIdOf('a  b'))
    // 但纯首尾空格要归一
    expect(articleIdOf('  Hello  ')).toBe(articleIdOf('Hello'))
  })
})
