import { describe, expect, it } from 'vitest'

import {
  AUTO_STOP_MIN_RATIO,
  AUTO_STOP_WORD_MS,
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
  /** ⭐ 一个 11 个词的句子（⭐ 下限 = 11 × 400 × 0.6 = 2640ms ✓） */
  const N = 11
  const floor = N * AUTO_STOP_WORD_MS * AUTO_STOP_MIN_RATIO

  it('⭐ 说够了 + 静音够久 ⇒ 结束', () => {
    expect(autoStopAfter({ voicedMs: floor, silentMs: AUTO_STOP_SILENCE_MS, wordCount: N })).toBe(true)
  })
  it('⚠️⚠️ **只读了一半就停 ⇒ 绝不能结束**（⭐ 用户 2026-10-09 报的 bug ✓）', () => {
    // ⚠️ 11 个词读到第 5 个 ≈ 说了 2000ms ✗ < 2640 ⇒ ⭐ 不该判读完 ✓
    expect(autoStopAfter({ voicedMs: 2000, silentMs: 60_000, wordCount: N })).toBe(false)
  })
  it('⚠️ 一个字都没说 ⇒ 永不结束（安静的房间不能自己停）', () => {
    expect(autoStopAfter({ voicedMs: 0, silentMs: 999_999, wordCount: N })).toBe(false)
  })
  it('⚠️ 说够了但静音不够 ⇒ 不结束（刚说完一个词）', () => {
    expect(autoStopAfter({ voicedMs: 9000, silentMs: 300, wordCount: N })).toBe(false)
  })
  it('⚠️ 词数为 0（⭐ 正文异常 / 还没加载）⇒ 绝不结束', () => {
    expect(autoStopAfter({ voicedMs: 999_999, silentMs: 999_999, wordCount: 0 })).toBe(false)
  })
  it('⭐ 短句的下限也短（⭐ 3 个词 ⇒ 720ms 就够 ✓）', () => {
    expect(autoStopAfter({ voicedMs: 1100, silentMs: AUTO_STOP_SILENCE_MS, wordCount: 3 })).toBe(true)
  })

  /**
   * ⭐⭐ **两条回归测试，各钉住一个真实 bug** ✓
   *
   * ⚠️ bug ①（最早）：判据用 `recordedMs`（录音墙钟 ✗）+ 门槛"标准音 × 1.2"✗
   *    ⇒ ⚠️ 那还要求客户端先取回**服务端**的标准音时长 ✗
   *    ⇒ ⭐ 读得快的人（净语音必然短于含停顿的标准音）**永不触发** ✗✓
   *
   * ⚠️ bug ②（紧接着）：改成固定 800ms ✗
   *    ⇒ ⚠️ **半句话早就超过 800ms** ⇒ ⭐ 读一半就停也被当成读完了 ✗✓（用户指出 ✓）
   *
   * ⭐ 现在：下限 = 词数 × 400ms × 0.6 ⇒ 既跟句子长度走 ✓ 又零服务端依赖 ✓
   */
  it('⭐⭐ 回归①：不依赖服务端 —— 签名里没有 expectedMs 之类的东西', () => {
    // ⚠️ 参数里出现"标准音时长"就说明依赖又回来了 ✗
    expect(autoStopAfter({ voicedMs: 4000, silentMs: AUTO_STOP_SILENCE_MS, wordCount: N })).toBe(true)
  })
  it('⭐⭐ 回归②：下限必须【跟着词数走】，不能是固定毫秒', () => {
    const long = 20
    const short = 3
    // ⭐ 同样说了 1500ms：短句够 ✓，长句不够 ✗
    expect(autoStopAfter({ voicedMs: 1500, silentMs: AUTO_STOP_SILENCE_MS, wordCount: short })).toBe(true)
    expect(autoStopAfter({ voicedMs: 1500, silentMs: AUTO_STOP_SILENCE_MS, wordCount: long })).toBe(false)
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
    expect(autoStopAfter({ ...st, wordCount: 11 })).toBe(false)
  })

  it('⭐ 正常读完：说够了时长 + 静音 1.2 秒 ⇒ 结束', () => {
    let st = VAD_STATE_ZERO
    for (let i = 0; i < 40; i++) st = advanceVad(st, 'voice', F) // 6.8s 说话
    // ⚠️ 静音帧数按常量推（⭐ 别写死 8 ✗ —— 阈值从 1200 提到 1500 时它会悄悄失效 ✓）
    const silentFrames = Math.ceil(AUTO_STOP_SILENCE_MS / F) + 1
    for (let i = 0; i < silentFrames; i++) st = advanceVad(st, 'silence', F)
    expect(autoStopAfter({ ...st, wordCount: 11 })).toBe(true)
  })
})
