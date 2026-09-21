import { describe, expect, it } from 'vitest'

import { pcmLevel } from './level'

/**
 * ⚠️ 这里的每一条都是"画出来对不对"的问题，而不是数值精度问题：
 *    错了不会报错，只会让那排柱子一直顶格、或者一直不动 ——
 *    两种看起来都像"这个功能是坏的"。
 */

/** 造一段 16bit 小端 PCM */
function pcm(samples: number[]): ArrayBuffer {
  const buf = new ArrayBuffer(samples.length * 2)
  const view = new DataView(buf)
  samples.forEach((v, i) => view.setInt16(i * 2, v, true))
  return buf
}

/** 幅度为 amp 的正弦，n 个采样 */
function sine(amp: number, n = 320): ArrayBuffer {
  const out: number[] = []
  for (let i = 0; i < n; i++) out.push(Math.round(amp * Math.sin((2 * Math.PI * i) / 32)))
  return pcm(out)
}

describe('pcmLevel —— 一帧的响度 → 0..1', () => {
  it('静音 → 0', () => {
    expect(pcmLevel(pcm(new Array(320).fill(0)))).toBe(0)
  })

  it('空帧 / 半帧 → 0（不抛异常）', () => {
    expect(pcmLevel(new ArrayBuffer(0))).toBe(0)
    expect(pcmLevel(new ArrayBuffer(1))).toBe(0)
  })

  it('满量程方波 → 1（顶格但不越界）', () => {
    const buf = pcm(Array.from({ length: 320 }, (_, i) => (i % 2 ? 32767 : -32768)))
    expect(pcmLevel(buf)).toBe(1)
  })

  it('⚠️ 越响越高（单调）—— 这是它唯一的职责', () => {
    const quiet = pcmLevel(sine(200))
    const normal = pcmLevel(sine(2000))
    const loud = pcmLevel(sine(20000))
    expect(quiet).toBeLessThan(normal)
    expect(normal).toBeLessThan(loud)
  })

  it('⭐ 正常说话的音量要落在**中上段**，不能贴着底', () => {
    // 约 -27dBFS —— 正常朗读的典型值。
    // 若这里接近 0，说明定标区间错了：用户说话时柱子几乎不动，看起来像没在工作。
    expect(pcmLevel(sine(3000))).toBeGreaterThan(0.45)
  })

  it('底噪级别（约 -60dBFS）压到最低档', () => {
    // 20*log10(30/32768) ≈ -60.8dB → 低于下限，钳到 0
    expect(pcmLevel(sine(30))).toBe(0)
  })

  it('始终落在 0..1 之间（任何输入都不越界）', () => {
    for (const amp of [1, 10, 100, 1000, 10000, 32767]) {
      const v = pcmLevel(sine(amp))
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})
