import { describe, expect, it } from 'vitest'

import { pickHistoryArenas } from './schedule-shape'

function row(date: string, articleId: number) {
  return { date, articleId, source: 'rotation' }
}

/**
 * ⚠️ 这些用例守的是首页「历史挑战」那一段的**三条规则**（见 schedule-shape.ts）。
 *    它们写错的后果都是静默的：多一张卡、少一张卡、或者顺序不对 ——
 *    页面照常渲染，只有人盯着看才发现。
 */
describe('历史竞技场的挑选', () => {
  it('⭐ 剔除与今日重复的那一句', () => {
    const rows = [row('2026-09-21', 2), row('2026-09-20', 1), row('2026-09-17', 1)]
    const out = pickHistoryArenas(rows, 1, 20)
    expect(out.map((r) => r.articleId)).toEqual([2])
  })

  it('⭐ 同一句只留最近的那一次（池子比历史短时必然出现）', () => {
    const rows = [row('2026-09-21', 7), row('2026-09-19', 9), row('2026-09-16', 7)]
    expect(pickHistoryArenas(rows, 1, 20)).toEqual([
      { date: '2026-09-21', articleId: 7, source: 'rotation' },
      { date: '2026-09-19', articleId: 9, source: 'rotation' },
    ])
  })

  it('⭐ 按日期倒序，与输入的先后无关', () => {
    const rows = [row('2026-09-15', 3), row('2026-09-21', 2), row('2026-09-18', 5)]
    expect(pickHistoryArenas(rows, 1, 20).map((r) => r.date)).toEqual([
      '2026-09-21',
      '2026-09-18',
      '2026-09-15',
    ])
  })

  it('超过上限就截断（按「竞技场」数，不是天数）', () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row('2026-09-' + (20 - i), i + 10))
    expect(pickHistoryArenas(rows, 99, 3)).toHaveLength(3)
  })

  it('今日那一句 id 为 null 时不剔除任何东西', () => {
    expect(pickHistoryArenas([row('2026-09-21', 5)], null, 20).map((r) => r.articleId)).toEqual([5])
  })

  it('空输入不炸', () => {
    expect(pickHistoryArenas([], 1, 20)).toEqual([])
  })
})
