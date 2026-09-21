import type { ScoreDimensions } from '@jushuo/shared'

export type { ScoreDimensions }

/**
 * ⭐ 评分引擎接口 —— 全系统唯一与云端引擎的耦合点。
 *
 * 设计原则（AGENT.md 原则 1）：云端只买「一个分数」，其余全部端侧实现。
 *
 * 推论：
 *  - 换引擎 = 换一个实现，业务代码不动
 *  - 将来端侧模型可用时，直接替换 score() 的实现即可
 *  - 因此接口必须极薄：total 是唯一必需字段，其余都是可选增强
 */
export interface ScoreResult {
  /** ⭐ 唯一必需：0–100 的权威分 */
  total: number
  /** 可选副产品：词级数据。有则用于精修，无则端侧兜底 */
  words?: WordScore[]
  /** 可选副产品：分句级数据（竞技场是句群，可展示"哪句稳、哪句弱"） */
  sentences?: SentenceScore[]
  /**
   * 可选副产品：句级四维得分（准确度 / 流利度 / 标准度 / 完整度）。
   * ⭐ 这四个字段 ISE 本来就返回，我们只是以前没往外取 —— 零额外成本。
   */
  dimensions?: ScoreDimensions
  /**
   * ⭐ 音节级检错率（0–1）：读过多少音节、其中多少被标了读错。
   *
   * ⚠️ 依赖 extra_ability 里的 syll_phone_err_msg；引擎没返回音节时是 undefined
   *    （**不是 0** —— 0 的含义是「一个都没错」，两件事不能混）。
   */
  syllableErrorRate?: number
}

export interface WordScore {
  word: string
  /** 0–100 */
  score: number
  /** 增漏信息：normal / omission(漏读) / insertion(增读) / repetition(回读) / mispronunciation(替换) */
  dp: 'normal' | 'omission' | 'insertion' | 'repetition' | 'mispronunciation'
  startMs: number
  endMs: number
  /**
   * ⭐ 这个词里「明显读错」的音素（音标符号，如 dh / ih）。
   *
   * ⚠️ 判据是音素级 gwpp < -4 —— 实测读对的音素多在 -0.0x，读错时会掉到 -5 ~ -7。
   *    它是**定位器**：告诉用户「哪个音不行」，不参与算分。
   *    没有读错的音素时**整个字段不出现**（不是空数组）。
   */
  badPhones?: string[]
}

export interface SentenceScore {
  text: string
  total: number
  accuracy: number
  fluency: number
  standard: number
}

export interface ScoreOptions {
  /** 参考文本 */
  refText: string
  /** 音频：16k / 16bit / 单声道 PCM（无 WAV 头） */
  audio: Uint8Array
  /** 题型 */
  category?: 'read_sentence' | 'read_chapter'
}

export interface ScoreEngine {
  readonly name: string
  score(opts: ScoreOptions): Promise<ScoreResult>
}
