import { describe, expect, it } from 'vitest'

import { WORD_GREEN_LINE } from './constants/index'
import {
  formatScore,
  GATE_INCOMPLETE,
  SCORE_WEIGHTS,
  scoreSentence,
  sentenceScore,
  speechGaps,
} from './scoring'

/**
 * ⚠️ 这里的每一条都是**产品口径**，不是数值精度：
 *    写错了不会报错，只会让所有人的分悄悄变一个样，而排行全靠它。
 */
const w = (score: number, dp?: 'omission') => ({ score, ...(dp ? { dp } : {}) })
const same = (score: number, n: number) => Array.from({ length: n }, () => w(score))

describe('scoreSentence —— 校准后的总分', () => {
  it('没有词 → null（调用方退回引擎总分，不要给 0 分）', () => {
    expect(sentenceScore([])).toBeNull()
  })

  it('⭐ 母语级：全维满分 + 全绿 → 100', () => {
    const r = scoreSentence(same(100, 11), { accuracy: 100, fluency: 100, standard: 100, integrity: 100 })
    expect(r?.score).toBe(100)
  })

  it('⭐⭐ 权重里韵律最重（这是校准实验的结论）', () => {
    expect(SCORE_WEIGHTS.prosody).toBeGreaterThan(SCORE_WEIGHTS.accuracy)
    expect(SCORE_WEIGHTS.prosody).toBeGreaterThan(SCORE_WEIGHTS.fluency)
    expect(SCORE_WEIGHTS.prosody).toBeGreaterThan(SCORE_WEIGHTS.completeness)
  })

  it('⭐ 词级看的是**最差的那个词**：只把一个词读砸，短板分就掉下来', () => {
    const full = scoreSentence(same(90, 11))
    const oneBad = scoreSentence([...same(90, 10), w(20)])
    expect((oneBad as any).weakness).toBeLessThan((full as any).weakness)
    // 其余 10 个词一字未变，掉的只能是「最差的那个」那一半
    expect((full as any).weakness - (oneBad as any).weakness).toBeGreaterThan(30)
  })

  it('⚠️ 绿词比是短板分的一半：10/11 绿时，一个 20 分的词也压不到 50 以下（这是刻意的）', () => {
    const oneBad = scoreSentence([...same(90, 10), w(20)])
    expect((oneBad as any).weakness).toBeGreaterThan(50)
  })

  it('⭐⭐ 有硬错误（漏读）→ 封顶 79，且写明原因', () => {
    const r = scoreSentence([...same(100, 10), w(100, 'omission')], {
      accuracy: 100, fluency: 100, standard: 100, integrity: 90,
    })
    expect(r?.score).toBe(GATE_INCOMPLETE)
    expect(r?.gates.length).toBe(1)
  })

  it('长停顿会扣流利分', () => {
    const base = scoreSentence(same(90, 11), { fluency: 90, standard: 90, accuracy: 90, integrity: 100 })
    const choppy = scoreSentence(same(90, 11), {
      fluency: 90, standard: 90, accuracy: 90, integrity: 100, longGapCount: 5, longestGapMs: 1200,
    })
    expect((choppy as any).fluency).toBeLessThan((base as any).fluency)
    expect((choppy as any).score).toBeLessThan((base as any).score)
  })

  it('音节检错率会扣准确分', () => {
    const clean = scoreSentence(same(90, 11), { accuracy: 90, standard: 90, fluency: 90 })
    const errs = scoreSentence(same(90, 11), { accuracy: 90, standard: 90, fluency: 90, syllableErrorRate: 0.5 })
    expect((errs as any).accuracy).toBeLessThan((clean as any).accuracy)
  })

  it('拿不到引擎四维时用词级分兜底（不崩、不给 0）', () => {
    const r = scoreSentence(same(90, 11), {})
    expect(r?.score).toBeGreaterThan(80)
  })

  it('⭐ 分值一律保留一位小数（排行要靠它拉开并列）', () => {
    for (const s of [0, 1, 33.3, 66.6, 99.9, 100]) {
      const r = scoreSentence(same(s, 7), {})
      const v = r?.score as number
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(100)
      // 乘以 10 之后必须是整数 —— 也就是「最多一位小数」
      expect(Math.round(v * 10)).toBeCloseTo(v * 10, 8)
      expect(formatScore(v)).toMatch(/^\d+\.\d$/)
    }
  })

  it('分项也保留一位小数', () => {
    const r = scoreSentence(same(77, 7), { accuracy: 77.7, fluency: 61.4, standard: 55.5, integrity: 100 })
    for (const k of ['prosody', 'weakness', 'accuracy', 'fluency', 'completeness'] as const) {
      const v = r?.[k] as number
      expect(Math.round(v * 10)).toBeCloseTo(v * 10, 8)
    }
    expect(r?.score).toBeGreaterThan(0)
  })

  it('⚠️ formatScore：null / NaN 给短横线，不是 0.0', () => {
    expect(formatScore(null)).toBe('—')
    expect(formatScore(undefined)).toBe('—')
    expect(formatScore(Number.NaN)).toBe('—')
    expect(formatScore(78)).toBe('78.0')
    expect(formatScore(78.34)).toBe('78.3')
  })

  it('分项都在 0–100 之间（展示用）', () => {
    const r = scoreSentence(same(50, 5), { accuracy: 50, fluency: 50, standard: 50, integrity: 50 })
    for (const k of ['prosody', 'weakness', 'accuracy', 'fluency', 'completeness'] as const) {
      expect(r?.[k]).toBeGreaterThanOrEqual(0)
      expect(r?.[k]).toBeLessThanOrEqual(100)
    }
  })
})

describe('speechGaps —— 词间停顿（引擎不给，自己算）', () => {
  it('正常连读没有长停顿', () => {
    const g = speechGaps([
      { startMs: 0, endMs: 300 },
      { startMs: 320, endMs: 600 },
      { startMs: 620, endMs: 900 },
    ])
    expect(g.longGapCount).toBe(0)
    expect(g.longestGapMs).toBe(20)
  })

  it('超过 400ms 记一次长停顿', () => {
    const g = speechGaps([
      { startMs: 0, endMs: 300 },
      { startMs: 900, endMs: 1200 },
    ])
    expect(g.longGapCount).toBe(1)
    expect(g.longestGapMs).toBe(600)
  })

  it('重叠/乱序的时间戳不会算出负数停顿', () => {
    const g = speechGaps([
      { startMs: 500, endMs: 800 },
      { startMs: 600, endMs: 900 },
    ])
    expect(g.longGapCount).toBe(0)
    expect(g.longestGapMs).toBe(0)
  })
})
