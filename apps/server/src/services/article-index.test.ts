import { describe, expect, it } from 'vitest'
import { MAX_ARTICLE_TAGS } from '@jushuo/shared'
import { indexOfContent } from './article-index'

const ID = 'a'.repeat(16)

/**
 * ⚠️ 两个档位 / 标签落库是**派生索引**：真相在正文 JSON 里。
 *    这里钉住的是「正文 → 索引」这一步的取值口径，
 *    它错的表现是「按档位筛出来一条，点进去根本不是那一档」。
 * ⚠️ **两条轴各测各的** —— 尤其要钉死「不许拿一条兜另一条」。
 */
describe('indexOfContent', () => {
  it('两条轴的档位各自原样进索引', () => {
    for (const d of [0, 1, 2, 3] as const) {
      const idx = indexOfContent(ID, { id: ID, pronLevel: d, vocabLevel: d })
      expect(idx.pronLevel).toBe(d)
      expect(idx.vocabLevel).toBe(d)
    }
  })

  it('⭐ 两条轴互不兜底：只写一条时，另一条必须是 null（不是复制过去）', () => {
    expect(indexOfContent(ID, { id: ID, pronLevel: 3 })).toMatchObject({ pronLevel: 3, vocabLevel: null })
    expect(indexOfContent(ID, { id: ID, vocabLevel: 2 })).toMatchObject({ pronLevel: null, vocabLevel: 2 })
    // ⚠️ 最典型的一段：绕口令词汇简单、发音极难 —— 两轴必须给出**不同**的值
    const tongueTwister = indexOfContent(ID, { id: ID, pronLevel: 3, vocabLevel: 0 })
    expect(tongueTwister.pronLevel).not.toBe(tongueTwister.vocabLevel)
  })

  it('没写 / 认不出 ⇒ null（绝不补默认档位）', () => {
    expect(indexOfContent(ID, { id: ID }).pronLevel).toBeNull()
    expect(indexOfContent(ID, { id: ID }).vocabLevel).toBeNull()
    expect(indexOfContent(ID, { id: ID, pronLevel: 'expert' }).pronLevel).toBeNull()
    expect(indexOfContent(ID, { id: ID, vocabLevel: 4 }).vocabLevel).toBeNull()
  })

  it('旧正文的 easy/medium/hard 也要能进索引（正文可能比代码旧）', () => {
    expect(indexOfContent(ID, { id: ID, pronLevel: 'easy' }).pronLevel).toBe(0)
    expect(indexOfContent(ID, { id: ID, vocabLevel: 'hard' }).vocabLevel).toBe(2)
  })

  it('标签过规范化：去空、去重、保序、限个数', () => {
    expect(indexOfContent(ID, { id: ID, tags: [' 名言 ', '名言', '', '绕口令'] }).tags).toEqual(['名言', '绕口令'])
    const many = Array.from({ length: MAX_ARTICLE_TAGS + 3 }, (_, i) => 'T' + i)
    expect(indexOfContent(ID, { id: ID, tags: many }).tags).toHaveLength(MAX_ARTICLE_TAGS)
  })

  it('正文读不到 ⇒ 两个档位都是 null、标签空，且**不算** id 不一致', () => {
    expect(indexOfContent(ID, null)).toEqual({ pronLevel: null, vocabLevel: null, tags: [], idMismatch: false })
  })

  it('正文 id 与 articles.id 不一致会被标出来（改过正文却没换 id）', () => {
    expect(indexOfContent(ID, { id: 'b'.repeat(16), pronLevel: 1 }).idMismatch).toBe(true)
    expect(indexOfContent(ID, { id: ID, pronLevel: 1 }).idMismatch).toBe(false)
    // 老正文可能没写 id —— 那不算不一致，交给内容校验用例去要求它写
    expect(indexOfContent(ID, { pronLevel: 1 }).idMismatch).toBe(false)
  })
})
