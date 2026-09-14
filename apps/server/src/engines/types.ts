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
}

export interface WordScore {
  word: string
  /** 0–100 */
  score: number
  /** 增漏信息：normal / omission(漏读) / insertion(增读) / repetition(回读) / mispronunciation(替换) */
  dp: 'normal' | 'omission' | 'insertion' | 'repetition' | 'mispronunciation'
  startMs: number
  endMs: number
}

export interface SentenceScore {
  text: string
  total: number
  accuracy: number
  fluency: number
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
