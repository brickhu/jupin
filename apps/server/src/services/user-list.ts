import { and, asc, count, countDistinct, desc, eq, inArray } from 'drizzle-orm'
import type { UserSummary } from '@jushuo/shared'

import { db } from '../db'
import { submissions, users } from '../db/schema'

/** 用户目录一次最多给几条 / 不给 limit 时给几条（用户 2026-09 定） */
export const MAX_USER_LIMIT = 100
export const DEFAULT_USER_LIMIT = 50

/** 排序：`joined` = 加入时间倒序（默认）；`energy` = 能量倒序 */
export type UserSort = 'joined' | 'energy'

/**
 * ⭐⭐ **用户目录**（`GET /api/users`）—— 通用查询，回答「有哪些用户、各自什么水平」。
 *
 * ⚠️ 只列 `status='normal'`：banned / deleted 不该出现在目录里
 *    （与 `/api/profile/:id` 对被封账号一律 404 是同一条隐私口径）。
 *
 * ⚠️⚠️ 它**公开、且含 energy** —— 用户 2026-09 明确要求（"这个公开，含 energy"）。
 *    这**不改变**「能量只给本人」那条边界：`/api/profile/:id` 与 `/api/user/me`
 *    照旧不给别人的能量。别拿这一条当先例（见 shared 的 UserSummary 注释）。
 *
 * ⚠️⚠️ **两查一页，不做 N+1**（用户 2026-09 就是为了性能才要的这张目录）：
 *    ① `users` 一行拿齐 id / 昵称 / 头像 / 能量 / 加入时间 / 成长值 / 连战天数（都在这张表上）；
 *    ② 一条 `GROUP BY user_id` 的聚合拿齐这一页所有人的**参与次数**与**挑战回合**。
 *    ⇒ 别退化成"每行再查一次 challengeStats / readGrowth"（50 行就是 100+ 次查询）。
 *
 * ⚠️ 两种排序各有一条索引（见 db/schema.ts 的 users 索引块），
 *    没有它们就是全表扫 + filesort。⚠️ 别去掉 `orderBy` 里的第二列：
 *    并列没有确定次序时，同分的人在两次请求之间会换位置。
 */
export async function listUsers(opts: { sort: UserSort; limit: number }): Promise<UserSummary[]> {
  const rows = await db
    .select({
      id: users.id,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      energy: users.energy,
      createdAt: users.createdAt,
      // ⭐ 这四个数就在 users 这一行上，跟着主查询一起拿，不额外查库
      streakDays: users.streakDays,
      growthSelf: users.growthSelf,
      growthDiligence: users.growthDiligence,
      growthStandout: users.growthStandout,
    })
    .from(users)
    .where(eq(users.status, 'normal'))
    .orderBy(
      // ⚠️ 与索引一一对应（users_created_at_idx / users_energy_idx）：
      //    joined  → (created_at DESC, id DESC)：升序索引倒着扫
      //    energy  → (energy DESC, id ASC)：降序索引
      ...(opts.sort === 'energy'
        ? [desc(users.energy), asc(users.id)]
        : [desc(users.createdAt), desc(users.id)]),
    )
    .limit(opts.limit)

  const ids = rows.map((r) => r.id)

  /**
   * ② 这一页所有人的参与次数 / 挑战回合 —— **一条**聚合，不是每行一次。
   *
   * ⚠️ 口径与 `challengeStats()` **完全一致**（所以和 `/api/profile` 的数对得上）：
   *    · `status='scored'`（拿到分才算）；
   *    · 参与次数 = `COUNT(DISTINCT article_id)`（**一句 = 一场**，同句读 5 次仍算 1）；
   *    · 挑战回合 = `COUNT(*)`（一次提交 = 一回）。
   */
  const stats =
    ids.length === 0
      ? []
      : await db
          .select({
            userId: submissions.userId,
            rounds: count(),
            sentences: countDistinct(submissions.articleId),
          })
          .from(submissions)
          .where(and(inArray(submissions.userId, ids), eq(submissions.status, 'scored')))
          .groupBy(submissions.userId)

  const byUser = new Map(stats.map((s) => [s.userId, s]))

  return rows.map((r) => {
    const st = byUser.get(r.id)
    return {
      id: r.id,
      nickname: r.nickname,
      avatarUrl: r.avatarUrl,
      energy: Number(r.energy),
      createdAt: r.createdAt.toISOString(),
      conqueredCount: Number(st?.sentences ?? 0),
      challengedRounds: Number(st?.rounds ?? 0),
      streakDays: Number(r.streakDays ?? 0),
      growth: {
        self: Number(r.growthSelf ?? 0),
        diligence: Number(r.growthDiligence ?? 0),
        standout: Number(r.growthStandout ?? 0),
      },
    }
  })
}
