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
  // ⚠️ 这里**没有**日期字段，而且是刻意的：
  //    句子是可复用的内容，排期是「哪一天读哪一句」，是另一个实体（schedules 表）。
  //    把日期挂在句子上，等于让内容携带一个只能有一次的排期 ——
  //    同一句排第二次就会撞唯一键，而池子只有几句、按天轮转，那是不可能的。
  isActive: boolean
  participantCount: number
  conqueredCount: number
}
