import type { Difficulty } from '../constants/index'

/** 用户 */
export interface User {
  id: number
  nickname: string | null
  avatarUrl: string | null
  /** 会员到期时间；null 表示非会员（冗余自 subscriptions） */
  memberUntil: string | null
  /** ⭐ 下次免费提交时间（滚动冷却） */
  nextFreeAt: string
  createdAt: string
}

/** 提交记录 —— 每次提交一条 */
export interface Submission {
  /** hash(userId, articleId, seq) */
  id: string
  userId: number
  articleId: number
  seq: number
  status: 'scored' | 'failed'
  score: number | null
  isConquered: boolean | null
  audioKey: string | null
  createdAt: string
}

/** 朗读单元索引（文章 = 句子，正文在静态 JSON 里） */
export interface Article {
  id: number
  contentJson: string
  tipsJson: string | null
  standardAudio: string | null
  difficulty: Difficulty
  category: string
  isActive: boolean
  participantCount: number
  conqueredCount: number
}
