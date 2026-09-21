import { describe, expect, it } from 'vitest'

import { WORD_GREEN_LINE } from './constants/index'
import { sentenceScore } from './scoring'

/**
 * ⚠️ 这里的每一条都是**产品口径**，不是数值精度：
 *    写错了不会报错，只会让所有人的分悄悄变一个样，而排行全靠它。
 */
const w = (score: number) => ({ score })
/** 造 n 个同分的词 */
const same = (score: number, n: number) => Array.from({ length: n }, () => w(score))

describe('sentenceScore —— 词级占主导的总分', () => {
  it('没有词 → null（调用方退回引擎总分，不要给 0 分）', () => {
    expect(sentenceScore([])).toBeNull()
  })

  it('⭐ 全绿 ⇒ 必然 ≥ 92.5（全读准了就该高）', () => {
    expect(sentenceScore(same(WORD_GREEN_LINE, 11))).toBe(93) // 50 + 42.5
    expect(sentenceScore(same(100, 11))).toBe(100)
  })

  it('⭐ 一个词都没读准 ⇒ 必然 < 50', () => {
    // 全不绿意味着每个词都低于绿线，于是词均也低于绿线
    expect(sentenceScore(same(WORD_GREEN_LINE - 1, 11)) as number).toBeLessThan(50)
    expect(sentenceScore(same(60, 11))).toBe(30)
    expect(sentenceScore(same(0, 11))).toBe(0)
  })

  it('⭐ 绿词比正好占一半权重', () => {
    // 一半绿、另一半 0 分：50×0.5 + 0.5×42.5 = 46.25 → 46
    expect(sentenceScore([...same(85, 5), ...same(0, 5)])).toBe(46)
  })

  it('⚠️ 每个词跨过绿线 = 50/词数 分，差距就是这样拉开的', () => {
    const oneGrey = sentenceScore([...same(100, 10), w(84)]) as number
    const allGreen = sentenceScore(same(100, 11)) as number
    expect(allGreen - oneGrey).toBeGreaterThan(3)
  })

  it('读得越好分只会越高（单调）', () => {
    const a = sentenceScore([...same(70, 10), w(50)]) as number
    const b = sentenceScore([...same(70, 10), w(90)]) as number
    expect(b).toBeGreaterThan(a)
  })

  it('越读越准，分数单调不减（逐档扫一遍）', () => {
    let prev = -1
    for (let s = 0; s <= 100; s += 5) {
      const v = sentenceScore(same(s, 11)) as number
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('始终落在 0–100 的整数上', () => {
    for (const s of [0, 1, 33.3, 66.6, 99.9, 100]) {
      const v = sentenceScore(same(s, 7)) as number
      expect(Number.isInteger(v)).toBe(true)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
    }
  })

  it('NaN 的词按 0 算', () => {
    expect(sentenceScore([w(Number.NaN)])).toBe(0)
  })
})
