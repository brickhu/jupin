import { describe, it, expect } from 'vitest'
import {
  KNOWN_SAMPLE_RATES,
  estimateSampleRate,
  snapSampleRate,
  resampleLinear,
  normalizePcmRate,
} from './resample'
import { pcmInt16ToFloat32, float32ToPcmInt16 } from './wav'
import { AUDIO_SPEC } from '../constants/index'

/** 生成一段单频正弦（浮点，[-1,1]） */
function sine(hz: number, sampleRate: number, ms: number, amp = 0.6): Float32Array {
  const n = Math.round((sampleRate * ms) / 1000)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / sampleRate)
  return out
}

const CH = AUDIO_SPEC.channels
const BITS = AUDIO_SPEC.bitDepth

describe('estimateSampleRate —— 从字节数反推采样率', () => {
  it('16kHz 单声道 16bit：每秒 32000 字节 → 16000', () => {
    expect(estimateSampleRate(32000, 1000, CH, BITS)).toBeCloseTo(16000, 0)
  })

  /**
   * ⭐ 这条是**真机实测数据**的回归测试。
   * 真机自检 T3+T4 报的是「每秒 16801 字节 → 8400」。
   * ⚠️ 如果哪天这条挂了，说明反推公式被人改坏了。
   */
  it('真机实测的 8kHz 数据：每秒 16801 字节 → 8400 → 吸附到 8000', () => {
    const est = estimateSampleRate(16801, 1000, CH, BITS)
    expect(est).toBeCloseTo(8400, -1) // 实测 8400.5，取整到十位
    expect(snapSampleRate(est)).toBe(8000)
  })

  it('无法计算时返回 0（而不是 NaN / Infinity）', () => {
    expect(estimateSampleRate(0, 1000, CH, BITS)).toBe(0)
    expect(estimateSampleRate(32000, 0, CH, BITS)).toBe(0)
    expect(estimateSampleRate(-1, 1000, CH, BITS)).toBe(0)
  })

  it('双声道会把反推值减半 —— 所以声道数必须传对', () => {
    expect(estimateSampleRate(64000, 1000, 2, BITS)).toBeCloseTo(16000, 0)
  })
})

describe('snapSampleRate —— 吸附到合法档位', () => {
  it('16000 精确值不动', () => {
    expect(snapSampleRate(16000)).toBe(16000)
  })

  it('±8% 内的偏差都吸附到最近的档位', () => {
    expect(snapSampleRate(15600)).toBe(16000)
    expect(snapSampleRate(16800)).toBe(16000)
    expect(snapSampleRate(7900)).toBe(8000)
    expect(snapSampleRate(8600)).toBe(8000) // 偏 7.5%，仍在容差内
  })

  it('偏得离谱（测不准）时返回 0，而不是硬吸一个档位', () => {
    // 20000 距 16000 偏 25%、距 22050 偏 9.3% —— 两个都超标
    expect(snapSampleRate(20000)).toBe(0)
    expect(snapSampleRate(0)).toBe(0)
    expect(snapSampleRate(Number.NaN)).toBe(0)
  })

  it('每一个已知档位都能吸附回自己', () => {
    for (const r of KNOWN_SAMPLE_RATES) expect(snapSampleRate(r)).toBe(r)
  })
})

describe('resampleLinear —— 重采样', () => {
  it('⭐ fromRate === toRate 时返回同一个引用（恒等变换，零开销）', () => {
    const x = sine(440, 16000, 100)
    expect(resampleLinear(x, 16000, 16000)).toBe(x)
  })

  it('8kHz → 16kHz 长度严格翻倍', () => {
    const x = sine(500, 8000, 200)
    expect(resampleLinear(x, 8000, 16000).length).toBe(x.length * 2)
  })

  it('16kHz → 8kHz 长度严格减半', () => {
    const x = sine(500, 16000, 200)
    expect(resampleLinear(x, 16000, 8000).length).toBe(x.length / 2)
  })

  /**
   * ⭐ 重采样是**时域保真**的：它只改「每秒多少个采样点」，不改信号本身。
   *    （曾经这里用基频检测来验这件事 —— 但基频检测属于实时跟随那条链路，
   *      而那整条链路已经作为产品决策摘掉了。所以改用更能自证的性质来验。）
   */
  it('⭐ 8kHz → 16kHz：长度翻倍，且**波形形状不变**（时域保真）', () => {
    const raw = sine(500, 8000, 200)
    const up = resampleLinear(raw, 8000, 16000)
    expect(up.length).toBe(raw.length * 2)

    // 时域保真：升采样后每两个点之间线性插值，等价于「同一段信号用更密的点描述」。
    // 验法：把升采样结果再抽回 8kHz，应当与原始波形基本一致。
    const back = resampleLinear(up, 16000, 8000)
    expect(back.length).toBe(raw.length)
    let maxDiff = 0
    for (let i = 1; i < raw.length - 1; i++) {
      maxDiff = Math.max(maxDiff, Math.abs((back[i] as number) - (raw[i] as number)))
    }
    expect(maxDiff).toBeLessThan(0.05)
  })
  it('空数组 / 非法采样率不炸', () => {
    expect(resampleLinear(new Float32Array(0), 8000, 16000).length).toBe(0)
    const x = sine(440, 8000, 50)
    expect(resampleLinear(x, 0, 16000)).toBe(x)
    expect(resampleLinear(x, 8000, 0)).toBe(x)
  })
})

describe('normalizePcmRate —— 裸 PCM 的归一化', () => {
  it('16kHz → 16kHz 原样返回（恒等）', () => {
    const pcm = float32ToPcmInt16(sine(440, 16000, 100))
    expect(normalizePcmRate(pcm, 16000, 16000)).toBe(pcm)
  })

  it('8kHz → 16kHz 字节数翻倍，且幅度量级保持', () => {
    const pcm = float32ToPcmInt16(sine(440, 8000, 200, 0.5))
    const out = normalizePcmRate(pcm, 8000, 16000)
    expect(out.length).toBe(pcm.length * 2)

    const back = pcmInt16ToFloat32(out)
    let peak = 0
    for (const v of back) peak = Math.max(peak, Math.abs(v))
    expect(peak).toBeGreaterThan(0.4)
    expect(peak).toBeLessThan(0.6)
  })

  it('Int16 往返不产生削波（±1 边界）', () => {
    const loud = new Float32Array(64).fill(1)
    const pcm = float32ToPcmInt16(loud)
    const back = pcmInt16ToFloat32(pcm)
    for (const v of back) expect(v).toBeLessThanOrEqual(1)
  })
})
