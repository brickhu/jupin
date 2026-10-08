import { describe, expect, it } from 'vitest'

import {
  WAVE_DECAY,
  WAVE_GAIN_ZERO,
  WAVE_MIN_PEAK,
  advanceWaveGain,
  applyWaveGain,
  peakBars,
} from './wave'

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

describe('自动增益 —— 让柱子撑满（只作用于画图）', () => {
  const F = (v: number) => new Array(4).fill(v)

  it('⭐ 弱音也会被拉到接近满格（这就是"幅度不足"的修法）', () => {
    let g = WAVE_GAIN_ZERO
    g = advanceWaveGain(g, F(0.3)) // 见到 0.3 ⇒ 它成了"满格"基准
    const out = applyWaveGain(F(0.3), g)
    expect(out[0]).toBeCloseTo(1, 5) // 最强的那一帧顶到满格 ✓
  })

  it('⚠️ 相对关系保留（大声那帧仍然比小声高）', () => {
    let g = advanceWaveGain(WAVE_GAIN_ZERO, F(0.4))
    const out = applyWaveGain([0.1, 0.2, 0.4], g)
    expect(out[0]!).toBeLessThan(out[1]!)
    expect(out[1]!).toBeLessThan(out[2]!)
  })

  it('⚠️ 上去快：后来一帧更大，基准立刻跟上（第一声不会被画小）', () => {
    let g = advanceWaveGain(WAVE_GAIN_ZERO, F(0.1))
    g = advanceWaveGain(g, F(0.8))
    expect(g.peak).toBeCloseTo(0.8, 5)
  })

  it('⚠️ 下来慢：安静之后基准只按 DECAY 缓慢回落（否则会一跳一跳）', () => {
    let g = advanceWaveGain(WAVE_GAIN_ZERO, F(0.8))
    g = advanceWaveGain(g, F(0))
    expect(g.peak).toBeCloseTo(0.8 * WAVE_DECAY, 5)
    expect(g.peak).toBeGreaterThan(0.5) // 掉得很慢 ✓
  })

  it('⚠️⚠️ 有下限：极安静时不再放大（否则底噪会被画成满格噪声）', () => {
    let g = WAVE_GAIN_ZERO
    for (let i = 0; i < 200; i++) g = advanceWaveGain(g, F(0.001))
    expect(g.peak).toBe(WAVE_MIN_PEAK)
    // 底噪 0.001 / 下限 0.04 ⇒ 只有一点点高，不会满格 ✓
    expect(applyWaveGain(F(0.001), g)[0]!).toBeLessThan(0.05)
  })

  it('⚠️ 结果夹到 1（浮点误差不许画到带子外面）', () => {
    const g = advanceWaveGain(WAVE_GAIN_ZERO, F(1))
    expect(applyWaveGain([1.2], g)[0]).toBe(1)
  })
})
