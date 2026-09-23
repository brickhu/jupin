import { and, eq, ne, sql } from 'drizzle-orm'
import { diligenceOf, selfSurpassOf, standoutOf, type GrowthView } from '@jushuo/shared'

import { db } from '../db'
import { submissions, users } from '../db/schema'

/**
 * ⭐ 成长值的**取数与计算** —— 纯计算在 @jushuo/shared/growth.ts，
 * 这里只负责把那三个「提交那一刻的历史」查出来。
 *
 * ⚠️⚠️ 三样东西**都必须排除本次提交**：结算发生在分数已经落库之后，
 *    不排除的话，「最高分」就是它自己、榜单里也会多出自己这一条 ——
 *    结果永远算成「没超越」。
 *
 * ⚠️⚠️ 全都要**现查**，不能事后重算 —— 这也是为什么结果必须落快照
 *    （见 docs/design/growth-and-energy.md 1.5）。
 */

const MAX_SCORE = sql<number | null>`MAX(${submissions.score})`

/** 我在这句上的历史最高分（本次之前）—— 句子级自我超越的基准 */
export async function highestInSentence(
  userId: number,
  articleId: number,
  excludeSubmissionId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ best: MAX_SCORE })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.articleId, articleId),
        eq(submissions.status, 'scored'),
        ne(submissions.id, excludeSubmissionId),
      ),
    )
  return row?.best === null || row?.best === undefined ? null : Number(row.best)
}

/** 我的个人全站历史最高分（本次之前）—— 用户级自我超越的基准 */
export async function highestInUser(
  userId: number,
  excludeSubmissionId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ best: MAX_SCORE })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.status, 'scored'),
        ne(submissions.id, excludeSubmissionId),
      ),
    )
  return row?.best === null || row?.best === undefined ? null : Number(row.best)
}

/**
 * ⭐ 该场的**榜单分数快照** —— 每个参与者取历史最高分、**一人一条**。
 *
 * ⚠️ 与榜单（services/leaderboard.ts 的 bestPerUser）**同一个口径**：
 *    用户能自己对着榜单核对自己的位置。这不是巧合，是刻意复用同一条规则。
 * ⚠️ 用户可能在同一句挑战 100 轮，但**只有最高分那一次上榜** ——
 *    不这么算的话，一个人反复读就能把权重 w 顶到 1.2、把中位数拉低（等于替别人刷分）。
 */
export async function arenaSnapshot(
  articleId: number,
  excludeSubmissionId: string,
): Promise<number[]> {
  const rows = await db
    .select({ best: MAX_SCORE })
    .from(submissions)
    .where(
      and(
        eq(submissions.articleId, articleId),
        eq(submissions.status, 'scored'),
        ne(submissions.id, excludeSubmissionId),
      ),
    )
    .groupBy(submissions.userId)

  return rows
    .map((r) => (r.best === null || r.best === undefined ? Number.NaN : Number(r.best)))
    .filter((v) => Number.isFinite(v))
}

export interface GrowthComputation {
  self: number
  diligence: number
  standout: number
  /** 记账依据 —— 回看结果页要能回答「为什么是这些分」 */
  meta: Record<string, unknown>
}

/**
 * ⭐ 三个指标一起算。**纯函数级**的输入输出，方便单测与落快照。
 *
 * ⚠️ 坚持不懈用的是**跨档**（before/after），不是「现在到没到」——
 *    见 shared/growth.ts 里那段说明。
 * ⚠️ 只在**打分成功**时才走到这里：读不出来的录音不该给成长值
 *    （「我明明没读成功，怎么算我进步了」）。
 */
export function computeGrowth(input: {
  score: number
  highestInSentence: number | null
  highestInUser: number | null
  snapshot: number[]
  streakBefore: number
  streakAfter: number
}): GrowthComputation {
  const surpass = selfSurpassOf({
    score: input.score,
    highestInSentence: input.highestInSentence,
    highestInUser: input.highestInUser,
  })
  const diligence = diligenceOf(input.streakBefore, input.streakAfter)
  const standout = standoutOf(input.score, input.snapshot)

  return {
    self: surpass.total,
    diligence: diligence.points,
    standout: standout.total,
    meta: {
      // 自我超越
      highestInSentence: input.highestInSentence,
      highestInUser: input.highestInUser,
      n1: surpass.n1,
      n2: surpass.n2,
      // 坚持不懈
      streakBefore: input.streakBefore,
      streakAfter: input.streakAfter,
      crossed: diligence.crossed,
      // 人中翘楚
      sampleSize: standout.sampleSize,
      baseline: standout.baseline,
      weight: standout.weight,
    },
  }
}

/**
 * ⭐ 读三个成长值的**累计值**（展示用）。
 *
 * ⚠️ 与"每次提交的明细"分工不同：这里回答「我一共多少」，
 *    submissions 上的快照回答「这一次为什么是这些分」。
 */
export async function readGrowth(userId: number): Promise<GrowthView> {
  const [row] = await db
    .select({
      self: users.growthSelf,
      diligence: users.growthDiligence,
      standout: users.growthStandout,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)
  return { self: row?.self ?? 0, diligence: row?.diligence ?? 0, standout: row?.standout ?? 0 }
}
