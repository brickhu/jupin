import { describe, expect, it } from 'vitest'
import { MAX_ARTICLE_TAGS } from '@jushuo/shared'
import { indexOfContent } from './article-index'

const ID = 'a'.repeat(64)

/**
 * ⚠️ 难度 / 标签落库是**派生索引**：真相在正文 JSON 里。
 *    这里钉住的是「正文 → 索引」这一步的取值口径，
 *    它错的表现是「按难度筛出来一条，点进去根本不是那一档」。
 */
describe('indexOfContent', () => {
  it('正文里的四档难度原样进索引', () => {
    for (const d of [0, 1, 2, 3] as const) {
      expect(indexOfContent(ID, { id: ID, difficulty: d }).difficulty).toBe(d)
    }
  })

  it('没写难度 / 认不出 ⇒ null（绝不补默认档位）', () => {
    expect(indexOfContent(ID, { id: ID }).difficulty).toBeNull()
    expect(indexOfContent(ID, { id: ID, difficulty: 'expert' }).difficulty).toBeNull()
    expect(indexOfContent(ID, { id: ID, difficulty: 4 }).difficulty).toBeNull()
  })

  it('旧正文的 easy/medium/hard 也要能进索引（正文可能比代码旧）', () => {
    expect(indexOfContent(ID, { id: ID, difficulty: 'easy' }).difficulty).toBe(0)
    expect(indexOfContent(ID, { id: ID, difficulty: 'hard' }).difficulty).toBe(2)
  })

  it('标签过规范化：去空、去重、保序、限个数', () => {
    expect(indexOfContent(ID, { id: ID, tags: [' 名言 ', '名言', '', '绕口令'] }).tags).toEqual(['名言', '绕口令'])
    const many = Array.from({ length: MAX_ARTICLE_TAGS + 3 }, (_, i) => 'T' + i)
    expect(indexOfContent(ID, { id: ID, tags: many }).tags).toHaveLength(MAX_ARTICLE_TAGS)
  })

  it('正文读不到 ⇒ 难度 null / 标签空，且**不算** id 不一致', () => {
    expect(indexOfContent(ID, null)).toEqual({ difficulty: null, tags: [], idMismatch: false })
  })

  it('正文 id 与 articles.id 不一致会被标出来（改过正文却没换 id）', () => {
    expect(indexOfContent(ID, { id: 'b'.repeat(64), difficulty: 1 }).idMismatch).toBe(true)
    expect(indexOfContent(ID, { id: ID, difficulty: 1 }).idMismatch).toBe(false)
    // 老正文可能没写 id —— 那不算不一致，交给内容校验用例去要求它写
    expect(indexOfContent(ID, { difficulty: 1 }).idMismatch).toBe(false)
  })
})
