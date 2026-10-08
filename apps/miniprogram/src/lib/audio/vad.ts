/**
 * ⭐⭐ **静音检测与"读完自动结束"的判据**（2026-10 定）。
 *
 * ## 为什么要有它
 *
 * 录音交互从「按住朗读」改回「**点一下开始、再点一下结束**」（用户 2026-10 定）——
 * 于是"什么时候算读完"必须由程序判断：用户点一下就开始说话，读完不用再去点结束 ✓
 *
 * ## ⚠️⚠️ 判据为什么是**两个条件**，不是单个静音
 *
 * 只判静音的话，**读到一半的停顿**会被当成读完 ✗ —— 那是最难受的失败方式：
 * 用户还在想下一个词，录音已经被掐断了。
 * ⇒ 所以还要一个"**时长下限**"：先把该说的时间说够，再等静音。
 *
 *     recordedMs ≥ expectedMs × 1.2   **且**   silentMs ≥ 1.2s
 *
 * ⭐ `expectedMs` 用**标准音的时长**（每一句都有，standardAudioMs）——
 *    它是逐句的、真实的参考语速 ✓ 比"按词数估"准得多。
 *
 * ## ⚠️ 阈值需要在真机上标定
 *
 * `SILENCE_RMS` 是我按常识取的保守值（**没有真机数据**）。
 * 环境噪音大的地方会偏小、录音增益低的设备会偏大 —— 两边的症状不同：
 *   · 阈值太低 ⇒ 环境噪音被当成"有人在说话" ⇒ **永远不自动结束** ✗（可接受：用户手动点）
 *   · 阈值太高 ⇒ 说话间隙被当成静音 ⇒ **提前掐断** ✗✗（不可接受）
 * ⇒ 所以取值**偏保守**（宁可判成"还在说"）✓
 */

/**
 * 一帧算不算静音：看**均方根**（RMS）。
 *
 * ⚠️ 用 RMS 而不是"峰值"：峰值对一两个爆音极其敏感，而说话间隙里的
 *    呼吸、唇齿声都会有峰值 —— 用峰值判会让静音永远不成立 ✗
 */
export const SILENCE_RMS = 0.02

/** ⭐ 连续静音多久才算"读完了" */
export const AUTO_STOP_SILENCE_MS = 1200

/**
 * ⭐ 录到的时长至少要达到标准音时长的多少倍，才允许自动结束。
 *
 * ⚠️ 1.2 是"比参考语速慢两成" —— 正常朗读落在 0.9~1.2 之间 ✓
 *    比这还慢的人会被这个下限保住（不会因为说得慢就被判成停）✓
 */
export const AUTO_STOP_MIN_RATIO = 1.2

/**
 * ⭐⭐ 一帧属于哪一种 —— **刻意做成三态而不是布尔**。
 *
 * ⚠️⚠️ 为什么不能只有"静音 / 不静音"两种 ✗：
 *    解码失败（`decodeFrameToSamples` 给 null）时，如果按"静音"算，
 *    在不支持解码的环境里会**连着一路攒静音** ⇒ 一秒多之后**把录音掐断** ✗✗
 *    （而那个环境恰恰是开发者工具 —— 正在调这个功能的那个 ✓）
 *    ⇒ 'undecodable' 是**独立的第三种**，调用方必须为它写一条分支 ✓
 *      （TypeScript 会逼着写 ✓）
 */
export type ChunkKind = 'voice' | 'silence' | 'undecodable'

/**
 * 判一帧属于哪一种：看**均方根**（RMS）。
 *
 * ⚠️ 用 RMS 而不是"峰值"：峰值对一两个爆音极其敏感，而说话间隙里的
 *    呼吸、唇齿声都会有峰值 —— 用峰值判会让静音永远不成立 ✗
 * ⚠️ 空数组也算 'undecodable'（不是"静音"）：解出来什么都没有，说明这一帧没用上 ✓
 */
export function classifyChunk(samples: Float32Array | null, rmsThreshold = SILENCE_RMS): ChunkKind {
  if (!samples || samples.length === 0) return 'undecodable'

  let sum = 0
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] ?? 0
    sum += v * v
  }
  return Math.sqrt(sum / samples.length) < rmsThreshold ? 'silence' : 'voice'
}

/** 逐帧累计的两个计数器（自动结束看的就是它们） */
export interface VadState {
  /** 已经录了多久 */
  recordedMs: number
  /** 当前**连续**静音了多久（有声音时清零） */
  silentMs: number
}

export const VAD_STATE_ZERO: VadState = { recordedMs: 0, silentMs: 0 }

/**
 * ⭐ 吃进一帧，吐出新的计数器 —— 纯函数，好测，也好让调用方一眼看出规则。
 *
 * ⚠️⚠️ **'undecodable' 时 `silentMs` 必须清零**，而不是保持原值更不是累加 ✗：
 *    解不出来的意思是"**我们不知道**他在不在说话" ⇒ 只能往**安全**的方向倒 ——
 *    当成"他在说话" ⇒ 永远不自动结束 ✓（用户还能手动点结束 ✓）
 *    ⚠️ 反过来（当成静音）就会在不支持解码的环境里**提前掐断** ✗✗，
 *      而那正是最不能接受的失败方式（用户还在读，录音没了 ✓）
 *
 * ⚠️ `recordedMs` **任何一帧都要加**（时间真的过去了 ✓）——
 *    不然"时长下限"这个条件在不支持解码的环境里永远不成立 ✓
 */
export function advanceVad(state: VadState, kind: ChunkKind, frameMs: number): VadState {
  return {
    recordedMs: state.recordedMs + frameMs,
    // ⚠️ 只有**确认为静音**才累加；'voice' 与 'undecodable' 都清零
    silentMs: kind === 'silence' ? state.silentMs + frameMs : 0,
  }
}

/**
 * ⭐⭐ **这一帧之后，该不该自动结束录音**（= 判断"读完了"）。
 *
 * @param recordedMs 已经录了多久（调用方按帧累计，见 frameSizeKb 的说明：1KB ≈ 170ms）
 * @param silentMs   当前**连续**静音了多久（有声音时会被调用方清零）
 * @param expectedMs 这一句的标准音时长；**拿不到时传 null**
 *
 * ⚠️⚠️ `expectedMs` 为 null（这一句没有标准音）时**一律不自动结束** ✗：
 *    没有一个可信的时长下限，就只能靠用户自己点结束 ——
 *    硬用一个默认值会在长句上提前掐断 ✗
 */
export function autoStopAfter(input: {
  recordedMs: number
  silentMs: number
  expectedMs: number | null
}): boolean {
  if (input.expectedMs === null || input.expectedMs <= 0) return false
  if (input.recordedMs < input.expectedMs * AUTO_STOP_MIN_RATIO) return false
  return input.silentMs >= AUTO_STOP_SILENCE_MS
}
