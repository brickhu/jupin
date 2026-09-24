import { describe, expect, it } from 'vitest'
import {
  DIFFICULTY_LABEL,
  DIFFICULTY_ORDER,
  MAX_ARTICLE_TAGS,
  normalizeDifficulty,
  normalizeTags,
} from './difficulty'

describe('朗读难度（四档：0 初级 / 1 中级 / 2 高级 / 3 专家）', () => {
  it('四档都认得出来，中文标签与顺序对得上', () => {
    for (const d of DIFFICULTY_ORDER) expect(normalizeDifficulty(d)).toBe(d)
    expect(DIFFICULTY_ORDER).toEqual([0, 1, 2, 3])
    expect(DIFFICULTY_ORDER.map((d) => DIFFICULTY_LABEL[d])).toEqual(['初级', '中级', '高级', '专家'])
  })

  it('数字字符串也认 —— JSON 被人手改过之后很容易变成字符串形式的档位', () => {
    expect(normalizeDifficulty('0')).toBe(0)
    expect(normalizeDifficulty('3')).toBe(3)
  })

  it('旧正文里的 easy/medium/hard 走显式映射（老内容还在 CDN 上）', () => {
    expect(normalizeDifficulty('easy')).toBe(0)
    expect(normalizeDifficulty('medium')).toBe(1)
    // ⚠️ hard → 2（高级）而不是 3（专家）：专家是新开的档，不替老内容升格
    expect(normalizeDifficulty('hard')).toBe(2)
  })

  // ⚠️ 刻意钉死：认不出时补一个默认值，会让**没评过级**的句子看起来评过级
  it('认不出的一律 null，绝不补默认档位', () => {
    for (const v of [undefined, null, '', 'EASY', 'easy ', 'Hard', 4, -1, 1.5, '10', '-1', {}, [], 'medium2', '初', true]) {
      expect(normalizeDifficulty(v)).toBeNull()
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
