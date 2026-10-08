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
describe('resultFormOf —— 六条口径（用户 2026-10 定）', () => {
  const PASS = 85

  it('① 首次 · 攻克 ⇒「攻克本句，+N 🍪」', () => {
    const r = resultFormOf({ score: 99.2, conquered: true, earned: 8, previousBest: null })
    expect(r.form).toBe('first-pass')
    expect(r.text).toBe('攻克本句，+8 🍪')
  })

  it('② 首次 · 没攻克 ⇒「还差N分攻克本句」', () => {
    // 85.1 - 34.8 = 50.3 ⇒ 51
    const r = resultFormOf({ score: 34.8, conquered: false, earned: 0, previousBest: null })
    expect(r.form).toBe('first-short')
    expect(r.text).toBe('还差51分攻克本句')
  })

  it('③ 非首次 · 超前高且过线 ⇒「超越前高，+N 🍪」', () => {
    const r = resultFormOf({ score: 94.7, conquered: true, earned: 9, previousBest: 90 })
    expect(r.form).toBe('beat-record')
    expect(r.text).toBe('超越前高，+9 🍪')
  })

  it('④ 非首次 · 超前高但没过线 ⇒ 两件事一起说', () => {
    // design 的 alert2 就是这个位置：前高 78，这次 80（超前高、仍 <85）
    // 85.1 - 80 = 5.1 ⇒ 6
    const r = resultFormOf({ score: 80, conquered: false, earned: 0, previousBest: 78 })
    expect(r.form).toBe('beat-record-short')
    expect(r.text).toBe('超越前高，还差6分攻克本句')
  })

  it('⑥ 非首次 · 过线但没超前高 ⇒「还差N分突破前高」', () => {
    // 前高 92，这次 91（过线 85 ✓，没超前高）—— 92.1 - 91 = 1.1 ⇒ 2
    const r = resultFormOf({ score: 91, conquered: false, earned: 0, previousBest: 92 })
    expect(r.form).toBe('short-of-record-pass')
    expect(r.text).toBe('还差2分突破前高')
  })

  it('⑦ 非首次 · 没超前高也没过线 ⇒ 加一句鼓励', () => {
    // 前高 70，这次 60：70.1 - 60 = 10.1 ⇒ 11
    const r = resultFormOf({ score: 60, conquered: false, earned: 0, previousBest: 70 })
    expect(r.form).toBe('short-of-record-short')
    expect(r.text).toBe('差11分突破前高，继续加油')
  })

  it('⚠️⚠️ 截图那个 bug：68.1 分、前高 82.6 ⇒【绝不能】说"超越前高"', () => {
    // 68.1 < 82.6 且 < 85 ⇒ 没攻克、也没超前高 ⇒ 第⑦条
    // ⚠️ 它当时显示成「超越前高，+0 🍪」是因为调用方把 isConquered 当成了"攻克"
    //    （那个字段其实是"打完分了"✗）；测试从这一层盯住"没攻克就绝不会走 b/c 之外的分支"
    const r = resultFormOf({ score: 68.1, conquered: false, earned: 0, previousBest: 82.6 })
    expect(r.form).toBe('short-of-record-short')
    expect(r.text).not.toContain('超越前高')
    // 82.6 + 0.1 - 68.1 = 14.6 ⇒ 15
    expect(r.text).toBe('差15分突破前高，继续加油')
  })

  it('⚠️ 攻克了才可能出现「+N 🍪」，且 N 一定 > 0（不存在「+0 🍪」）', () => {
    for (const c of [
      { score: 68.1, conquered: false, earned: 0, previousBest: 82.6 },
      { score: 40, conquered: false, earned: 0, previousBest: null },
      { score: 91, conquered: false, earned: 0, previousBest: 92 },
    ]) {
      const r = resultFormOf(c)
      expect(r.text).not.toContain('+0')
      expect(r.text).not.toContain('🍪')
    }
  })

  it('⚠️ 文案里不出现「0 🍪」（屏幕上永远不出现它）', () => {
    const cases = [
      { score: 99, conquered: true, earned: 8, previousBest: null },
      { score: 40, conquered: false, earned: 0, previousBest: null },
      { score: 95, conquered: true, earned: 5, previousBest: 94 },
      { score: 80, conquered: false, earned: 0, previousBest: 78 },
      { score: 91, conquered: false, earned: 0, previousBest: 92 },
      { score: 60, conquered: false, earned: 0, previousBest: 70 },
    ]
    for (const c of cases) expect(resultFormOf(c).text).not.toContain('0 🍪')
  })

  it('⚠️ 非首次绝不出现「攻克本句」四个字单独打头（那是首次的说法）', () => {
    // ③④ 说的是"超越前高"，⑥⑦ 说的是"突破前高" —— 都不会退回"攻克本句，+N"
    for (const c of [
      { score: 95, conquered: true, earned: 5, previousBest: 90 },
      { score: 80, conquered: false, earned: 0, previousBest: 78 },
      { score: 91, conquered: false, earned: 0, previousBest: 92 },
      { score: 60, conquered: false, earned: 0, previousBest: 70 },
    ]) {
      expect(resultFormOf(c).text.startsWith('攻克本句')).toBe(false)
    }
  })

  it('⚠️「差N分」永远是正数（边界上也不能变成 0 分）', () => {
    // 正好追平前高 ⇒ 还要再高 0.1 才算突破
    expect(resultFormOf({ score: 92, conquered: false, earned: 0, previousBest: 92 }).text).toBe('还差1分突破前高')
  })
})
