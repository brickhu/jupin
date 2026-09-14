/**
 * 核心常量。
 * ⚠️ 所有阈值只在这里定义一处，前后端共用，不允许多处硬编码。
 */

/** 征服阈值：竞技场得分 ≥ 此值即「征服」，永久保留 */
export const CONQUEST_THRESHOLD = 85

/** 免费提交的滚动冷却时长（毫秒）
 *  ⚠️ 滚动冷却 = last_submit_at + 此值，不是自然日重置 */
export const FREE_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** 每日无效提交上限（超过则当天暂停提交） */
export const MAX_INVALID_PER_DAY = 3

/** 难度星级 */
export const STARS = [1, 2, 3, 4, 5] as const
export type Stars = (typeof STARS)[number]

/** 本地预检阈值 —— 一律极度宽松：放行垃圾的成本极低，误伤用户的成本是流失 */
export const PREFLIGHT = {
  /** 录音最短时长（毫秒）—— 低于此值判定为技术无效 */
  minDurationMs: 1500,
  /** 英语正常朗读语速（词/分钟），用于估算预期语音时长 */
  wpm: 150,
  /** 有效语音时长 / 预期时长 的最低比例 —— 低于此值判定为「没读完」 */
  minSpeechRatio: 0.5,
} as const

/** 单词发音时间估算（毫秒/词） */
export const MS_PER_WORD = 60_000 / PREFLIGHT.wpm

/** 单次评测的音频格式要求（讯飞 ISE 硬要求，不符会被判「乱读」） */
export const AUDIO_SPEC = {
  sampleRate: 16_000,
  bitDepth: 16,
  channels: 1,
  /**
   * ⚠️ 传给 `RecorderManager.start({ frameSize })` 的值，**单位 KB，必须是整数**。
   *    官方限制：frameSize「暂仅支持 mp3、pcm 格式」，我们用的是 PCM。
   *
   * 选 2 KB 而非 1 KB 的原因：
   *   - 2 KB = 2048 字节 = 1024 采样 = 64ms @16k
   *   - YIN 基频检测在 70Hz 下限需要 ≥2 个周期（≈457 采样），512 采样太勉强
   *   - 64ms 对 VAD 与进度追踪仍足够细
   */
  frameSizeKb: 2,
  /** 每帧字节数（2 KB = 2048） */
  frameBytes: 2048,
  /** 每帧采样数（1024 = 2048 字节 ÷ 2） */
  frameSamples: 1024,
  /** 每帧时长（毫秒）= 1024 / 16000 × 1000 */
  frameMs: 64,
} as const

/** 计费与定价 */
export const PRICING = {
  monthly: 19.9,
  yearly: 199.9,
} as const
