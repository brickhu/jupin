import type { Difficulty } from '../constants/index'

/**
 * 内容静态资源结构。
 * ⚠️ 内容不走后端 API 查库，全部由 CDN 分发。
 *    articles.contentJson / tipsJson / standardAudio 分别指向下面的 JSON / MP3。
 */

/** 文章正文静态 JSON —— articles.contentJson 指向它 */
export interface ArticleContent {
  id: number
  /** 句子原文 —— 评分的参考文本 */
  text: string
  translation: string
  difficulty: Difficulty
  /** 词级数据（点词回放 / 逐词 A/B 的基础设施） */
  words: ArticleWord[],
}

/** 朗读技巧静态 JSON —— articles.tipsJson 指向它 */
export interface ArticleTips {
  tips: ReadingTip[],
}

export interface ArticleWord {
  pos: number
  word: string
  /** 国际音标（来自 ECDICT） */
  ipa: string | null
  /** 词性 */
  posTag: string | null
  /** 该词在此语境下的中文释义 */
  meaningZh: string | null,
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
