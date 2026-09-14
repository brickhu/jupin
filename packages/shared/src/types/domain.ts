import type { Stars } from '../constants/index'

/** 用户 */
export interface User {
  id: number
  nickname: string | null
  avatarUrl: string | null
  /** 会员到期时间；null 表示非会员 */
  subscriptionEnd: string | null
  /** ⭐ 下次免费提交时间（滚动冷却） */
  nextFreeAt: string
  createdAt: string
}

/** 成绩 —— 一次「提交检测」的产物 */
export interface ArenaEntry {
  id: number
  arenaId: number
  userId: number
  /** 云端权威分 0–100 */
  score: number
  /** 该次是否刷新了个人记录 */
  isPersonalBest: boolean
  /** score >= CONQUEST_THRESHOLD */
  isConquered: boolean
  createdAt: string
}

/** 竞技场（竞技单位 = 句群） */
export interface Arena {
  id: number
  passageId: number
  content: string
  stars: Stars
  wordCount: number
  /** 预期语音时长（毫秒），用于本地预检第②层 */
  expectedSpeechMs: number
  participantCount: number
}
