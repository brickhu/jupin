import { describe, expect, it } from 'vitest'

import { demoteOf, troubleScoreOf } from './recommend'

/**
 * ⭐⭐ 守的是 2026-10-15 给"今日推荐"加的两条智能（用户挑的 ①②）：
 *   ① 档内选句优先挑「含这一档普遍读不好的词」的句子；
 *   ② 档位判定加**降档**（断档 / 手感），因为原来它**只会升不会降**。
 *   ③「同句防重」核过是**已经有的**（未读优先 + 全读过时挑"放得最久"那句），没重复实现。
 */
describe('① 薄弱词打分（纯函数）', () => {
  const trouble = new Map([
    ['thorough', 5],
    ['invent', 3],
  ])

  it('⭐ 按**词**比对，不按子串（`as` 不能命中 `simple`）', () => {
    const t = new Map([['as', 9]])
    expect(troubleScoreOf(['simple', 'possible'], t)).toBe(0)
    expect(troubleScoreOf(['as', 'simple'], t)).toBe(9)
  })

  it('⭐ 去标点小写后比对（`Thorough.` 与 `thorough` 是同一个词）', () => {
    expect(troubleScoreOf(['Thorough.'], trouble)).toBe(5)
  })

  it('⭐ 一句话踩中多个 ⇒ 分数累加（越该练的排越前）', () => {
    expect(troubleScoreOf(['thorough', 'invent'], trouble)).toBe(8)
  })

  it('⚠️ 没有薄弱词数据时恒 0（不许乱排）', () => {
    expect(troubleScoreOf(['thorough'], new Map())).toBe(0)
  })
})

describe('② 降档（纯函数）', () => {
  const now = new Date('2026-10-15T12:00:00Z')
  const daysAgo = (n: number) => new Date(now.getTime() - n * 86400_000)
  /** 一条该档的参与记录 */
  const rec = (best: number, ago: number) => ({ best, lastAt: daysAgo(ago) })

  it('⭐⭐ 断档太久 ⇒ 降一档（回来先找回手感）', () => {
    const d = demoteOf({ level: 2, inTier: [rec(90, 30)], lastAt: daysAgo(30), now })
    expect(d?.level).toBe(1)
    expect(d?.basis).toContain('30 天')
  })

  it('⭐⭐ 这一档最近 3 次都读崩 ⇒ 降一档', () => {
    const d = demoteOf({
      level: 2,
      inTier: [rec(40, 1), rec(50, 2), rec(30, 3), rec(95, 4)],
      lastAt: daysAgo(1),
      now,
    })
    expect(d?.level, '最近三次 (40/50/30) 都低于 60 ⇒ 该降').toBe(1)
  })

  it('⚠️ 最近三次里有一次达标 ⇒ 不降（只看最近、不是看平均）', () => {
    expect(
      demoteOf({
        level: 2,
        inTier: [rec(40, 1), rec(88, 2), rec(30, 3)],
        lastAt: daysAgo(1),
        now,
      }),
    ).toBeNull()
  })

  it('⚠️ 到初级就不降了（不会降成负数）', () => {
    expect(demoteOf({ level: 0, inTier: [rec(10, 1), rec(10, 2), rec(10, 3)], lastAt: daysAgo(99), now })).toBeNull()
  })

  it('⚠️ 时钟回拨的脏数据不算"断档"（那是没数据，不是很久没读）', () => {
    expect(demoteOf({ level: 2, inTier: [], lastAt: daysAgo(-5), now })).toBeNull()
  })

  it('⚠️ 没有任何参与记录也不算断档（新用户走默认初级，不在这里判）', () => {
    expect(demoteOf({ level: 2, inTier: [], lastAt: null, now })).toBeNull()
  })
})
