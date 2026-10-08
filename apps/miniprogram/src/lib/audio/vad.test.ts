import { describe, expect, it } from 'vitest'

import {
  AUTO_STOP_MIN_VOICED_MS,
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
  it('⭐ 说过话 + 静音够久 ⇒ 结束', () => {
    expect(autoStopAfter({ voicedMs: AUTO_STOP_MIN_VOICED_MS, silentMs: AUTO_STOP_SILENCE_MS })).toBe(true)
  })
  it('⚠️ 只说了很短（低于固定下限）⇒ 静音再久也不结束（防"嗯…"一下就判完）', () => {
    expect(autoStopAfter({ voicedMs: AUTO_STOP_MIN_VOICED_MS - 1, silentMs: 5000 })).toBe(false)
  })
  it('⚠️ 一个字都没说 ⇒ 永不结束（安静的房间不能自己停）', () => {
    expect(autoStopAfter({ voicedMs: 0, silentMs: 999_999 })).toBe(false)
  })
  it('⚠️ 说够了但静音不够 ⇒ 不结束（刚说完一个词）', () => {
    expect(autoStopAfter({ voicedMs: 3000, silentMs: 300 })).toBe(false)
  })
  it('⚠️ 边界：正好等于下限时算满足（>= 而不是 >）', () => {
    expect(autoStopAfter({ voicedMs: AUTO_STOP_MIN_VOICED_MS, silentMs: AUTO_STOP_SILENCE_MS })).toBe(true)
  })

  /**
   * ⭐⭐ **回归测试：用户 2026-10-09 报的 bug** ✓
   *
   * ⚠️ 症状：**读完不会自动结束**，只有录到某个时长才停（⭐ 用户原话 ✓）
   * ⚠️ 根因一：判据原来用 `recordedMs`（⭐ 录音墙钟 ✗）—— 把开头静音和
   *    用户自己的停顿全算进去了 ✗ ⇒ 净语音要超过 标准音×1.2 才可能成立 ✗
   *    ⇒ ⭐ 而人念完一句的净语音**必然短于**标准音时长（⭐ 标准音含词间停顿 ✓）
   *      ⇒ ⭐⭐ **永远不触发** ✗✓
   * ⚠️ 根因二（⭐ 用户随后指出）：那个下限来自**服务端的标准音时长** ✗
   *    ⇒ ⚠️ 把"纯本地的判断"绑上了网络与后端 ✗
   *    ⇒ ⭐ 现在：固定下限 800ms + 静音 1.2s ⇒ ⭐ **零服务端依赖** ✓✓
   */
  it('⭐⭐ 净说话够 800ms 就该能结束（⭐ 不需要知道标准音多长 ✓）', () => {
    expect(autoStopAfter({ voicedMs: 900, silentMs: 1300 })).toBe(true)
  })
  it('⭐⭐ 签名里【不】再有 expectedMs（⭐ 判据不依赖服务端数据 ✓）', () => {
    // ⚠️ 这条测试是"契约"：参数里出现 expectedMs 就说明依赖又回来了 ✗
    const ok = autoStopAfter({ voicedMs: 900, silentMs: 1300 })
    expect(ok).toBe(true)
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
    expect(autoStopAfter(st)).toBe(false)
  })

  it('⭐ 正常读完：说够了时长 + 静音 1.2 秒 ⇒ 结束', () => {
    let st = VAD_STATE_ZERO
    for (let i = 0; i < 40; i++) st = advanceVad(st, 'voice', F) // 6.8s 说话
    for (let i = 0; i < 8; i++) st = advanceVad(st, 'silence', F) // 1.36s 静音
    expect(autoStopAfter(st)).toBe(true)
  })
})
