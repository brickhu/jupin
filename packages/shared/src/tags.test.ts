import { describe, expect, it } from 'vitest'
import { MAX_ARTICLE_TAGS, normalizeTags } from './tags'

describe('标签', () => {
  it('去空 + 去重 + 保序', () => {
    expect(normalizeTags([' 名言 ', '名言', '', '   ', '绕口令', 3, null])).toEqual(['名言', '绕口令'])
  })

  it('不是数组就是空数组', () => {
    for (const v of [undefined, null, '名言', 3, {}]) expect(normalizeTags(v)).toEqual([])
  })

  it('最多留 MAX_ARTICLE_TAGS 个', () => {
    const many = Array.from({ length: MAX_ARTICLE_TAGS + 5 }, (_, i) => 'T' + i)
    expect(normalizeTags(many)).toHaveLength(MAX_ARTICLE_TAGS)
  })
})
