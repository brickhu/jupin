import { describe, expect, it } from 'vitest'

import { intensityOf, peakBars, samplesFromByteTimeDomain, samplesFromPcm16 } from './level'

/**
 * ⚠️ 这些断言钉的是**画出来对不对**，不是数值精度：
 *    波形画错了不会报错，只会让人以为「波形没跟着我的声音走」。
 */
describe('samplesFromPcm16 —— 16bit 小端裸 PCM → 采样', () => {
  it('满量程正负、零点、小端顺序都对', () => {
    // 0x0000 = 0；0x7FFF = +32767；0x8000 = -32768；0xFFFF = -1
    const s = samplesFromPcm16(new Uint8Array([0x00, 0x00, 0xff, 0x7f, 0x00, 0x80, 0xff, 0xff]))
    expect(s.length).toBe(4)
    expect(s[0]).toBeCloseTo(0, 5)
    expect(s[1]).toBeCloseTo(1, 3)
    expect(s[2]).toBeCloseTo(-1, 5)
    expect(s[3]).toBeCloseTo(-1 / 32768, 6)
  })

  it('奇数长度的尾巴丢掉，不产生 NaN', () => {
    const s = samplesFromPcm16(new Uint8Array([0x00, 0x00, 0x7f]))
    expect(s.length).toBe(1)
    expect(Number.isNaN(s[0] as number)).toBe(false)
  })
})

describe('samplesFromByteTimeDomain —— analyser 的 0..255', () => {
  it('128 就是静音', () => {
    const s = samplesFromByteTimeDomain(new Uint8Array([128, 128]))
    expect(s[0]).toBe(0)
    expect(s[1]).toBe(0)
  })

  it('0 / 255 对应 -1 / +1 附近', () => {
    const s = samplesFromByteTimeDomain(new Uint8Array([0, 255]))
    expect(s[0]).toBeCloseTo(-1, 5)
    expect(s[1]).toBeCloseTo(0.9921875, 5)
  })
})

describe('peakBars —— 每根柱子多高', () => {
  it('静音 → 全 0（不是「一点底噪」）', () => {
    expect(peakBars(new Float32Array(64), 8)).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
  })

  it('⭐ 取的是峰值不是均值：一个尖峰能顶起一整根柱子', () => {
    const s = new Float32Array(64)
    s[10] = 0.9 // 落在第 2 根柱子里（每根 8 个采样）
    const bars = peakBars(s, 8)
    expect(bars[1]).toBeCloseTo(0.9, 5)
    expect(bars[0]).toBe(0)
    expect(bars[2]).toBe(0)
  })

  it('⚠️ 采样比柱子还少 → 空数组（宁可让调用方不画，也不画一排等高柱）', () => {
    expect(peakBars(new Float32Array(4), 8)).toEqual([])
    expect(peakBars(new Float32Array(0), 8)).toEqual([])
  })

  it('超过满量程的异常值夹到 1', () => {
    const s = new Float32Array(16)
    s[0] = 3
    expect(peakBars(s, 4)[0]).toBe(1)
  })
})

describe('intensityOf —— 0..100 的强度', () => {
  it('静音 → 0，满量程 → 100', () => {
    expect(intensityOf(new Float32Array(32))).toBe(0)
    expect(intensityOf(new Float32Array([-1, 1]))).toBe(100)
  })

  it('半幅 → 50（与掘金那篇的公式同一条）', () => {
    expect(intensityOf(new Float32Array([-0.5, 0.5]))).toBeCloseTo(50, 5)
  })

  it('空采样 → 0，不抛', () => {
    expect(intensityOf([])).toBe(0)
  })
})
