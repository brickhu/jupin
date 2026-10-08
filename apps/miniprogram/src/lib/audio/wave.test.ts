import { describe, expect, it } from 'vitest'

import { peakBars } from './wave'

describe('peakBars —— 采样压成柱子', () => {
  it('柱数永远等于要的个数', () => {
    const s = new Float32Array(1000).fill(0.5)
    expect(peakBars(s, 64)).toHaveLength(64)
    expect(peakBars(s, 8)).toHaveLength(8)
  })

  it('⚠️ 采样比柱子少（8 个采样要 64 根柱）也不越界，且长度正确', () => {
    const s = new Float32Array([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7])
    const bars = peakBars(s, 64)
    expect(bars).toHaveLength(64)
    // ⚠️ 有几根是 0（没采样落到那一格）—— 这是对的，不该硬塞值
    expect(bars.filter((v) => v > 0).length).toBeGreaterThan(0)
  })

  it('取的是**峰值**不是均值（否则语音会压成一条线）', () => {
    const s = new Float32Array(100) // 全 0
    s[50] = 0.9
    const bars = peakBars(s, 10)
    expect(Math.max(...bars)).toBeCloseTo(0.9, 5)
  })

  it('负值取绝对值（波形的下半部分也算"有声音"）', () => {
    const s = new Float32Array(10).fill(-0.8)
    expect(peakBars(s, 5).every((v) => Math.abs(v - 0.8) < 1e-6)).toBe(true)
  })

  it('⚠️ 空帧 / 非法柱数 ⇒ 空数组（调用方据此不画）', () => {
    expect(peakBars(null, 64)).toEqual([])
    expect(peakBars(new Float32Array(0), 64)).toEqual([])
    expect(peakBars(new Float32Array(100), 0)).toEqual([])
    expect(peakBars(new Float32Array(100), -1)).toEqual([])
  })

  it('⚠️ 分桶是按比例缩放的（相邻柱子来自采样的相邻区段）', () => {
    // 前半段小、后半段大 ⇒ 柱子应该"左低右高"，而不是交错的噪声
    const s = new Float32Array(100)
    for (let i = 0; i < 50; i++) s[i] = 0.1
    for (let i = 50; i < 100; i++) s[i] = 0.9
    const bars = peakBars(s, 4)
    expect(bars[0]).toBeCloseTo(0.1, 5)
    expect(bars[3]).toBeCloseTo(0.9, 5)
    expect(bars[0]!).toBeLessThan(bars[3]!)
  })
})
