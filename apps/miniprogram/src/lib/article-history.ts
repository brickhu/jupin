import { formatScore } from '@jushuo/shared'
import type { ArticleRecordsResponse } from '@jushuo/shared'

import { agoText } from './time'

/**
 * ⭐⭐ 朗读页下方「历史挑战」—— **我在这一句上读过几次、每次多少分**。
 *
 * 这一屏和「我的挑战」列表（pages/me/challenges）长的不是一回事，别混：
 *   · 那边回答「我**所有**的挑战记录」，一行还要显示句子本身（一句话换一个页面就要重看）；
 *   · 这边回答「**这一句**我读过几次」，句子是同一句、说了也白说，
 *     所以一行只留三个信息：**第几次 · 什么时候 · 多少分**。
 *
 * ⚠️⚠️ **列表里不含「当前这一次」**（SPEC 已定口径）。
 *    用户此刻正看着 s5 那个大号分数，下面再列一条一模一样的，
 *    他会以为"怎么多了一次"。判据是**提交 id**，不是分数或时间：
 *    同一句重复提交、幂等命中同一条时，只有 id 认得出"这两处是同一次"。
 *    ⚠️ 这条规则在**恢复出来的 s5**（上次出分没点重新挑战就退出了）上同样成立 ——
 *      两种 s5 在界面上长得一模一样，用户分不出是哪一种，所以不该有两种列表。
 *
 * ⚠️ 分数只走 shared 的 formatScore（一位小数，`—` 是"没有分"）——
 *    朗读页大号分数、结果屏、我的挑战列表用的是**同一个**格式化，
 *    这里自己 toFixed 的话，同一次提交在两屏里会差一个 0.1。
 */

/** 列表里的一行（显示形态与接口字段分开：WXML 里不做计算） */
export interface HistoryRow {
  submissionId: string
  /** 这是这句上的第几次（服务端 `submissions.seq`，从 1 开始） */
  seq: number
  /** '89.5' —— 成品文本，WXML 只负责摆 */
  scoreText: string
  /** '刚刚' / '昨天 14:03' —— 北京时间、精确到分（见 lib/time.ts） */
  ago: string
  /** 是不是**目前**的最高分 —— 每行最多一个，用来标「最高」 */
  isBest: boolean
  /** 这次挑战记在哪一天（空串 = 老记录没有）—— 留着给"再挑战一次"用 */
  scheduleDate: string
}

/** 一次历史列表的成品：行 + 表头要用的两个数 */
export interface HistoryRows {
  rows: HistoryRow[]
  /** 除当前这一次之外还剩几次 */
  attempts: number
  /** 这些记录里的最高分（'89.5'）；一条都没有时是空串 */
  bestScoreText: string
}

/**
 * 把接口响应变成列表要的行。
 *
 * @param res           `GET /api/user/article-records` 的 data
 * @param excludeId     当前正看着的那一次提交（免掉它）；空串 = 没有要免的
 * @param now           只给单测用（相对时间要一个固定的"现在"）
 *
 * ⚠️ 最高分**在这批行里现算**，不直接用响应里的 `res.bestScore` ——
 *    那个数**包含**当前这一次（服务端算的是全部有分的记录），
 *    免掉当前这条之后，"最高"这件事可能就换人了。
 *    拿它去标「最高」会出现"一行都没标，而表头写着最高 89.5"。
 */
export function historyRowsOf(
  res: ArticleRecordsResponse,
  excludeId: string,
  now: number = Date.now(),
): HistoryRows {
  const items = res.items.filter((i) => i.submissionId !== excludeId)
  const best = items.length === 0 ? null : Math.max(...items.map((i) => i.score))
  return {
    rows: items.map((i) => ({
      submissionId: i.submissionId,
      seq: i.seq,
      scoreText: formatScore(i.score),
      ago: agoText(i.createdAt, now),
      // ⚠️ 并列最高时两行都标：这里要回答的是"哪些次是我的最好水平"，
      //    不是"哪一次是唯一的纪录"。
      isBest: best !== null && i.score === best,
      scheduleDate: i.scheduleDate ?? '',
    })),
    attempts: items.length,
    bestScoreText: best === null ? '' : formatScore(best),
  }
}
