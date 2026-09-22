import { describe, expect, it } from 'vitest'

import { pickHistoryArticles } from './schedule-shape'

function row(articleId: number) {
  return { articleId }
}

/**
 * ⚠️ 这些用例守的是首页「历史挑战」那一段的规则（见 schedule-shape.ts）。
 *    写错的后果都是静默的：多一张卡、少一张卡、或者顺序不对 ——
 *    页面照常渲染，只有人盯着看才发现。
 */
describe('历史挑战的挑选（数据源：句库）', () => {
  it('⭐ 剔除今日那一句（池子小的时候隔几天就会轮回到它）', () => {
    expect(pickHistoryArticles([row(5), row(4), row(3)], 4, 20).map((r) => r.articleId)).toEqual([
      5, 3,
    ])
  })

  it('⭐ 按句子 id 倒序（新句在前），与输入的先后无关', () => {
    expect(
      pickHistoryArticles([row(2), row(9), row(5)], 999, 20).map((r) => r.articleId),
    ).toEqual([9, 5, 2])
  })

  it('超过上限就截断', () => {
    expect(pickHistoryArticles([row(1), row(2), row(3), row(4)], 999, 2)).toHaveLength(2)
  })

  it('今日那句为 null 时不剔除任何东西', () => {
    expect(pickHistoryArticles([row(1)], null, 20)).toHaveLength(1)
  })

  it('空句库不炸', () => {
    expect(pickHistoryArticles([], 1, 20)).toEqual([])
  })
})
