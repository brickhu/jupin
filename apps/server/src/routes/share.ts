import { Hono } from 'hono'
import { eq } from 'drizzle-orm'

import { db } from '../db'
import { submissions, users } from '../db/schema'
import { playbackRefOf } from '../services/recording'
import { describe } from '../services/submission-view'
import { getTotalConquered } from '../services/conquest'
import { challengeStats } from '../services/submission'
import { readGrowth } from '../services/growth'
import { readStreakView } from '../services/streak'
import { readEnergy } from '../services/energy'

export const shareRoutes = new Hono()

/**
 * ⭐ 分享出去的「一次挑战结果」 —— **不需要登录**。
 *
 * ⚠️⚠️ 它和 /api/submissions/:id 的区别只有两点：
 *    ① 不鉴权（拿到链接的人可能根本没账号、也没读过这句）；
 *    ② 名次与榜单按**这条记录的拥有者**算 —— 分享页看的是「他排第几」，
 *       而不是「你排第几」。
 *    除此之外结果包**完全同构**（同一个 describe()），所以两屏能共用一套渲染。
 *
 * ⚠️ 隐私边界（想清楚再改）：
 *    · 链接本身就是凭据：sid 是 24 位十六进制（hash 出来的），猜不到；
 *      拿到链接 = 被分享，所以分数/分项/逐词/榜单可以给。
 *    · 但**录音**是另一回事 —— 它只在这条提交 `is_public` 时才给地址。
 *      成绩永远进榜、音频可见性是单独一个开关（见 schema 里的说明）。
 *    · 昵称/头像也只给这条挑战的拥有者那一个（榜单里本来就带昵称）。
 *
 * ⛔ 不要为了「省一次查询」把它挂到 /api 下面 —— 那条路径上全是鉴权中间件。
 */
shareRoutes.get('/challenge/:sid', async (c) => {
  const sid = c.req.param('sid')
  // ⚠️ 先按形状挡一道：不是 24 位十六进制就不是提交 id，别去查库
  if (!/^[0-9a-f]{24}$/.test(sid)) {
    return c.json({ ok: false, error: '这条挑战不存在' }, 404)
  }

  const [row] = await db
    .select({
      userId: submissions.userId,
      isPublic: submissions.isPublic,
      audioKey: submissions.audioKey,
      createdAt: submissions.createdAt,
      scoredAt: submissions.scoredAt,
    })
    .from(submissions)
    .where(eq(submissions.id, sid))
    .limit(1)
  if (!row) return c.json({ ok: false, error: '这条挑战不存在' }, 404)

  const status = await describe(row.userId, sid)
  if (!status || status.status !== 'scored' || !status.result) {
    return c.json({ ok: false, error: '这条挑战还没有成绩' }, 404)
  }

  const [owner] = await db
    .select({ nickname: users.nickname, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1)

  return c.json({
    ok: true,
    data: {
      result: status.result,
      owner: {
        nickname: (owner?.nickname ?? '').trim() || '挑战者',
        avatarUrl: owner?.avatarUrl ?? null,
      },
      // ⚠️ 只有公开的录音才给播放地址（见上面那段隐私边界）
      audio: row.isPublic ? await playbackRefOf(sid, row.audioKey) : null,
      at: (row.scoredAt ?? row.createdAt).toISOString(),
    },
  })
})

/**
 * ⭐⭐ 「个人主页」—— 按**用户 id** 取一份，**不需要登录**。
 *
 * ⚠️⚠️ 它对**所有人**都长一样，包括我自己：一份数据、一套渲染。
 *    链接就是这一页的地址（/pages/profile/profile?u=<id>），
 *    转发出去谁打开看到的都是同一个人的主页 —— 不分「本人 / 访客」。
 *
 * ⚠️ 代价讲清楚：这一份是**公开数据**。加字段前先问一句
 *    「它值不值得给陌生人看」；账号状态 / openid 这些与主页无关的一律不给。
 *
 * ⚠️ 被禁用的账号一律 404（不是 403）：不该告诉陌生人「这里有个人被封了」。
 */
shareRoutes.get('/profile/:id', async (c) => {
  const id = Number(c.req.param('id'))
  // ⚠️ 先按形状挡一道：不是正整数就别去查库
  if (!Number.isInteger(id) || id <= 0) {
    return c.json({ ok: false, error: '这个主页不存在' }, 404)
  }

  const [u] = await db
    .select({
      id: users.id,
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, id))
    .limit(1)
  if (!u || u.status !== 'normal') {
    return c.json({ ok: false, error: '这个主页不存在' }, 404)
  }

  /**
   * ⚠️ 与 /api/user/me 是**同一批事实、同一个算法**，否则同一个人在两个页面两个数：
   *    · 连续天数取**现算的视图**（不是 users.streak_days 那一列 —— 它要等下一次
   *      提交才会变小，拿它显示会出现「主页说连续 9 天、其实早就断了」）
   *    · 能量同样**先补足再读**（readEnergy，惰性 + 幂等）
   */
  const [conqueredCount, stats, growth, streak, energy] = await Promise.all([
    getTotalConquered(u.id),
    challengeStats(u.id),
    readGrowth(u.id),
    readStreakView(u.id),
    readEnergy(u.id),
  ])

  return c.json({
    ok: true,
    data: {
      id: u.id,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      energy,
      unfreezeCards: streak.unfreezeCards,
      streakDays: streak.streakDays,
      conqueredCount,
      challengedRounds: stats.challengedRounds,
      growth,
    },
  })
})
