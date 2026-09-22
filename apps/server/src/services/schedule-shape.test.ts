import { describe, expect, it } from 'vitest'

import { shapeScheduleCards } from './schedule-shape'

function card(date: string, articleId: number) {
  return { date, articleId }
}

/**
 * ⚠️ 这些用例守的是「首页那两张卡到底怎么切」——它有三条规则（见 schedule-shape.ts），
 *    而每条都能独立写错，写错了在界面上只表现为「多了一张卡」或「顺序怪」：
 *    不报错、不崩，只能靠人盯着看。
 */
describe('首页卡片的切分', () => {
  it('今日那张不进历史', () => {
    const r = shapeScheduleCards([card('2026-09-22', 1), card('2026-09-21', 2)], '2026-09-22')
    expect(r.today?.date).toBe('2026-09-22')
    expect(r.history.map((c) => c.date)).toEqual(['2026-09-21'])
  })

  it('⭐ 池子比窗口小时：和今日同一句的那张也不进历史（否则同一个榜单会看三遍）', () => {
    // 池子 5 句：-5 号轮回到今天那一句、-6 号轮到昨天那一句
    const cards = [
      card('2026-09-22', 5),
      card('2026-09-21', 4),
      card('2026-09-20', 3),
      card('2026-09-19', 2),
      card('2026-09-18', 1),
      card('2026-09-17', 5), // ← 与今日同一句
      card('2026-09-16', 4), // ← 与昨日同一句
    ]
    const r = shapeScheduleCards(cards, '2026-09-22')
    expect(r.history.map((c) => c.articleId)).toEqual([4, 3, 2, 1])
    expect(r.history.map((c) => c.date)).toEqual(['2026-09-21', '2026-09-20', '2026-09-19', '2026-09-18'])
  })

  it('⭐ 按日期倒序（新的在前），与调用方给的顺序无关', () => {
    const r = shapeScheduleCards(
      [card('2026-09-18', 1), card('2026-09-22', 5), card('2026-09-21', 4)],
      '2026-09-22',
    )
    expect(r.history.map((c) => c.date)).toEqual(['2026-09-21', '2026-09-18'])
  })

  it('今日不在列表里时 today 为 null，历史照旧', () => {
    const r = shapeScheduleCards([card('2026-09-21', 4)], '2026-09-22')
    expect(r.today).toBeNull()
    expect(r.history.map((c) => c.date)).toEqual(['2026-09-21'])
  })

  it('折叠时保留同一句**最近**的那一天', () => {
    // 同一句 7 号在 19 号和 16 号都排过 —— 该站在 19 号那个位置
    const r = shapeScheduleCards(
      [card('2026-09-22', 1), card('2026-09-19', 7), card('2026-09-16', 7)],
      '2026-09-22',
    )
    expect(r.history.map((c) => c.date)).toEqual(['2026-09-19'])
  })

  it('空列表不炸', () => {
    expect(shapeScheduleCards([], '2026-09-22')).toEqual({ today: null, history: [] })
  })
})
