import { describe, expect, it } from 'vitest'
import {
  COOKIE_PASS_LINE,
  COOKIE_RANK_MIN_SAMPLE,
  cookieAwardOf,
  cookieBaseOf,
  cookieRankFactor,
  pointsToConquer,
  resultFormOf,
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
    expect(pointsToConquer(84, 85)).toBe(2) // 85.1-84=1.1 ⇒ 2
    expect(pointsToConquer(85, 85)).toBe(1)
  })

  it('已经过了线 ⇒ 0（调用方据此改显示 +N）', () => {
    expect(pointsToConquer(86, 85)).toBe(0)
  })

  it('⚠️ 分数带小数时**向上取整**（屏幕上不该出现「还差 51.2 分」）', () => {
    // 85 + 1 - 34.8 = 51.2 ⇒ 52。说 51 的话 34.8 + 51 = 85.8 仍在线下 ⇒ 那句邀请是假的
    // 85.1 - 34.8 = 50.3 ⇒ 51（34.8 + 51 = 85.8 > 85 ✓ 真的跨过去了）
    expect(pointsToConquer(34.8, 85)).toBe(51)
    expect(pointsToConquer(84.5, 85)).toBe(1)
    // ⚠️ 整数进来必须原样出去，不能被 ceil 改动
    expect(pointsToConquer(83, 85)).toBe(3)
    expect(Number.isInteger(pointsToConquer(71.3, 85))).toBe(true)
  })

  it('⭐ 攻克线是个人最好时同理（最好 90、这次 88 ⇒ 差 3）', () => {
    expect(pointsToConquer(88, 90)).toBe(3)
  })
})

/**
 * ⭐⭐ 结果弹窗的四种形态（2026-10 定的 alert1–alert4）。
 *
 * ⚠️ 这四条测试盯的是**文案与判据的对应关系**，不是"函数能跑"：
 *    最容易写错的是 c 与 d —— 它们都只在"已经攻克过"的前提下才成立，
 *    而写错了屏幕上看不出来（照样显示一句话），只有用户会觉得莫名其妙。
 */
describe('resultFormOf —— 四种结果形态（alert1–4）', () => {
  const passLine = 85

  it('a：第一次攻克 ⇒「攻克本句，+N 🍪」', () => {
    const r = resultFormOf({ score: 99.2, conquered: true, earned: 8, passLine, previousBest: null })
    expect(r.form).toBe('a')
    expect(r.text).toBe('攻克本句，+8 🍪')
  })

  it('d：之前攻克过、这次又攻下 ⇒「再次攻克，+N 🍪」', () => {
    const r = resultFormOf({ score: 94.7, conquered: true, earned: 9, passLine, previousBest: 90 })
    expect(r.form).toBe('d')
    expect(r.text).toBe('再次攻克，+9 🍪')
  })

  it('b：还没攻克过 ⇒「差X分，攻克本句」，基准是**攻克线**', () => {
    const r = resultFormOf({ score: 34.8, conquered: false, earned: 0, passLine, previousBest: null })
    expect(r.form).toBe('b')
    // 85.1 - 34.8 = 50.3 ⇒ 向上取整 **51**（34.8 + 51 = 85.8 > 85 ⇒ 确实攻得下 ✓）
    // ⚠️ 不是设计稿那张图上的 20 —— 图里 alert2 的数字是占位的
    expect(r.text).toBe('差51分，攻克本句')
  })

  it('c：**有记录但没攻克** ⇒ 目标换成刷新记录（设计稿 alert3 就是这个）', () => {
    // ⚠️⚠️ 这条是照着设计稿 alert3 标定的：78.3 分、记录 83.3（**低于 85 线**）⇒「差5分刷新记录」
    //    我第一版把判据写成"之前攻克过（best≥85）"，那样这条会掉进 b ⇒ 与设计稿不符 ✗
    // ⚠️ 记录取 83.2 而不是 83.3：跨过记录要 `best + 0.1`，83.2 + 0.1 - 78.3 = 5.0 ⇒ 差 5 分
    //    （设计稿那份 mock 写的是 83.3，配上"+0.1"会得 5.1 ⇒ 6 —— 说明它自己的数差了一格；
    //     这里按**语义**写：要刷新就得比记录高 0.1，而分是一位小数。）
    const r = resultFormOf({ score: 78.3, conquered: false, earned: 0, passLine: 85, previousBest: 83.2 })
    expect(r.form).toBe('c')
    expect(r.text).toBe('差5分刷新记录')
  })

  it('⚠️ 有记录的人没攻克时**绝不**该看到「攻克本句」（那说明规则说穿了）', () => {
    const r = resultFormOf({ score: 88, conquered: false, earned: 0, passLine: 95, previousBest: 95 })
    expect(r.text).not.toContain('攻克本句')
    expect(r.text).toContain('刷新记录')
  })

  it('⚠️ 第一次读这句（previousBest 为 null）走 b —— 目标只能是攻克', () => {
    const r = resultFormOf({ score: 40, conquered: false, earned: 0, passLine, previousBest: null })
    expect(r.form).toBe('b')
    // 85.1 - 40 = 45.1 ⇒ 46
    expect(r.text).toBe('差46分，攻克本句')
  })

  it('⚠️ 屏幕上永远不出现「0 🍪」—— 四个形态的文案都不含它', () => {
    const cases = [
      { score: 99, conquered: true, earned: 8, passLine, previousBest: null },
      { score: 99, conquered: true, earned: 8, passLine: 90, previousBest: 90 },
      { score: 40, conquered: false, earned: 0, passLine, previousBest: 30 },
      { score: 88, conquered: false, earned: 0, passLine: 92, previousBest: 92 },
    ]
    for (const c of cases) {
      expect(resultFormOf(c).text).not.toContain('0 🍪')
    }
  })

  it('⚠️「差X分」永远是正数（哪怕边界上算出来是 0）', () => {
    // 已经攻克过、这次正好等于最好成绩 ⇒ 要再高 1 分才算刷新
    expect(resultFormOf({ score: 92, conquered: false, earned: 0, passLine: 92, previousBest: 92 }).text).toBe('差1分刷新记录')
  })
})
