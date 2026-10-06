import { describe, expect, it } from 'vitest'

import { COOKIE_RANK_MIN_SAMPLE, pointsToConquer } from '@jushuo/shared'

import { cookiePercentileOf, computeCookies } from './cookies'

/**
 * ⭐ 服务端这两块的边界 —— 纯算法在 `@jushuo/shared/cookies.ts`（那边已有 21 条），
 *    这里只测**服务端独有的那一步**：把榜单快照折算成名次分位，再接上算法。
 *
 * ⚠️⚠️ 为什么值得单独测：分位是**唯一的、由"别人"决定的输入** ——
 *    它算错不会崩，只会让每个人拿到的饼干数悄悄不对（最难发现的那类）。
 */

describe('cookiePercentileOf —— 名次分位', () => {
  it('⭐ 场上只有我一个 ⇒ 0（前 10% ⇒ 满额）—— 早鸟优势就是靠这条成立的', () => {
    expect(cookiePercentileOf(90, [])).toEqual({ percentile: 0, sampleSize: 1 })
  })

  it('⭐ 我是最高的 ⇒ 0；分母含本人 ⇒ 不会出现 0/0', () => {
    expect(cookiePercentileOf(95, [80, 70, 60])).toEqual({ percentile: 0, sampleSize: 4 })
  })

  it('⚠️ 平手算"我不占优"（用 >= 而不是 >）—— 与榜单"先来的在前"一致', () => {
    // 我 90，别人也是 90 ⇒ 那个人算在我前面
    expect(cookiePercentileOf(90, [90]).percentile).toBeCloseTo(1 / 2)
  })

  it('⚠️ 最后一名也**取不到 1**（n/(n+1)）⇒ 不会掉进"第 11 档"', () => {
    const { percentile, sampleSize } = cookiePercentileOf(10, [90, 80, 70])
    expect(sampleSize).toBe(4)
    expect(percentile).toBeCloseTo(3 / 4)
    expect(percentile).toBeLessThan(1)
  })

  it('脏数据被滤掉，不进分母', () => {
    // NaN 与 Infinity 都被滤掉 ⇒ 只剩 [50]；我 90 比它高 ⇒ 没有人在我前面
    expect(cookiePercentileOf(90, [Number.NaN, Number.POSITIVE_INFINITY, 50])).toEqual({
      percentile: 0,
      sampleSize: 2,
    })
  })
})

describe('computeCookies —— 快照 + 记账依据', () => {
  const base = { score: 90, difficulty: 1 as const, highestInSentence: null }

  it('⭐ 首读一个中级句、满分位 ⇒ 20 块，依据里带上 passLine / base / rankFactor', () => {
    const c = computeCookies({ ...base, snapshot: [] })
    expect(c.earned).toBe(20)
    expect(c.passLine).toBe(85)
    expect(c.meta).toMatchObject({ passLine: 85, base: 20, rankFactor: 1, sampleSize: 1, percentile: 0 })
  })

  it('⚠️ 样本刚好到 10 人才开始按分位 —— ⚠️ 分母**含本人**，所以是「8 个别人」而不是「9 个」', () => {
    // 8 个别人 + 我 = 9 人 ⇒ 不足 10 ⇒ 满额
    const sn8 = Array.from({ length: 8 }, () => 99) // 都比我高（分位很差），但仍拿满额
    const c8 = computeCookies({ ...base, snapshot: sn8 })
    expect(c8.meta.sampleSize).toBe(9)
    expect(c8.rankFactor).toBe(1)

    // 9 个别人 + 我 = 10 人 ⇒ **正好到线** ⇒ 开始按分位（这批人都比我高 ⇒ 掉到最低档）
    const sn9 = Array.from({ length: 9 }, () => 99)
    const c9 = computeCookies({ ...base, snapshot: sn9 })
    expect(c9.meta.sampleSize).toBe(10)
    expect(c9.rankFactor).toBeLessThan(1)
  })

  it('⭐ 85.0 是"没过"—— 严格大于才算攻克', () => {
    expect(computeCookies({ ...base, score: 85, snapshot: [] }).earned).toBe(0)
    expect(computeCookies({ ...base, score: 85.1, snapshot: [] }).earned).toBe(20)
  })

  it('⭐ 攻克线被个人最好抬高；最好分低于 85 时线仍是 85', () => {
    expect(computeCookies({ ...base, score: 90, highestInSentence: 90, snapshot: [] }).earned).toBe(0)
    expect(computeCookies({ ...base, score: 91, highestInSentence: 90, snapshot: [] }).earned).toBe(20)
    expect(computeCookies({ ...base, score: 86, highestInSentence: 60, snapshot: [] }).passLine).toBe(85)
  })

  it('⚠️ 没攻克时 passLine 照样回给端侧 —— 「还差 X 分」全靠它', () => {
    const c = computeCookies({ ...base, score: 80, snapshot: [] })
    expect(c.earned).toBe(0)
    expect(pointsToConquer(80, c.passLine)).toBe(6)
  })

  it('难度未知（老内容）按初级兜底，不报错也不给 0', () => {
    expect(computeCookies({ ...base, difficulty: null, snapshot: [] }).base).toBe(10)
  })

  it('依据里的 percentile / sampleSize 与分位函数同源（不是各算一遍）', () => {
    const snapshot = [95, 92, 88]
    const c = computeCookies({ ...base, snapshot })
    const p = cookiePercentileOf(base.score, snapshot)
    expect(c.meta.percentile).toBe(p.percentile)
    expect(c.meta.sampleSize).toBe(p.sampleSize)
  })
})

describe('幂等 —— 同一份提交重复结算不能重复发', () => {
  it('⚠️ 它是**纯函数**：同样的输入永远同样的输出（重放不会"越算越多"）', () => {
    const input = { score: 93, difficulty: 2 as const, highestInSentence: 88, snapshot: [99, 60] }
    const a = computeCookies(input)
    const b = computeCookies(input)
    expect(a).toEqual(b)
  })

  it('⚠️⚠️ 但"重复加余额"**不是这个函数能防的** —— 它靠 settle 里那条 `cookies_earned IS NULL` 守卫',
    () => {
      /**
       * ⚠️ 这条用例是**文档**，不是断言：把这条约束写在这里，
       *    是因为改 settle 的人很少会想到"纯函数幂等 ≠ 入账幂等"。
       *    真正守着它的那条守卫在 `services/settle.ts`，断言在
       *    `services/settle.test.ts`（结算重放）里。
       */
      expect(COOKIE_RANK_MIN_SAMPLE).toBe(10)
    })
})
