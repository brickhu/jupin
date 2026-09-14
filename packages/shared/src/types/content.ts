import type { Stars } from '../constants/index'

/**
 * CDN 静态资源结构。
 * ⚠️ 内容不走后端 API 查库，全部由 CDN 分发。
 */

/** 短文（内容单位） */
export interface PassageContent {
  id: number
  title: string
  content: string
  translation: string
  starsMin: Stars
  starsMax: Stars
  fullAudioUrl: string
  arenas: ArenaSummary[]
}

export interface ArenaSummary {
  id: number
  content: string
  stars: Stars
  participantCount: number
}

/** 竞技场完整内容 */
export interface ArenaContent {
  id: number
  passageId: number
  content: string
  stars: Stars
  audioUrl: string
  expectedSpeechMs: number
  words: ArenaWord[]
  tips: ReadingTip[]
}

/**
 * 词级数据。
 * ⚠️ startMs / endMs 来自 fish-audio 的词级时间戳，
 *    是「点词回放」与「逐词 A/B 对比」的基础设施。
 */
export interface ArenaWord {
  pos: number
  word: string
  /** 国际音标（来自 ECDICT） */
  ipa: string | null
  /** 词性 */
  posTag: string | null
  /** 该词在此语境下的中文释义 */
  meaningZh: string | null
  startMs: number
  endMs: number
  /** 预切的单词音频 ⭐ 精度优于运行时 seek() */
  audioUrl: string
}

export type TipType =
  | 'linking'          // 连读
  | 'weak_form'        // 弱读
  | 'stress'           // 重音
  | 'intonation'       // 语调
  | 'pause'            // 停顿
  | 'difficult_sound'  // 难音

/** 朗读技巧 —— 规则检测产出，LLM 只做润色 */
export interface ReadingTip {
  type: TipType
  /** 涉及的词区间，用于高亮 */
  wordStart: number
  wordEnd: number
  noteZh: string
  ipa?: string
  /** 针对性示范音频区间 ⭐ 用词级时间戳切出 */
  audioStartMs: number
  audioEndMs: number
}
