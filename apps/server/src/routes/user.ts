import { Hono } from 'hono'
import { and, count, desc, eq, max, min } from 'drizzle-orm'
import { db } from '../db'
import { articles, submissions, users } from '../db/schema'
import { env } from '../env'
import { loadArticleRefText } from '../services/content'
import { getTotalConquered } from '../services/conquest'
import { getRank } from '../services/leaderboard'
import { challengeStats } from '../services/submission'
import { readEnergy } from '../services/energy'
import { claimUnfreezeCards, unfreezeStatus, useUnfreezeCards } from '../services/unfreeze'
import { readStreakRecord } from '../services/streak-record'
import { readGrowth } from '../services/growth'
import { readStreakView } from '../services/streak'
import type { ChallengeWordScore } from '@jushuo/shared'
import type { Variables } from '../middleware/auth'

export const userRoutes = new Hono<{ Variables: Variables }>()

/**
 * ⭐ 「我的挑战」—— 这个用户**所有的挑战记录**，按时间倒序。
 *
 * ⚠️ 数据源就是 submissions：本站每一次读完都在里面（分数、分项、逐词、AI 点评）。
 *    **不要再建一张「挑战记录表」** —— 那是第二份真相，两边一定会不一致。
 * ⚠️ 一次给全量、不做分页：现在一个用户几十条，做游标分页纯属自找麻烦；
 *    等真的有人几百条了再加（那时加游标也不会破坏契约）。
 * ⚠️ 句子原文要一起返回：列表里只说「第 3 号文章 87.3 分」用户认不出是哪句，
 *    而客户端逐条去拉正文会是 N 次请求。
 */
userRoutes.get('/challenges', async (c) => {
  const userId = c.get('userId')

  const rows = await db
    .select({
      id: submissions.id,
      articleId: submissions.articleId,
      scheduleDate: submissions.scheduleDate,
      score: submissions.score,
      isConquered: submissions.isConquered,
      status: submissions.status,
      aiComment: submissions.aiComment,
      wordScores: submissions.wordScores,
      scoredAt: submissions.scoredAt,
      createdAt: submissions.createdAt,
      contentJson: articles.contentJson,
    })
    .from(submissions)
    .innerJoin(articles, eq(articles.id, submissions.articleId))
    .where(eq(submissions.userId, userId))
    .orderBy(desc(submissions.createdAt))

  const items = await Promise.all(
    rows.map(async (r) => {
      /**
       * ⚠️ 句子原文和逐词结果都要**按同一套切词**（空白切分）——
       *    列表那边是按下标把第 i 个词染成第 i 个颜色，
       *    两边切法不一致就会整行错位，而界面上完全看不出来。
       *    这条切词规则同时被内容流水线、服务端拼 fileID、朗读页共用。
       */
      const text = await loadArticleRefText(r.contentJson)
      const words = text.split(/\s+/).filter(Boolean)

      return {
        submissionId: r.id,
        articleId: r.articleId,
        // ⚠️ 日期可能为空（老数据）—— 前端据此决定要不要显示那一天
        scheduleDate: r.scheduleDate,
        // ⚠️ DECIMAL 读回来是字符串，出去一律变数字（见 schema 里的说明）
        score: r.score === null ? null : Number(r.score),
        // ⚠️ 同 submission-view：按 status 判，不读老的 is_conquered 列
        isConquered: r.status === 'scored',
        status: r.status,
        aiComment: r.aiComment,
        text,
        wordScores: parseWordScores(r.wordScores, words.length),
        at: (r.scoredAt ?? r.createdAt).toISOString(),
      }
    }),
  )

  return c.json({ ok: true, data: { items } })
})

/**
 * ⭐ 库里的逐词 JSON（完整 WordScore）→ 列表要的**最小形态**。
 *
 * ⚠️ 只留 score / dp 两个字段：起始结束时间、坏音素只有点开详情才有用，
 *    而列表一次几十条 —— 带上它们等于把整个详情包乘上条数。
 * ⚠️ score **原样透出，不四舍五入**：标绿的判据与结果屏共用同一个数，
 *    这里先舍一次，两边就会在 84.96 这种边界上一个绿一个灰。
 * ⚠️⚠️ 词数对不上时一律返回 null，**不截断也不补齐**：
 *    那说明这次成绩对应的句子和现在库里的正文不是同一版 ——
 *    按老结果上色会把第 3 个词染成第 4 个词的颜色。宁可整行不上色。
 * ⚠️ JSON 解析失败也不能把整个列表带崩：那是一条坏数据，不是一次故障。
 */
function parseWordScores(raw: string | null, wordCount: number): ChallengeWordScore[] | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as { word?: string; score?: number; dp?: string }[]
    if (!Array.isArray(parsed) || parsed.length !== wordCount) return null
    return parsed.map((w) => ({
      word: String(w.word ?? ''),
      score: Number(w.score),
      dp: w.dp ?? 'normal',
    }))
  } catch (err) {
    console.warn('[user] 逐词结果解析失败，这一条不上色：' + (err as Error).message)
    return null
  }
}
/**
 * ⭐ 「参与场次」—— 我在哪些句子上参与过（**一句 = 一场**），最近参与的排前面。
 *
 * ⚠️ 一条 = 一句，不是一次提交：同一句读十次也只有一条，次数放在 attempts 里。
 *    所以这里是 GROUP BY article_id，而不是把 submissions 原样列出来。
 * ⚠️ 只数 `status = 'scored'` 的提交 —— 与「参与场次」的口径一致
 *    （拿到分才算参与过，见 services/conquest.ts）。
 * ⚠️ 名次用 getRank(articleId, userId)：它是**按这一句的最高分**排的，
 *    所以「最高得分 + 位列第几」这两个数天然自洽；逐句查一次（N 很小），
 *    不值得为它写一条复杂的窗口函数 SQL。
 * ⚠️ score 是 DECIMAL，max/min 读回来是**字符串**，出去一律 Number（见 schema）。
 */
userRoutes.get('/participations', async (c) => {
  const userId = c.get('userId')

  const rows = await db
    .select({
      articleId: submissions.articleId,
      attempts: count(),
      best: max(submissions.score),
      worst: min(submissions.score),
      lastAt: max(submissions.createdAt),
      contentJson: articles.contentJson,
    })
    .from(submissions)
    .innerJoin(articles, eq(articles.id, submissions.articleId))
    .where(and(eq(submissions.userId, userId), eq(submissions.status, 'scored')))
    .groupBy(submissions.articleId, articles.contentJson)
    // ⚠️ 按「最近一次挑战」倒序 —— 注意排的是 max(created_at)，不是某一行的值
    .orderBy(desc(max(submissions.createdAt)))

  const items = await Promise.all(
    rows.map(async (r) => {
      const text = await loadArticleRefText(r.contentJson)
      const rankInfo = await getRank(r.articleId, userId)
      /**
       * ⭐ 最近这一次挑战属于哪一天 —— 卡片点进**竞技场**要用它。
       * ⚠️ 竞技场是按日期取场次的，所以这里取「最近那次提交的 schedule_date」，
       *    而不是端侧算今天：用户参与的可能是几天前那一场。
       */
      const [latest] = await db
        .select({ scheduleDate: submissions.scheduleDate })
        .from(submissions)
        .where(
          and(
            eq(submissions.userId, userId),
            eq(submissions.articleId, r.articleId),
            eq(submissions.status, 'scored'),
          ),
        )
        .orderBy(desc(submissions.createdAt))
        .limit(1)
      return {
        articleId: r.articleId,
        text,
        words: text.split(/\s+/).filter(Boolean).length,
        attempts: Number(r.attempts ?? 0),
        bestScore: Number(r.best ?? 0),
        worstScore: Number(r.worst ?? 0),
        rank: rankInfo.rank,
        participantCount: rankInfo.participantCount,
        lastAt: new Date(r.lastAt as unknown as string).toISOString(),
        lastScheduleDate: latest?.scheduleDate ?? '',
      }
    }),
  )

  return c.json({ ok: true, data: { items } })
})

/** 个人主页：Streak（含解冻卡）/ 能量 / 三个成长值 / 战绩计数 */
userRoutes.get('/me', async (c) => {
  const user = c.get('user')
  const userId = c.get('userId')

  // ⚠️ Streak 视图一律现算（它由库里字段 + 解冻卡表推导），不缓存：
  //    跨过零点之后「今天读没读」会翻面，缓存会让它停在昨天。
  const [streak, conqueredCount, stats, energy, growth] = await Promise.all([
    readStreakView(userId),
    getTotalConquered(userId),
    // ⭐ 首页状态卡上的「挑战过几句 / 一共几回」—— 服务端数，
    //    端侧那份缓存只覆盖最近 7 天的排期，数出来必然偏小。
    challengeStats(userId),
    // ⭐ 能量先**补足**再读（惰性 + 幂等，见 services/energy.ts）
    readEnergy(userId),
    // ⭐ 三个成长值（**分开展示、不合成总分** —— 见 growth-and-energy.md）
    readGrowth(userId),
  ])

  return c.json({
    ok: true,
    data: {
      id: user.id,
      nickname: user.nickname,
      avatarUrl: user.avatarUrl,
      status: user.status,
      // ⭐ **能量点数**（替代旧的「每天 N 次挑战机会」）。
      //    每次挑战消耗 2 点、每日补足到 3 点；端侧只管展示，不自己算余额。
      energy,
      // ⭐ 三个成长值 —— **分开给，不合成总分**（三个数各自回答一个问题，
      //    相加之后没人解释得清那个数是怎么来的）
      growth,
      // ⭐ 首页状态卡：挑战过几句 / 一共挑战了几回（全时段累计，只数打分成功的）
      challengedCount: stats.challengedCount,
      challengedRounds: stats.challengedRounds,
      conqueredCount,
      streak,
    },
  })
})

/**
 * ⭐ 「连战记录」—— 一个月的日历：哪天读了（连战）、哪天的缺口是解冻卡补的。
 *
 * ⚠️ 纯查询，**不落表**：连战日从 submissions 现算、解冻日从卡的 used_at 反推
 *    （见 services/streak-record.ts 的说明）。存一份"日历"就是第二份真相。
 * ⚠️ month 只接受 'YYYY-MM'，缺省 = 服务端的这个月；非法值直接按缺省处理
 *    （这是只读接口，报错没有意义，给用户一屏正常的内容更好）。
 */
userRoutes.get('/streak-record', async (c) => {
  const userId = c.get('userId')
  const data = await readStreakRecord(userId, c.req.query('month'))
  return c.json({ ok: true, data })
})

/**
 * ⭐ 领取待领取的解冻卡。
 *
 * ⚠️ 有效期从**这一刻**开始算（领取 + 1 年），不是从发放算 ——
 *    否则"没及时来领"变成"白白过期"，而用户根本没机会知道。
 * ⚠️ 幂等：没有待领取的就返回 0，不报错（用户连点两下不该看到红字）。
 */
userRoutes.post('/claim', async (c) => {
  const userId = c.get('userId')
  const claimed = await claimUnfreezeCards(userId)
  const streak = await readStreakView(userId)
  return c.json({ ok: true, data: { claimed, streak } })
})

/**
 * ⭐ 补签 —— 用解冻卡的**唯一**途径（用户主动点的）。
 *
 * 规格：docs/design/reward-system.md 第 7 节。三条要点：
 *   · **方案 a**：只能在「断档之后、今天还没读」时补（今天读过就补不了了）
 *   · 卡不够时**拒绝且一张都不扣**（不做部分补）
 *   · ⚠️ **补签本身不增加天数** —— 它只是把缺口填上，
 *     **用户当天还得读一句才会 +1**。所以客户端拿到成功之后要立刻引导他读今天这一句，
 *     文案说「补上之后，今天读一句就接上了」，而不是「已恢复连战」。
 */
userRoutes.post('/unfreeze', async (c) => {
  const userId = c.get('userId')
  const result = await useUnfreezeCards(userId)

  if (!result.ok) {
    const error =
      result.reason === 'already-read-today'
        ? '今天已经读过了 —— 断档要在今天读之前补'
        : result.reason === 'not-enough'
          ? '解冻卡不够：需要 ' + (result.need ?? 0) + ' 张，手上只有 ' + (result.have ?? 0) + ' 张'
          : '现在没有断档，不用补'
    return c.json({ ok: false, code: 'UNFREEZE_FAILED', reason: result.reason, error }, 400)
  }

  const [streak, cards] = await Promise.all([readStreakView(userId), unfreezeStatus(userId)])
  return c.json({ ok: true, data: { used: result.used, streak, unfreezeCards: cards.count } })
})

/**
 * ⭐ 头像 / 昵称的**唯一写入口** —— 小程序「头像昵称填写能力」的落地处。
 *
 * ⚠️⚠️ 为什么昵称必须由用户提供、不能我们生成：
 *    榜单上显示的就是昵称。给它一个自动编号（「挑战者 8231」）等于
 *    让用户在一张全是编号的榜上找不到自己，也无从判断「这是我吗」。
 *    所以榜上那个名字必须是用户自己认领的。
 *
 * ⚠️ 头像是**可选**的：chooseAvatar 用户可以取消。
 *    没有头像时客户端画昵称首字（一个空圆圈传达不了任何信息）。
 *
 * ⚠️ 它**不是登录**，也不构成任何判断：账号（openid）是静默拿到的，
 *    而服务端在鉴权中间件里按 openid 取或建 users 那一行（见 middleware/auth.ts）。
 *    所以「有没有加入」与这里填不填名字**毫无关系**（见客户端 store 的 hasJoined）。
 *    昵称只决定**榜单上显示成什么**，头像则纯属装饰。
 */
userRoutes.post('/profile', async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json<{ nickname?: string; avatarUrl?: string }>()

  const nickname = normalizeNickname(body.nickname)
  if (!nickname) {
    return c.json({ ok: false, error: '昵称不能为空（1–32 个字符）' }, 400)
  }
  const avatarUrl = normalizeAvatarUrl(body.avatarUrl)

  await db
    .update(users)
    .set({ nickname, ...(avatarUrl ? { avatarUrl } : {}) })
    .where(eq(users.id, userId))

  /**
   * ⚠️⚠️ 回**库里存着的**那一份，而不是把入参回显出去。
   *
   *    差别在"这次没传 avatarUrl"的时候：库里那张头像还在，
   *    回显 null 会让客户端以为"我没有头像了"，把界面上的头像抹掉。
   *    客户端拿这个返回值直接更新本地状态（见 store 的 applyProfilePatch），
   *    所以它必须是**更新之后的真相**，不是这次请求的输入。
   */
  const [row] = await db
    .select({ nickname: users.nickname, avatarUrl: users.avatarUrl })
    .from(users)
    .where(eq(users.id, userId))

  return c.json({
    ok: true,
    data: { nickname: row?.nickname ?? nickname, avatarUrl: row?.avatarUrl ?? null },
  })
})

/**
 * 昵称净化：折叠空白、剥掉控制字符、限长。
 *
 * ⚠️ 为什么要剥控制字符：昵称会进榜单、进分享文案，**换行和零宽字符**
 *    会让它在界面上显示成空白或把行撑开 —— 而这一切在提交时完全看不出来。
 */
export function normalizeNickname(raw: string | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 32)
}

/**
 * 头像地址只接受**本环境云存储的 fileID**。
 *
 * ⚠️⚠️ 不校验的后果不是「图片显示不出来」，而是用户可以把**任意 URL**
 *    存进 users.avatar_url —— 那会变成一张我们替别人托管的图
 *    （外部域名随时可能变成别的东西），而且榜单页会去请求它。
 *    这里只认 cloud://<本环境>.<桶>/<路径> 这一种形态，其余一律丢弃。
 */
export function normalizeAvatarUrl(raw: string | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value.startsWith('cloud://')) return null
  const prefix = 'cloud://' + env.WX_CLOUD_ENV_ID + '.' + env.COS_BUCKET + '/'
  if (!env.WX_CLOUD_ENV_ID || !env.COS_BUCKET || !value.startsWith(prefix)) return null
  // 只允许头像目录 —— 免得有人把它当任意文件的分布器
  return value.slice(prefix.length).startsWith('avatars/') ? value : null
}
