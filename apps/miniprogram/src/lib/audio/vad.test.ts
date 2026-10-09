import { describe, expect, it } from 'vitest'

import {
  AUTO_STOP_MIN_RATIO,
  AUTO_STOP_WORD_MS,
  AUTO_STOP_SILENCE_MS,
  SILENCE_RMS_FLOOR,
  VAD_STATE_ZERO,
  advancePeakRms,
  advanceVad,
  autoStopAfter,
  classifyChunk,
  rmsOf,
  silenceThresholdOf,
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

  it('⚠️⚠️ 解不出来 ⇒ 时长照涨，且**按"他在说话"算**，连续静音清零', () => {
    /**
     * ⚠️⚠️ **这条断言 2026-10-10 改过** ✗ —— ⭐ 原来写的是 `voicedMs` **不变** ✓
     *
     *    ⚠️ 而测试名一直是「⭐ **当成"他在说话"**，绝不掐断」✗ ——
     *    ⚠️ **名字和断言是矛盾的** ✓
     *
     *    ⭐ 原来的口径（⭐ 不累加 `voicedMs`）有个致命后果 ✗：
     *       ⚠️ 只要有一部分帧解不开 ⇒ ⭐ **`voicedMs` 饿死** ⇒
     *       ⭐ **`voicedMs >= floor` 永远不成立 ⇒ 读完永不停** ✓✓
     *       ⚠️ 用户实测：⭐ **iOS 和 Android 两端都不行** ✗
     *    ⇒ ⭐ 现在按名字的意思实现：⭐ **解不开也当成他还在说** ✓✓
     *
     *    ⚠️ 为什么仍然安全（⭐ 见下面那条链式测试 ✓）：
     *       ⭐ `'undecodable'` **同时清零 `silentMs`** ✓
     *       ⇒ ⭐ 而 `autoStopAfter` 必须 `silentMs >= 1500` ✓
     *       ⇒ ⭐ **全是解不开的帧时，`silentMs` 永远是 0 ⇒ 绝不自动结束** ✓✓
     */
    const s = advanceVad({ recordedMs: 1000, silentMs: 9999, voicedMs: 300 }, 'undecodable', F)
    expect(s).toEqual({ recordedMs: 1000 + F, silentMs: 0, voicedMs: 300 + F })
  })

  it('⭐⭐ 部分帧解不开（⭐ 真机的常态）⇒ voicedMs 照样涨 ⇒ 能自动结束', () => {
    /**
     * ⚠️⚠️ **这是用户报的那个 bug 的回归测试** ✗：
     *    ⭐ 真机上**总有一部分帧解不开**（⭐ 帧边界、解码失败 ✓）——
     *    ⚠️ 旧的"只有明确 voice 才累加"在那种情况下会让 `voicedMs` 饿死 ✓
     *    ⇒ ⭐ 读完永不停 ✓✓
     */
    let st = { ...VAD_STATE_ZERO }
    const N = 11
    const floor = N * AUTO_STOP_WORD_MS * AUTO_STOP_MIN_RATIO
    // ⭐ 每 3 帧里有 1 帧解不开，其余是"说话" —— 说话时长要够 floor
    const FRAMES = 40
    for (let i = 0; i < FRAMES; i++) {
      st = advanceVad(st, i % 3 === 2 ? 'undecodable' : 'voice', F)
    }
    // ⭐ 40 帧 × F：新口径下【两种都累加】⇒ 一帧不落
    expect(st.voicedMs).toBe(FRAMES * F)
    expect(st.voicedMs).toBeGreaterThan(floor)
    // ⭐ 安静下来 ⇒ 判读完
    for (let i = 0; i < 12; i++) st = advanceVad(st, 'silence', F)
    expect(autoStopAfter({ ...st, wordCount: N })).toBe(true)
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

/* ------------------------------------------------------------------ */
/* ⭐ 自适应静音阈值（2026-10-10 加）                                    */
/* ------------------------------------------------------------------ */

/**
 * ⚠️⚠️ **这一组守的是一个真机上坏掉的功能** ✗：
 *    固定阈值 `SILENCE_RMS = 0.02` 在**低增益设备**上会把每一帧都判成静音
 *    ⇒ `voicedMs` 永不增长 ⇒ **读完永不停**（用户实测报的 bug）。
 *    ⭐ 波形那条路早在 `b264419` 就因为同一个"幅度不够"加过增益，只有 VAD 漏了。
 *
 * ⚠️ 注意 `tone(a)` 造的是**正弦**，它的 RMS 是 `a / √2`（≈ 0.707a）——
 *    下面的期望值都按这个换算，别拿幅度当 RMS ✓
 */
describe('自适应静音阈值 —— 跟设备自己的峰值比，不跟绝对数字比', () => {
  it('峰值只涨不跌', () => {
    expect(advancePeakRms(0, 0.05)).toBe(0.05)
    expect(advancePeakRms(0.05, 0.02)).toBe(0.05)
    expect(advancePeakRms(0.05, 0.08)).toBe(0.08)
  })

  it('⭐ 增益低的设备也能分出「说话」与「安静」', () => {
    // ⚠️ 这台设备说话幅度只有 0.01（RMS ≈ 0.0071，远低于旧的固定阈值 0.02）
    const peak = advancePeakRms(0, rmsOf(tone(0.01)))
    const threshold = silenceThresholdOf(peak)
    // ⭐ 它自己的说话声必须判成 voice —— 这正是旧实现会判错的地方
    expect(classifyChunk(tone(0.01), threshold)).toBe('voice')
    // ⭐ 安静下来（幅度 0.001，RMS ≈ 0.0007）要判成 silence
    expect(classifyChunk(tone(0.001), threshold)).toBe('silence')
  })

  it('⭐ 峰值高的时候，正常说话不会被误判成静音', () => {
    const peak = advancePeakRms(0, rmsOf(tone(0.4)))
    const threshold = silenceThresholdOf(peak)
    expect(classifyChunk(tone(0.2), threshold)).toBe('voice')
    expect(classifyChunk(tone(0.02), threshold)).toBe('silence')
  })

  it('⚠️ 绝对下限兜住「安静环境里一点底噪就成了峰值」', () => {
    expect(silenceThresholdOf(0)).toBe(SILENCE_RMS_FLOOR)
    expect(silenceThresholdOf(0.001)).toBe(SILENCE_RMS_FLOOR)
    // ⭐ 全是底噪（幅度 0.003 ⇒ RMS 0.0021 < FLOOR）时算「安静」，不是「有人在说话」
    expect(classifyChunk(tone(0.003), silenceThresholdOf(0))).toBe('silence')
  })

  it('rmsOf：空 / null 给 0，正弦给约 a/√2', () => {
    expect(rmsOf(null)).toBe(0)
    expect(rmsOf(new Float32Array(0))).toBe(0)
    // ⚠️ 精度给 2 位：tone 造的是**离散**正弦（sin(i/4)），装不满整周期，
    //    实测 0.3551 而理论 0.3536 —— 差 0.4% 是离散化的正常误差，不是 bug
    expect(rmsOf(tone(0.5))).toBeCloseTo(0.5 / Math.SQRT2, 2)
  })

  it('⭐ 串起来：低增益设备说够了时长 + 安静下来 ⇒ 判「读完了」', () => {
    let peak = 0
    let vad = { ...VAD_STATE_ZERO }
    // ⭐ 30 帧 × 170ms = 5100ms 的「确认为语音」
    for (let i = 0; i < 30; i++) {
      peak = advancePeakRms(peak, rmsOf(tone(0.01)))
      vad = advanceVad(vad, classifyChunk(tone(0.01), silenceThresholdOf(peak)), 170)
    }
    expect(vad.voicedMs).toBeGreaterThan(6 * AUTO_STOP_WORD_MS * AUTO_STOP_MIN_RATIO)
    // ⭐ 再喂够静音
    for (let i = 0; i < 12; i++) {
      peak = advancePeakRms(peak, rmsOf(tone(0.0005)))
      vad = advanceVad(vad, classifyChunk(tone(0.0005), silenceThresholdOf(peak)), 170)
    }
    expect(vad.silentMs).toBeGreaterThanOrEqual(AUTO_STOP_SILENCE_MS)
    expect(autoStopAfter({ ...vad, wordCount: 6 })).toBe(true)
  })

  it('⚠️ 反面对照：仍用旧的固定阈值时，低增益设备永远判不出「语音」', () => {
    // ⭐ 这条钉住"为什么必须改"—— 旧实现下 voicedMs 一直是 0
    let vad = { ...VAD_STATE_ZERO }
    for (let i = 0; i < 30; i++) {
      vad = advanceVad(vad, classifyChunk(tone(0.01)), 170)
    }
    expect(vad.voicedMs).toBe(0)
    expect(autoStopAfter({ ...vad, wordCount: 6 })).toBe(false)
  })
})
