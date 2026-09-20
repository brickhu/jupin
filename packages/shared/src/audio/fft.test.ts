import { describe, it, expect } from 'vitest'
import { fft, magnitudeSpectrum } from './fft'
import { AUDIO_SPEC } from '../constants/index'

/** 朴素 DFT —— **只存在于测试里**，作为 FFT 的参照实现 */
function dftMagnitude(frame: Float32Array): number[] {
  let n = 1
  while (n < frame.length) n <<= 1
  const half = n >> 1
  const out: number[] = []
  for (let k = 0; k < half; k++) {
    let re = 0
    let im = 0
    const factor = (-2 * Math.PI * k) / n
    for (let t = 0; t < frame.length; t++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * t) / Math.max(1, frame.length - 1)))
      const s = (frame[t] as number) * w
      re += s * Math.cos(factor * t)
      im += s * Math.sin(factor * t)
    }
    out.push(Math.sqrt(re * re + im * im))
  }
  return out
}

function noise(n: number, seed = 1): Float32Array {
  const out = new Float32Array(n)
  let s = seed
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    out[i] = (s / 0x7fffffff) * 2 - 1
  }
  return out
}

function sine(hz: number, sampleRate: number, n: number): Float32Array {
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate)
  return out
}

describe('magnitudeSpectrum —— FFT 必须与朴素 DFT 数值一致', () => {
  /**
   * ⭐⭐ 这条是整个替换的**安全网**。
   *    MFCC 是层层叠加的：频谱差一点 → 滤波器组能量差一点 → DCT 差一点 → 特征漂一点。
   *    而参考音的 MFCC 是**离线预算好写进内容**的 ——
   *    两边用的如果不是同一套数学，对齐会静默失准（不报错，只是光标乱跑）。
   */
  it('⭐ 随机帧：1024 点逐个比对，最大偏差 < 1e-9', () => {
    const frame = noise(AUDIO_SPEC.frameSamples)
    const fast = magnitudeSpectrum(frame)
    const slow = dftMagnitude(frame)
    expect(fast.length).toBe(slow.length)
    let maxDiff = 0
    for (let i = 0; i < slow.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs((fast[i] as number) - (slow[i] as number)))
    }
    expect(maxDiff).toBeLessThan(1e-9)
  })

  it('⭐ 正弦帧同样逐点一致', () => {
    const frame = sine(440, AUDIO_SPEC.sampleRate, AUDIO_SPEC.frameSamples)
    const fast = magnitudeSpectrum(frame)
    const slow = dftMagnitude(frame)
    let maxDiff = 0
    for (let i = 0; i < slow.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs((fast[i] as number) - (slow[i] as number)))
    }
    expect(maxDiff).toBeLessThan(1e-9)
  })

  it('非 2 的幂长度也会补零，结果仍与 DFT 一致', () => {
    const frame = noise(700)
    const fast = magnitudeSpectrum(frame)
    const slow = dftMagnitude(frame)
    let maxDiff = 0
    for (let i = 0; i < slow.length; i++) {
      maxDiff = Math.max(maxDiff, Math.abs((fast[i] as number) - (slow[i] as number)))
    }
    expect(maxDiff).toBeLessThan(1e-9)
  })

  it('峰值落在正确的频点（1kHz @16kHz，1024 点 → bin 64）', () => {
    const frame = sine(1000, AUDIO_SPEC.sampleRate, AUDIO_SPEC.frameSamples)
    const spec = magnitudeSpectrum(frame)
    let peak = 0
    for (let i = 1; i < spec.length; i++) {
      if ((spec[i] as number) > (spec[peak] as number)) peak = i
    }
    expect(peak).toBe(64)
  })
})

describe('fft 本身', () => {
  it('长度不是 2 的幂 → 明确报错（不要静默算错）', () => {
    expect(() => fft(new Float64Array(3), new Float64Array(3))).toThrow(/2 的幂/)
  })

  it('实部虚部长度不一致 → 明确报错', () => {
    expect(() => fft(new Float64Array(4), new Float64Array(8))).toThrow(/长度不一致/)
  })

  it('长度 1 与 2 的边界不炸', () => {
    const re1 = Float64Array.from([3])
    fft(re1, Float64Array.from([0]))
    expect(re1[0]).toBe(3)

    const re2 = Float64Array.from([1, 1])
    fft(re2, Float64Array.from([0, 0]))
    expect(re2[0]).toBeCloseTo(2, 10)
    expect(re2[1]).toBeCloseTo(0, 10)
  })

  it('冲击信号 → 平坦谱', () => {
    const n = 64
    const re = new Float64Array(n)
    const im = new Float64Array(n)
    re[0] = 1
    fft(re, im)
    for (let k = 0; k < n; k++) expect(Math.abs(re[k] as number)).toBeCloseTo(1, 10)
  })

  /**
   * ⭐ 性能回归：这条是「实时逐词跟随可不可行」的判据。
   *    替换前的朴素 DFT 在 Node 下每帧 ~7.5ms（1024 点）。
   *    FFT 应当快两个数量级；这里给一个宽松的上限（1ms），
   *    只要有人把它改回 O(n²) 就会立刻挂。
   */
  it('⭐ 1024 点单帧耗时 < 1ms（朴素 DFT 是 ~7.5ms）', () => {
    const frame = noise(AUDIO_SPEC.frameSamples)
    for (let i = 0; i < 20; i++) magnitudeSpectrum(frame) // 预热
    const t0 = performance.now()
    const ROUNDS = 200
    for (let i = 0; i < ROUNDS; i++) magnitudeSpectrum(frame)
    const per = (performance.now() - t0) / ROUNDS
    expect(per).toBeLessThan(1)
  })
})
