import { eq } from 'drizzle-orm'
import type { ScoreDimensions, ScoreParts, StreakDelta, SubmitResponse, WordScore } from '@jushuo/shared'

import { db } from '../db'
import { articles, submissions } from '../db/schema'
import { loadArticleRefText } from './content'
import { getBestExcluding, getLeaderboardAround, getRank } from './leaderboard'
import type { SubmissionStatusResponse } from '@jushuo/shared'

/**
 * ⭐ 把一行提交翻译成客户端要的**结果包** —— 全站只有这一处。
 *
 * ⚠️⚠️ 为什么要抽成服务（原来它埋在 routes/submissions.ts 里）：
 *    现在有**两个**入口要给出同一份结果 ——
 *      · `GET /api/submissions/:id`（本人看自己的，要鉴权）；
 *      · `GET /api/challenge/:sid`（分享出去的链接，任何人可看）。
 *    两个入口各写一份的话，「本人看到的」和「分享出去看到的」迟早不一致 ——
 *    而分享页恰恰是最不能让两边打架的地方。
 *
 * ⚠️ 它会被**反复调用**（客户端每次轮询都调一次），所以每个字段都必须**幂等**：
 *    同样的数据永远给同样的答案。`isPersonalBest` 因此被定义成
 *    「比这篇文章里**其它**提交都高」，而不是「刚才写入时是不是新高」——
 *    后者每轮询一次就变一次，结果页的「个人最好」会忽有忽无。
 *
 * @param viewerUserId 名次/榜单**按谁**算。看自己的传自己；
 *        分享页必须传**拥有者**的 id（看的是「他排第几」，不是「你排第几」）。
 */
export async function describe(
  viewerUserId: number,
  submissionId: string,
): Promise<SubmissionStatusResponse | null> {
  const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
  if (!row) return null

  if (row.status === 'failed') {
    return {
      submissionId,
      status: 'failed',
      error: row.failReason ?? '这段录音检测失败，请重录',
    }
  }
  if (row.status !== 'scored' || row.score === null) {
    return { submissionId, status: 'scoring' }
  }

  // ⚠️ 排行与「上次最好成绩」都按 **articleId**（句子就是竞技场）——
  //    同一句会被排在很多天，那些天的参与者本来就该在同一张榜上。
  //    见 services/leaderboard.ts 的说明。
  const articleId = row.articleId
  const [rankInfo, leaderboard, previous, article] = await Promise.all([
    getRank(articleId, viewerUserId),
    getLeaderboardAround(articleId, viewerUserId),
    getBestExcluding(articleId, viewerUserId, submissionId),
    // ⭐ 参考原文：详情/分享页要拿它给逐词上色（见 SubmitResponse.text 的说明）
    db
      .select({ id: articles.id, theme: articles.theme })
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1),
  ])

  /**
   * ⚠️ score 这一列是 DECIMAL —— drizzle 读回来是**字符串**（见 schema 里的说明）。
   *    对外一律换成数字：客户端要拿它排序、显示、比大小，
   *    而 '78.3' > 9 这种字符串比较会给出"看起来对但其实错"的结果。
   */
  const scoreNum = Number(row.score)

  const result: SubmitResponse = {
    score: scoreNum,
    rank: rankInfo.rank,
    participantCount: rankInfo.participantCount,
    gapToPrev: rankInfo.gapToPrev,
    beatenCount: rankInfo.beatenCount,
    // ⚠️ 服务端认定的句子 —— 客户端用它当「我在这句上的战绩」的键。
    //    竞技数据跟着句子走，与日期无关（见 services/leaderboard.ts）。
    articleId,
    // ⚠️ 从库里读回来，不是写死 —— 用户可能在结果页改过（见 /visibility）
    isPublic: row.isPublic,
    // ⭐ 视觉主题（结果卡上色）；老内容 / 已删句子为 null ⇒ 端侧品牌色兜底
    theme: article[0]?.theme ?? null,
    isPersonalBest: previous === null || scoreNum > previous,
    // ⚠️ 攻克 =「这条出分了」（口径见 services/conquest.ts）。
    //    刻意**读 status 而不是 is_conquered 列**：老数据那一列是按已废除的
    //    85 分线写的，直接读会把历史成绩显示成「没攻克」。
    isConquered: row.status === 'scored',
    previousBest: previous,
    leaderboard,
    text: article[0] ? await loadArticleRefText(article[0].id) : '',
    // ⭐ 录音时长 —— 结果页在播放按钮旁边显示它（读完之后最直观的参照）
    ...(row.audioDurationMs ? { durationMs: row.audioDurationMs } : {}),
    // ⚠️ 老数据可能没有 scheduleDate（见 schema），那就干脆不给 —— 端侧退回今天
    ...(row.scheduleDate ? { scheduleDate: row.scheduleDate } : {}),
    words: row.wordScores ? (JSON.parse(row.wordScores) as WordScore[]) : undefined,
    // ⭐ AI 教练的输出（拿不到就是 undefined —— 没配大模型 / 那次调用失败）
    ...(row.aiComment ? { aiComment: row.aiComment } : {}),
    ...(row.aiAdvice ? { aiAdvice: row.aiAdvice } : {}),
    // ⭐ 分项明细 —— 结果屏的「评分详情」显示它，而不是引擎那四维
    ...(row.scoreParts ? { parts: JSON.parse(row.scoreParts) as ScoreParts } : {}),
    // ⚠️ 维度也必须从库里读回来，否则轮询取到的结果里四维会不见
    dimensions: row.dimensions ? (JSON.parse(row.dimensions) as ScoreDimensions) : undefined,
    streak: row.streakDelta ? (JSON.parse(row.streakDelta) as StreakDelta) : undefined,
  }
  return { submissionId, status: 'scored', result }
}