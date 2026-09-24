import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { SUBMISSION_ID_LENGTH } from '@jushuo/shared'

import { db } from '../db'
import { submissions, users } from '../db/schema'
import { playbackRefOf } from '../services/recording'
import { describe } from '../services/submission-view'
import { getTotalConquered } from '../services/conquest'
import { challengeStats } from '../services/submission'
import { readGrowth } from '../services/growth'
import { readStreakView } from '../services/streak'
import type { Variables } from '../middleware/auth'

/** 提交 id 的形状 —— 从唯一的长度常量拼，不写死 {16} */
const RE_SUBMISSION_ID = new RegExp('^[0-9a-f]{' + SUBMISSION_ID_LENGTH + '}$')

/**
 * ⚠️ 这里必须带上 Variables 类型：Hono 的 c.get 需要它（否则 TS2769）。
 */
/** ⭐⭐ 公开页面两条路由 —— 分别挂在 /api/challenge 与 /api/profile。
 * ⚠️ 只给公开数据：「我的」那部分走 /api/user/* 下的鉴权接口，端侧按 id 融合。
 */
export const challengeRoutes = new Hono<{ Variables: Variables }>()
export const profileRoutes = new Hono<{ Variables: Variables }>()

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
 *    · **录音同样无条件给** —— 分享卡片就是用户的分享动作，链接即凭据。
 *      `is_public` 管的是「卡片之外的入口」给不给音频，那些入口自己判。
 *    · 昵称/头像也只给这条挑战的拥有者那一个（榜单里本来就带昵称）。
 *
 * ⛔ 不要为了「省一次查询」把它挂到 /api 下面 —— 那条路径上全是鉴权中间件。
 */
challengeRoutes.get('/:sid', async (c) => {
  const sid = c.req.param('sid')
  // ⚠️ 先按形状挡一道：不是 SUBMISSION_ID_LENGTH 位十六进制就不是提交 id，别去查库
  if (!RE_SUBMISSION_ID.test(sid)) {
    return c.json({ ok: false, error: '这条挑战不存在' }, 404)
  }

  const [row] = await db
    .select({
      userId: submissions.userId,
      audioKey: submissions.audioKey,
      createdAt: submissions.createdAt,
      scoredAt: submissions.scoredAt,
    })
    .from(submissions)
    .where(eq(submissions.id, sid))
    .limit(1)
  if (!row) return c.json({ ok: false, error: '这条挑战不存在' }, 404)

  // ⚠️ 开放接口：给结果 / 主人 / 录音。「是不是我的」由端侧拿 owner.id 比；
  //    「还没出分」的状态走 /api/user/submissions/:id（鉴权，只有本人拿得到）

  const [owner] = await db
    .select({ nickname: users.nickname, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, row.userId))
    .limit(1)
  const ownerView = {
    // ⭐ 端侧拿这个 id 跟自己的 id 比，判断「是不是本人」（标题 / 开关 / 按钮）
    id: row.userId,
    nickname: (owner?.nickname ?? '').trim() || '挑战者',
    avatarUrl: owner?.avatarUrl ?? null,
  }

  const status = await describe(row.userId, sid)

  /**
   * ⚠️⚠️ 未出分时**只有本人**拿得到状态，别人一律 404：
   *    公开链接不该暴露「这个 id 存在、但还没成绩」；
   *    而本人必须看得到「还在检测中」—— 那不是错误，是中间态。
   */
  // ⚠️ 没出分就 404（对所有人）：「这个 id 存在但还没成绩」不该从公开链接漏出去
  if (!status || status.status !== 'scored' || !status.result) {
    return c.json({ ok: false, error: '这条挑战不存在' }, 404)
  }

  return c.json({
    ok: true,
    data: {
      owner: ownerView,
      result: status.result,
      // ⭐ 录音**无条件给**：从挑战详情分享卡片（群聊 / 个人聊天 / 通知）进来的
      //    任何人都能听，不看 isPublic —— 链接即凭据（sid 是 24 位 hash）。
      //    isPublic 只决定「卡片之外的入口」给不给音频，那些入口自己判。
      audio: await playbackRefOf(sid, row.audioKey),
      at: (row.scoredAt ?? row.createdAt).toISOString(),
    },
  })
})

/**
 * ⭐ 单取一段录音的可播地址 —— 开放路径（与 /:sid 同一条口径：链接即凭据）。
 *
 * ⚠️ 为什么单独一个端点：「我的挑战」列表是**按需**取地址的 ——
 *    地址单独授权、会过期，几十条一次性全取等于让「打开列表」变成一次批量探测；
 *    而它又不需要整个结果包（列表已经有成绩了）。
 *    结果页反过来：它拿的是 /:sid 里那一份，不用再调这里。
 * ⚠️ 不判 isPublic、不校验归属 —— 理由见上面那条路由的隐私说明。
 */
challengeRoutes.get('/:sid/audio', async (c) => {
  const sid = c.req.param('sid')
  // ⚠️ 先按形状挡一道：不是 SUBMISSION_ID_LENGTH 位十六进制就不是提交 id，别去查库
  if (!RE_SUBMISSION_ID.test(sid)) {
    return c.json({ ok: false, error: '录音不存在' }, 404)
  }

  const [row] = await db
    .select({ audioKey: submissions.audioKey })
    .from(submissions)
    .where(eq(submissions.id, sid))
    .limit(1)
  if (!row?.audioKey) return c.json({ ok: false, error: '录音不存在' }, 404)

  return c.json({ ok: true, data: { audio: await playbackRefOf(sid, row.audioKey) } })
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
profileRoutes.get('/:id', async (c) => {
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
  /**
   * ⭐⭐ 「谁在看」只决定**哪些模块给**，不决定数据本身：
   *    · 成绩（连续天数 / 参与场次 / 挑战回合 / 成长值）→ 给所有人
   *    · 能量 / 解冻卡 → **只给本人**：那是账号余额，不是主页该给别人看的东西
   *      （所以对别人连读都不读，而不是「读了再藏起来」）
   */
  // ⚠️ 公开接口：只给公开成绩。能量 / 解冻卡是账号余额，走 /api/user/*（端侧融合）

  const [conqueredCount, stats, growth, streak] = await Promise.all([
    getTotalConquered(u.id),
    challengeStats(u.id),
    readGrowth(u.id),
    readStreakView(u.id),
  ])

  return c.json({
    ok: true,
    data: {
      id: u.id,
      nickname: u.nickname,
      avatarUrl: u.avatarUrl,
      streakDays: streak.streakDays,
      conqueredCount,
      challengedRounds: stats.challengedRounds,
      growth,
    },
  })
})
