import type { Difficulty } from '../constants/index'

/**
 * 引擎输出的词级结果。
 * ⚠️ 与内容的 ArticleWord 是两回事：
 *   WordScore = **运行时的评分结果**（这次这个词读得怎么样）
 *   ArticleWord = **内容侧的词级数据**（音标 / 释义 / 示范音频）
 * 客户端按 position 把两者拼起来渲染。
 */
export interface WordScore {
  word: string
  score: number
  dp: 'normal' | 'omission' | 'insertion' | 'repetition' | 'mispronunciation'
  startMs: number
  endMs: number
}

/** 统一响应包装 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code?: string }

/* ---------- 提交检测（核心） ---------- */

export interface SubmitRequest {
  articleId: number
  /** 音频在对象存储里的 key：audio/{articleId}/{userId}/{ts}.pcm */
  audioKey: string
}

export interface SubmitResponse {
  /** 云端权威分 0–100 */
  score: number
  rank: number
  participantCount: number
  /** 距上一名还差多少分；null 表示已是第一 */
  gapToPrev: number | null
  /** 击败人数（= participantCount - rank） */
  beatenCount: number
  isPersonalBest: boolean
  isConquered: boolean
  /** 上一次成绩，用于「🎉 62 → 87」 */
  previousBest: number | null
  /** 下次免费提交时间（滚动冷却） */
  nextFreeAt: string
  /** 榜单中心 5 条 */
  leaderboard: LeaderboardRow[]
  /** 词级结果（可选增强；缺失时端侧兜底） */
  words?: WordScore[]
}

export interface LeaderboardRow {
  rank: number
  nickname: string
  score: number
  isMe: boolean
}

/* ---------- 其他 ---------- */

export interface TokenResponse {
  token: string
  user: { id: number; nickname: string | null }
}

export interface MyStats {
  conqueredCount: number
  /** 各难度已征服数量 */
  conqueredByDifficulty: Record<Difficulty, number>
  nextFreeAt: string
  isMember: boolean
}

export interface CooldownError {
  code: 'COOLDOWN'
  nextFreeAt: string
}
