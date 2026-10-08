import { describe, expect, it } from 'vitest'

import {
  AUTO_STOP_MIN_RATIO,
  AUTO_STOP_SILENCE_MS,
  VAD_STATE_ZERO,
  advanceVad,
  autoStopAfter,
  classifyChunk,
} from './vad'

/** 造一段采样：给定振幅的正弦（用来代表"有声音"） */
function tone(amplitude: number, n = 160): Float32Array {
  const a = new Float32Array(n)
  for (let i = 0; i < n; i++) a[i] = amplitude * Math.sin(i / 4)
  return a
}

describe('classifyChunk —— 一帧属于哪一种（三态）', () => {
  it('数字小 = 静音，数字大 = 有声音', () => {
    expect(classifyChunk(tone(0.001))).toBe('silence')
    expect(classifyChunk(tone(0.5))).toBe('voice')
  })

  it('⚠️⚠️ 解码不出来是独立的第三态，**不是**静音', () => {
    // 这一条是整个模块里最要紧的一条：把它当静音，就会在不支持解码的环境
    // （开发者工具）里连着一路攒静音、一秒多之后把录音掐断 ✗✗
    expect(classifyChunk(null)).toBe('undecodable')
    expect(classifyChunk(new Float32Array(0))).toBe('undecodable')
  })

  it('⚠️ 用 RMS 而不是峰值 —— 同一个尖峰，摊到更多点上就算静音', () => {
    // 一个 0.9 的尖峰摊到 N 个点上 ⇒ RMS = 0.9 / sqrt(N)
    const spike = (n: number) => {
      const a = new Float32Array(n)
      a[Math.floor(n / 2)] = 0.9
      return a
    }
    // N=200  ⇒ RMS ≈ 0.064 ⇒ 有声音
    expect(classifyChunk(spike(200))).toBe('voice')
    // N=2000 ⇒ RMS ≈ 0.0201 ⇒ ⚠️ **刚好越过** 0.02 这条线 ⇒ 判成有声音
    //   （这就是"阈值偏保守"的代价：孤立的一个咔哒声在 2000 点里也算有声音 ✓ 宁可这样）
    expect(classifyChunk(spike(2000))).toBe('voice')
    // N=4000 ⇒ RMS ≈ 0.0142 ⇒ 静音 ✓
    expect(classifyChunk(spike(4000))).toBe('silence')
  })
})

describe('autoStopAfter —— 该不该自动结束（"读完了"）', () => {
  const expected = 5000
  it('⭐ 两个条件都满足才结束', () => {
    expect(
      autoStopAfter({ voicedMs: expected * AUTO_STOP_MIN_RATIO, silentMs: AUTO_STOP_SILENCE_MS, expectedMs: expected }),
    ).toBe(true)
  })
  it('⚠️⚠️ 净说话时长不够时，静音再久也不结束（读到一半的停顿不能掐断录音）', () => {
    expect(autoStopAfter({ voicedMs: 1000, silentMs: 5000, expectedMs: expected })).toBe(false)
  })
  it('⚠️ 说够了但静音不够也不结束（刚说完一个词）', () => {
    expect(autoStopAfter({ voicedMs: 4000, silentMs: 300, expectedMs: expected })).toBe(false)
  })
  it('⚠️ 这一句没有标准音时**一律不自动结束**（宁可让用户自己点）', () => {
    expect(autoStopAfter({ voicedMs: 999_999, silentMs: 999_999, expectedMs: null })).toBe(false)
    expect(autoStopAfter({ voicedMs: 999_999, silentMs: 999_999, expectedMs: 0 })).toBe(false)
  })
  it('⚠️ 边界：正好等于下限时算满足（>= 而不是 >）', () => {
    expect(
      autoStopAfter({ voicedMs: expected * AUTO_STOP_MIN_RATIO, silentMs: AUTO_STOP_SILENCE_MS, expectedMs: expected }),
    ).toBe(true)
  })

  /**
   * ⭐⭐ **回归测试：用户 2026-10-09 报的那个 bug** ✓
   *
   * ⚠️ 起因：判据原来用的是 `recordedMs`（⭐ 录音墙钟总时长 ✗）——
   *    它把**开头静音**和**用户读的时候自己的停顿**全算进去了 ✗
   *    ⇒ ⚠️ 于是"净说话时长"必须超过 `expectedMs × 1.2` 才可能成立 ✗
   *    ⇒ ⭐ 而人把一句话念完，净语音**一定短于**标准音时长（含词间停顿 ✓）
   *    ⇒ ⭐⭐ **结果就是自动结束永远不触发** ✗✓ —— 用户看到的行为是"按秒数停，不是按读完停" ✓
   *
   * ⭐ 现在看 `voicedMs`，门槛 0.5：⭐ 说了半句话以上 + 静音够久 ⇒ 判读完 ✓
   */
  it('⭐⭐ 读得快的人（净语音不到标准音时长）也该能自动结束', () => {
    // ⭐ 标准音 5s，用户净说了 2.75s 就停了 —— 旧判据（recordedMs ≥ 6000）永远到不了 ✗
    expect(autoStopAfter({ voicedMs: 2750, silentMs: 1300, expectedMs: expected })).toBe(true)
  })
  it('⚠️ 但只念了两个词就停 ⇒ 仍不结束（下限要继续守住）', () => {
    expect(autoStopAfter({ voicedMs: expected * 0.2, silentMs: 5000, expectedMs: expected })).toBe(false)
  })
  it('⭐ 门槛必须 < 1（⚠️ 标准音含停顿，净语音必然更短 ✓）', () => {
    expect(AUTO_STOP_MIN_RATIO).toBeLessThan(1)
  })
})
describe('advanceVad —— 逐帧累计（规则要一眼看得出）', () => {
  const F = 170 // mp3 下 1KB ≈ 170ms 一帧（见 RECORD_SPEC 的说明）

  it('有声音 ⇒ 时长涨、连续静音清零', () => {
    const s = advanceVad({ recordedMs: 1000, silentMs: 500, voicedMs: 0 }, 'voice', F)
    expect(s).toEqual({ recordedMs: 1000 + F, silentMs: 0, voicedMs: F })
  })

  it('静音 ⇒ 两个都涨', () => {
    const s = advanceVad({ recordedMs: 1000, silentMs: 500, voicedMs: 200 }, 'silence', F)
    expect(s).toEqual({ recordedMs: 1000 + F, silentMs: 500 + F, voicedMs: 200 })
  })

  it('⚠️⚠️ 解不出来 ⇒ 时长照涨，但**连续静音清零**（当成"他在说话"，绝不掐断）', () => {
    const s = advanceVad({ recordedMs: 1000, silentMs: 9999, voicedMs: 300 }, 'undecodable', F)
    expect(s).toEqual({ recordedMs: 1000 + F, silentMs: 0, voicedMs: 300 })
  })

  it('⭐ 连成一条链：它真的不会在不支持解码的环境里自动结束', () => {
    let st = VAD_STATE_ZERO
    for (let i = 0; i < 100; i++) st = advanceVad(st, 'undecodable', F)
    expect(st.recordedMs).toBe(100 * F)
    expect(st.silentMs).toBe(0)
    expect(autoStopAfter({ ...st, expectedMs: 5000 })).toBe(false)
  })

  it('⭐ 正常读完：说够了时长 + 静音 1.2 秒 ⇒ 结束', () => {
    let st = VAD_STATE_ZERO
    for (let i = 0; i < 40; i++) st = advanceVad(st, 'voice', F) // 6.8s 说话
    for (let i = 0; i < 8; i++) st = advanceVad(st, 'silence', F) // 1.36s 静音
    expect(autoStopAfter({ ...st, expectedMs: 5000 })).toBe(true)
  })
})
