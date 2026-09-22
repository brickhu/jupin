import { asc, desc, gt } from 'drizzle-orm'
import type { GrowthRankResponse, GrowthRankRow } from '@jushuo/shared'

import { db } from '../db'
import { users } from '../db/schema'

/**
 * ⭐ 三个成长指标各自的 TOP N（首页那三块榜）。
 *
 * ⚠️ 口径与用户面板里的三个数**完全一致**：直接读 users.growth_*（累加值）。
 *    不从 submissions 现算 —— 那既慢，又会出现「榜上的数和面板里的数不一样」这种
 *    没法解释的差（累加值本身就是唯一真相，见 db/schema.ts）。
 *
 * ⚠️ 只列 **> 0** 的人：0 表示「还没攒下任何一点」，
 *    把他们也列进来会让榜的前十名全是 0（新库尤其明显）。
 * ⚠️ 并列时按 id 升序 —— 先来的在前。
 *    不给个次序的话，同样的分数在两次请求之间会换位置（MySQL 不保证稳定顺序）。
 * ⚠️ 昵称沿用竞技场榜单那套：没起过名字显示「挑战者」，我自己显示「你」
 *    （见 services/leaderboard.ts 的 getTopLeaderboard）。
 */

/** 每块榜取几个 */
const TOP_N = 10

/** 三个成长列的类型（都是 int notNull，所以能共用这一个 helper） */
type GrowthColumn =
  | typeof users.growthSelf
  | typeof users.growthDiligence
  | typeof users.growthStandout

async function topOf(column: GrowthColumn, userId: number): Promise<GrowthRankRow[]> {
  const rows = await db
    .select({ userId: users.id, value: column, nickname: users.nickname })
    .from(users)
    .where(gt(column, 0))
    .orderBy(desc(column), asc(users.id))
    .limit(TOP_N)

  return rows.map((row, i) => ({
    rank: i + 1,
    nickname: row.userId === userId ? '你' : (row.nickname ?? '挑战者'),
    value: Number(row.value),
    isMe: row.userId === userId,
  }))
}

export async function topGrowthBoards(userId: number): Promise<GrowthRankResponse> {
  const [self, diligence, standout] = await Promise.all([
    topOf(users.growthSelf, userId),
    topOf(users.growthDiligence, userId),
    topOf(users.growthStandout, userId),
  ])
  return { self, diligence, standout }
}
