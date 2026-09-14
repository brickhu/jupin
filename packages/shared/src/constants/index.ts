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
  /** 每帧采样数（40ms @16k） */
  frameSamples: 640,
  /** 每帧字节数（1280B = 640 samples × 2 bytes） */
  frameBytes: 1280,
} as const

/** 计费与定价 */
export const PRICING = {
  monthly: 19.9,
  yearly: 199.9,
} as const
