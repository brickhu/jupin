import { describe, expect, it } from 'vitest'
import { diligenceOf, growthStep, medianOf, selfSurpassOf, standoutOf, standoutWeight } from './growth'

/**
 * ⭐ 成长体系的纯函数单测 —— 规格见 docs/design/growth-and-energy.md。
 *
 * ⚠️⚠️ 这一份守的不是"函数对不对"，是**口径有没有被改回去**：
 *    这三个数会落进 submissions 的快照永久冻结，而且依赖「提交那一刻的历史」，
 *    事后无法重算。所以每个"曾经改过两次"的地方都留了一条显式的用例。
 */

describe('growthStep —— 规格里的 f(x) = clamp(round(x), 0, 10)', () => {
  it('四舍五入到整数', () => {
    expect(growthStep(0.4)).toBe(0)
    expect(growthStep(0.5)).toBe(1) // Math.round(0.5) 向上
    expect(growthStep(4.5)).toBe(5)
    expect(growthStep(9.4)).toBe(9)
  })

  it('夹在 [0, 10]', () => {
    expect(growthStep(-3)).toBe(0)
    expect(growthStep(0)).toBe(0)
    expect(growthStep(10)).toBe(10)
    expect(growthStep(99)).toBe(10)
  })

  it('⚠️ 非有限值给 0 —— 不能让 NaN 漏进快照（JSON 里会变成 null）', () => {
    expect(growthStep(Number.NaN)).toBe(0)
    expect(growthStep(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('selfSurpassOf —— 两个维度取平均', () => {
  it('⭐ 没有历史（0 / null）⇒ 该维度不成立、给 0；两个都没有 ⇒ 自我超越 = 0', () => {
    expect(selfSurpassOf({ score: 80, highestInSentence: 0, highestInUser: 0 })).toEqual({
      n1: 0,
      n2: 0,
      total: 0,
    })
    expect(selfSurpassOf({ score: 80, highestInSentence: null, highestInUser: null }).total).toBe(0)
    expect(selfSurpassOf({ score: 80, highestInSentence: undefined as never, highestInUser: 0 }).n1).toBe(0)
  })

  it('⭐ 句内 73、全局 95、这次 82 ⇒ n1 = 9、n2 = 0、合计 round(4.5) = 5', () => {
    const r = selfSurpassOf({ score: 82, highestInSentence: 73, highestInUser: 95 })
    expect(r.n1).toBe(9)
    expect(r.n2).toBe(0)
    expect(r.total).toBe(5)
  })

  it('⭐ 两边都破（句内 80、全局 85、这次 92）⇒ n1 = 10、n2 = 7、合计 round(8.5) = 9', () => {
    const r = selfSurpassOf({ score: 92, highestInSentence: 80, highestInUser: 85 })
    expect(r).toMatchObject({ n1: 10, n2: 7, total: 9 })
  })

  it('⚠️ 只破句内时最高只能拿一半 —— 这正是"取平均"的意义', () => {
    const r = selfSurpassOf({ score: 90, highestInSentence: 80, highestInUser: 95 })
    expect(r).toMatchObject({ n1: 10, n2: 0, total: 5 })
  })

  it('⭐ n1 >= n2 恒成立（我在这句的最高分 永远 <= 我的全局最高分）', () => {
    const cases = [
      { score: 82, highestInSentence: 73, highestInUser: 95 },
      { score: 92, highestInSentence: 80, highestInUser: 85 },
      { score: 100, highestInSentence: 60, highestInUser: 61 },
      { score: 76, highestInSentence: 75, highestInUser: 75 },
    ]
    for (const c of cases) {
      const r = selfSurpassOf(c)
      expect(r.n1).toBeGreaterThanOrEqual(r.n2)
    }
  })

  it('得分低于基准 ⇒ 0，不会出现负数', () => {
    expect(selfSurpassOf({ score: 50, highestInSentence: 80, highestInUser: 90 }).total).toBe(0)
  })

  it('⚠️ 没有 75 下限：句内最高 56、这次 60 ⇒ n1 = f(4) = 4（60 分不到 75 也算超越）', () => {
    expect(selfSurpassOf({ score: 60, highestInSentence: 56, highestInUser: 0 }).n1).toBe(4)
  })
})

describe('diligenceOf —— 跨档才给，且每个周期只给一次', () => {
  it('⭐ 跨过 7 ⇒ +1 —— 注意是**第 8 天**触发（判据是 after > 7）', () => {
    expect(diligenceOf(7, 8)).toEqual({ points: 1, crossed: [7] })
    // 第 7 天那次还不算（after === 7 不满足 > 7）
    expect(diligenceOf(6, 7)).toEqual({ points: 0, crossed: [] })
  })

  it('⚠️ 已经在 7 之上再读 ⇒ 不再给（不能写成"现在 > 7 就给"）', () => {
    expect(diligenceOf(8, 9)).toEqual({ points: 0, crossed: [] })
    expect(diligenceOf(100, 101).points).toBe(0)
  })

  it('跨过 30 ⇒ +5', () => {
    expect(diligenceOf(30, 31)).toEqual({ points: 5, crossed: [30] })
  })

  it('跨过 180 ⇒ +40', () => {
    expect(diligenceOf(180, 181)).toEqual({ points: 40, crossed: [180] })
  })

  it('跨过 360 ⇒ +100', () => {
    expect(diligenceOf(360, 361)).toEqual({ points: 100, crossed: [360] })
  })

  it('⭐ 第 2 / 3 个 360 天翻倍（200 / 400）', () => {
    expect(diligenceOf(720, 721)).toEqual({ points: 200, crossed: [720] })
    expect(diligenceOf(1080, 1081)).toEqual({ points: 400, crossed: [1080] })
  })

  it('⭐ 一年累计 146（+1 / +5 / +40 / +100）', () => {
    let total = 0
    for (let d = 1; d <= 361; d++) total += diligenceOf(d - 1, d).points
    expect(total).toBe(146)
  })

  it('⭐ 中断后重新攒，档位从头 —— 三次 streak>7 = 1+1+1', () => {
    let total = 0
    for (const [before, after] of [
      [7, 8],
      [1, 2],
      [7, 8],
      [1, 2],
      [7, 8],
    ] as const) {
      total += diligenceOf(before, after).points
    }
    expect(total).toBe(3)
  })

  it('⚠️ 断档（streakDays 归 1）不触发任何档', () => {
    expect(diligenceOf(30, 1)).toEqual({ points: 0, crossed: [] })
    expect(diligenceOf(400, 1)).toEqual({ points: 0, crossed: [] })
  })

  it('同一天重复读（before === after）什么都不给', () => {
    expect(diligenceOf(7, 7)).toEqual({ points: 0, crossed: [] })
  })
})

describe('medianOf', () => {
  it('奇数个取中间', () => {
    expect(medianOf([80, 60, 70])).toBe(70)
  })

  it('偶数个取中间两个的平均', () => {
    expect(medianOf([60, 70, 80, 90])).toBe(75)
  })

  it('空 ⇒ null（交给调用方兜底，**不返回 NaN**）', () => {
    expect(medianOf([])).toBeNull()
  })

  it('⚠️ 不改动入参（原地排序会改到调用方的数组）', () => {
    const xs = [3, 1, 2]
    medianOf(xs)
    expect(xs).toEqual([3, 1, 2])
  })
})

describe('standoutWeight —— 左闭右开，0 和 1–9 同档', () => {
  it('0–9 ⇒ 0.5（⭐ 做第一个也在这档，不是 0）', () => {
    expect(standoutWeight(0)).toBe(0.5)
    expect(standoutWeight(1)).toBe(0.5)
    expect(standoutWeight(9)).toBe(0.5)
  })

  it('10–99 ⇒ 0.8', () => {
    expect(standoutWeight(10)).toBe(0.8)
    expect(standoutWeight(99)).toBe(0.8)
  })

  it('100–999 ⇒ 1', () => {
    expect(standoutWeight(100)).toBe(1)
    expect(standoutWeight(999)).toBe(1)
  })

  it('>= 1000 ⇒ 1.2', () => {
    expect(standoutWeight(1000)).toBe(1.2)
    expect(standoutWeight(100000)).toBe(1.2)
  })

  it('负数 / NaN ⇒ 最小档（防御，不该发生）', () => {
    expect(standoutWeight(-1)).toBe(0.5)
    expect(standoutWeight(Number.NaN)).toBe(0.5)
  })
})

describe('standoutOf —— 榜单中位数 × 样本量权重', () => {
  const repeat = (v: number, n: number) => Array.from({ length: n }, () => v)

  it('⭐ 空样本 ⇒ 基准 75、w = 0.5（鼓励做新场子的第一个人）', () => {
    expect(standoutOf(80, [])).toEqual({ sampleSize: 0, baseline: 75, weight: 0.5, total: 3 })
  })

  it('文档里那四行例子', () => {
    // 你是第 1 个：75 / 80 / w0.5 ⇒ 3
    expect(standoutOf(80, []).total).toBe(3)
    // 小场 10 人、中位 70、得 80 ⇒ f(10) × 0.8 = 8
    expect(standoutOf(80, repeat(70, 10)).total).toBe(8)
    // 中等场 100 人、中位 78、得 85 ⇒ f(7) × 1 = 7
    expect(standoutOf(85, repeat(78, 100)).total).toBe(7)
    // 大场 1000 人、中位 82、得 90 ⇒ f(8) × 1.2 = 9.6 ⇒ 10
    expect(standoutOf(90, repeat(82, 1000)).total).toBe(10)
  })

  it('低于中位数 ⇒ 0（不会出现负数）', () => {
    expect(standoutOf(60, repeat(80, 50)).total).toBe(0)
  })

  it('⚠️ w=0.5 且 f=1 时 round(0.5) = 1，小场最低也给 1 分（不是 0）', () => {
    expect(standoutOf(76, repeat(75, 5)).total).toBe(1)
  })

  it('⚠️ 中位数按**每人一条**算 —— 传进来的是榜单分数，不是提交流水', () => {
    // 榜单 6 条：[60,70,80,90,95,100] ⇒ 中位 (80+90)/2 = 85
    const r = standoutOf(95, [60, 70, 80, 90, 95, 100])
    expect(r.baseline).toBe(85)
    expect(r.sampleSize).toBe(6)
  })
})
