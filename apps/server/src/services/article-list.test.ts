import { describe, expect, it } from 'vitest'

import { onlineAtOf, pickLatestArticles } from './article-list'

/** 造一条候选：publishedAt 传 null 表示老数据（走 createdAt 兜底） */
function row(articleId: string, publishedAt: string | null, createdAt = '2026-01-01T00:00:00Z') {
  return {
    articleId,
    publishedAt: publishedAt ? new Date(publishedAt) : null,
    createdAt: new Date(createdAt),
  }
}

/**
 * ⚠️ 这些用例守的是首页「最新上线」那一段的规则（见 article-list.ts）。
 *    写错的后果都是静默的：多一张卡、少一张卡、或者顺序不对 ——
 *    页面照常渲染，只有人盯着看才发现。
 */
describe('最新上线的挑选（数据源：句库，按上线时间倒序）', () => {
  it('⭐ 剔除今日那一句（它就在上面那张卡里，再列一次是同一个榜单看两遍）', () => {
    const rows = [row('5', '2026-03-05'), row('4', '2026-03-04'), row('3', '2026-03-03')]
    expect(pickLatestArticles(rows, '4', 20).map((r) => r.articleId)).toEqual(['5', '3'])
  })

  it('⭐ 按 publishedAt 倒序（新上线的在前），与输入的先后无关', () => {
    const rows = [row('2', '2026-02-01'), row('9', '2026-09-01'), row('5', '2026-05-01')]
    expect(pickLatestArticles(rows, '999', 20).map((r) => r.articleId)).toEqual(['9', '5', '2'])
  })

  it('⭐ publishedAt 为 null 时用 createdAt 兜底（老数据不能掉队）', () => {
    const rows = [
      row('a', null, '2026-12-01T00:00:00Z'), // 老数据，但入库很晚 ⇒ 应排最前
      row('b', '2026-06-01T00:00:00Z'),
    ]
    expect(pickLatestArticles(rows, null, 20).map((r) => r.articleId)).toEqual(['a', 'b'])
  })

  it('上线时间相同时用 id 倒序兜底（顺序必须确定）', () => {
    const rows = [row('2', '2026-01-01T00:00:00Z'), row('9', '2026-01-01T00:00:00Z')]
    expect(pickLatestArticles(rows, null, 20).map((r) => r.articleId)).toEqual(['9', '2'])
  })

  it('超过上限就截断', () => {
    const rows = [row('1', '2026-01-01'), row('2', '2026-01-02'), row('3', '2026-01-03'), row('4', '2026-01-04')]
    expect(pickLatestArticles(rows, '999', 2)).toHaveLength(2)
  })

  it('今日那句为 null 时不剔除任何东西', () => {
    expect(pickLatestArticles([row('1', '2026-01-01')], null, 20)).toHaveLength(1)
  })

  it('空句库不炸', () => {
    expect(pickLatestArticles([], '1', 20)).toEqual([])
  })

  it('onlineAtOf 把 null 一律算成 createdAt', () => {
    const at = new Date('2026-07-01T00:00:00Z')
    expect(onlineAtOf({ publishedAt: null, createdAt: at })).toBe(at.getTime())
  })
})
