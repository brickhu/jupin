import { describe, expect, it } from 'vitest'
import {
  COOKIE_PASS_LINE,
  COOKIE_RANK_MIN_SAMPLE,
  cookieAwardOf,
  cookieBaseOf,
  cookieRankFactor,
  pointsToConquer,
} from './cookies'

describe('cookieBaseOf —— 难度基准', () => {
  it('初级 10 / 中级 20 / 高级 30 / 专家 40', () => {
    expect([0, 1, 2, 3].map((l) => cookieBaseOf(l as 0 | 1 | 2 | 3))).toEqual([10, 20, 30, 40])
  })

  it('⚠️ 难度未知（老内容 / null）按初级兜底 —— 不报错，也不给 0', () => {
    expect(cookieBaseOf(null)).toBe(10)
    expect(cookieBaseOf(undefined)).toBe(10)
  })
})

describe('cookieRankFactor —— 名次分位 → 系数', () => {
  it('样本不足 10 人 ⇒ 一律满额（早鸟优势，刻意如此）', () => {
    for (const n of [0, 1, 5, 9]) expect(cookieRankFactor(0.95, n)).toBe(1)
  })

  it('样本够了才按分位走：前 10% ⇒ 100%、最后 10% ⇒ 10%', () => {
    expect(cookieRankFactor(0, 10)).toBe(1)
    expect(cookieRankFactor(0.05, 10)).toBe(1)
    expect(cookieRankFactor(0.95, 10)).toBe(0.1)
  })

  it('逐档递减：0.15 ⇒ 90%、0.55 ⇒ 50%', () => {
    expect(cookieRankFactor(0.15, 100)).toBe(0.9)
    expect(cookieRankFactor(0.55, 100)).toBe(0.5)
  })

  it('⚠️ 浮点不冒出来（0.7 不是 0.7000000000000001）', () => {
    expect(cookieRankFactor(0.35, 100)).toBe(0.7)
  })

  it('⚠️ 样本够但分位拿不到 ⇒ **也给满额**（宁可多发，不凭空扣）', () => {
    expect(cookieRankFactor(null, 100)).toBe(1)
    expect(cookieRankFactor(Number.NaN, 100)).toBe(1)
  })

  it('越界的分位被夹住，不抛', () => {
    expect(cookieRankFactor(-1, 100)).toBe(1)
    expect(cookieRankFactor(2, 100)).toBe(0.1)
  })

  it('刚好第 10 人开始按分位（边界：9 与 10）', () => {
    expect(cookieRankFactor(0.95, COOKIE_RANK_MIN_SAMPLE - 1)).toBe(1)
    expect(cookieRankFactor(0.95, COOKIE_RANK_MIN_SAMPLE)).toBe(0.1)
  })
})

describe('cookieAwardOf —— 攻克才给饼干', () => {
  const base = { difficulty: 1 as const, percentile: 0, sampleSize: 100 }

  it('⭐ 首次攻克（没有历史最好）⇒ 只要 > 85 就给', () => {
    expect(cookieAwardOf({ ...base, score: 86, bestInSentence: null }).earned).toBe(20)
  })

  it('⭐⭐ **严格大于**：正好 85 不算攻克', () => {
    expect(cookieAwardOf({ ...base, score: 85, bestInSentence: null }).earned).toBe(0)
  })

  it('⭐ 攻克线随个人最好抬高：最好 90 ⇒ 91 才给', () => {
    expect(cookieAwardOf({ ...base, score: 90, bestInSentence: 90 }).earned).toBe(0)
    expect(cookieAwardOf({ ...base, score: 91, bestInSentence: 90 }).earned).toBe(20)
  })

  it('⭐ 最好分低于 85 时，线仍然是 85（不会被拉低）', () => {
    expect(cookieAwardOf({ ...base, score: 86, bestInSentence: 60 }).passLine).toBe(COOKIE_PASS_LINE)
    expect(cookieAwardOf({ ...base, score: 80, bestInSentence: 60 }).earned).toBe(0)
  })

  it('难度基准参与计算：专家句 × 100% = 40', () => {
    expect(cookieAwardOf({ ...base, difficulty: 3, score: 90, bestInSentence: null }).earned).toBe(40)
  })

  it('名次系数参与计算：专家 × 10% = 4', () => {
    expect(
      cookieAwardOf({ ...base, difficulty: 3, score: 90, bestInSentence: null, percentile: 0.95 })
        .earned,
    ).toBe(4)
  })

  it('⚠️ 名次差到 10% 时不为 0 —— 圆整后是 1（初级 10 × 0.1）', () => {
    expect(
      cookieAwardOf({ ...base, difficulty: 0, score: 90, bestInSentence: null, percentile: 0.95 })
        .earned,
    ).toBe(1)
  })

  it('passLine / base / rankFactor 都回给端侧（明细要能解释"为什么是这个数"）', () => {
    const a = cookieAwardOf({ ...base, score: 92, bestInSentence: 88, difficulty: 2 })
    expect(a).toEqual({ earned: 30, passLine: 88, base: 30, rankFactor: 1 })
  })

  it('⚠️ 脏数据不抛：best 是 NaN / 负数都当"没有历史"', () => {
    expect(cookieAwardOf({ ...base, score: 86, bestInSentence: Number.NaN }).passLine).toBe(85)
    expect(cookieAwardOf({ ...base, score: 86, bestInSentence: -5 }).passLine).toBe(85)
  })
})

describe('pointsToConquer —— 「还差多少分」（屏幕上永不出现 0 🍪）', () => {
  it('差 1 分', () => {
    expect(pointsToConquer(84, 85)).toBe(2)
    expect(pointsToConquer(85, 85)).toBe(1)
  })

  it('已经过了线 ⇒ 0（调用方据此改显示 +N）', () => {
    expect(pointsToConquer(86, 85)).toBe(0)
  })

  it('⭐ 攻克线是个人最好时同理（最好 90、这次 88 ⇒ 差 3）', () => {
    expect(pointsToConquer(88, 90)).toBe(3)
  })
})
