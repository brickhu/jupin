import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_LABEL,
  DIFFICULTY_ORDER,
  MAX_ARTICLE_TAGS,
  difficultyLabel,
  normalizeDifficulty,
  normalizeTags,
} from './difficulty'

describe('朗读难度', () => {
  it('三档都认得出来，中文标签是 初 / 中 / 高', () => {
    for (const d of DIFFICULTY_ORDER) expect(normalizeDifficulty(d)).toBe(d)
    expect(DIFFICULTY_ORDER.map((d) => DIFFICULTY_LABEL[d])).toEqual(['初', '中', '高'])
  })

  // ⚠️ 刻意钉死：认不出时补一个默认值，会让**没评过级**的句子看起来评过级
  it('认不出的一律 null，不默认成 medium', () => {
    for (const v of [undefined, null, '', 'EASY', 'easy ', 1, {}, [], 'medium2', '初']) {
      expect(normalizeDifficulty(v)).toBeNull()
      expect(difficultyLabel(v)).toBeNull()
    }
  })
})

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
