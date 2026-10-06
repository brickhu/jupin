import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, desc, eq, lt, or } from 'drizzle-orm'
import { db } from '../db'
import { articles, energyLedger, participations, submissions, users } from '../db/schema'
import { env } from '../env'
import { loadArticleRefText } from '../services/content'
import { getArenaStatsBatch, getRank } from '../services/leaderboard'
import { buildMeView } from '../services/me-view'
import { participationRecordOf, toParticipationRecord } from '../services/participations'
import { readEnergy } from '../services/energy'
import { exchangeCookiesForEnergy } from '../services/cookies'
import { readStreakRecord } from '../services/streak-record'
import { makeUpStreak } from '../services/makeup'
import { readStreakView } from '../services/streak'
import { ENERGY_DAILY_FLOOR, ENERGY_PER_CHALLENGE, plainWordsOf } from '@jushuo/shared'
import type {
  ParticipationSubmissionItem,
  ParticipationSubmissionsResponse,
  ChallengeWordScore,
  EnergyLedgerItem,
} from '@jushuo/shared'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import {
  ParticipationSubmissionsResponseSchema,
  ChallengeRecordListSchema,
  EnergyResponseSchema,
  errorResponse,
  MeResponseSchema,
  ParticipationRecordListSchema,
  ParticipationRecordResponseSchema,
  ProfileUpdateResponseSchema,
  StreakRecordResponseSchema,
  MakeupResponseSchema,
  ExchangeResponseSchema,
} from '../openapi/schemas'

export const userRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

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
const challengesRoute = createRoute({
  method: 'get',
  path: '/challenges',
  tags: ['我的'],
  summary: '我的挑战记录（一次提交一行，倒序）',
  security: [{ userToken: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: ChallengeRecordListSchema } },
      description: '成功',
    },
  },
})

userRoutes.openapi(challengesRoute, async (c) => {
  const userId = c.get('userId')

  const rows = await db
    .select({
      id: submissions.id,
      articleId: submissions.articleId,
      scheduleDate: submissions.scheduleDate,
      score: submissions.score,
      status: submissions.status,
      aiComment: submissions.aiComment,
      wordScores: submissions.wordScores,
      scoredAt: submissions.scoredAt,
      createdAt: submissions.createdAt,
      theme: articles.theme,
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
        const text = await loadArticleRefText(r.articleId)
      const words = plainWordsOf(text)

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
        theme: r.theme,
        at: (r.scoredAt ?? r.createdAt).toISOString(),
      }
    }),
  )

  return c.json({ ok: true, data: { items } }, 200)
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
 * ⭐ 我在**某一句**上的历史挑战（逐次）—— 朗读页「历史挑战」那一段用它。
 *
 * ⚠️⚠️ **路径挂在"参与"这个资源下面**（2026-09 改）：
 *    一次参与 = (我, 这一句) —— 它的**子资源**才是逐次提交。
 *    原来这条叫 `/api/user/article-records?article=`（按句子查提交），
 *    与 `/api/user/participation/{articleId}` 是两个入口、两套说法；
 *    现在统一成"从 participation 进去看它的 submissions"。
 *    ⇒ 判据 **`(userId, articleId)`**，与 participations 的主键同一个身份。
 *
 * ⚠️ 粒度是**一次提交**（与「参与场次」不同：那边一人一句一行）：
 *    这一页要回答的是"我在这一句上读过几次、每次多少分"。
 * ⚠️ 只给**有结论的**（scored / failed）：进行中那次没有结论，
 *    混进来列表里就会出现一条"没有结论的历史"。
 * ⚠️ 顺序按**提交时间倒序**（最近一次在最上面）。
 * ⚠️ score 是 DECIMAL，读回来是字符串 —— 出去一律 Number（见 schema 的说明）。
 * ⚠️ 没参与过（这一句一次都没提交）不是错误：回**空数组**，不 404 ——
 *    朗读页对任何句子都会调它，首次进来本来就该是空的。
 */
const participationSubmissionsRoute = createRoute({
  method: 'get',
  path: '/participation/{articleId}/submissions',
  tags: ['我的'],
  summary: '我在某一句上的逐次提交（朗读页的历史挑战）',
  security: [{ userToken: [] }],
  request: { params: z.object({ articleId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: ParticipationSubmissionsResponseSchema } },
      description: '成功（没参与过就是空数组）',
    },
  },
})

userRoutes.openapi(participationSubmissionsRoute, async (c) => {
  const userId = c.get('userId')
  const articleId = c.req.param('articleId')

  const rows = await db
    .select({
      submissionId: submissions.id,
      score: submissions.score,
      createdAt: submissions.createdAt,
      scheduleDate: submissions.scheduleDate,
      isPublic: submissions.isPublic,
      /** ⚠️ 客户端按它区分「未出分」与「有分」（见下面 where 的说明） */
      status: submissions.status,
    })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.articleId, articleId),
        /**
         * ⚠️⚠️ **判据是"有没有结论"**（`scored` / 引擎判无效）：
         *      · `scoring`（检测中）—— 没有结论，不该出现在历史里；
         *      · 没触达 —— 那一行已经被删掉了，根本查不到；
         *      · `scored` / 引擎判无效 —— 显示（后者按「未出分」渲染）。
         *    ⚠️ "第几次"不再存列（`seq` 已删）—— 它按**这里返回的行序现算**（见下面 items），
         *      所以序号天然连续、不可能有空洞，也不需要分配器/唯一索引/重编号。
         */
        or(eq(submissions.status, 'scored'), eq(submissions.status, 'failed')),
      ),
    )
    .orderBy(desc(submissions.createdAt))

    const items: ParticipationSubmissionItem[] = rows.map((r, i) => ({
      submissionId: r.submissionId,
      /**
       * ⭐ 第几次 —— **按行序现算**（列表是最新在前 ⇒ 最后一行是最旧的 = 第 1 次）。
       *    ⚠️ 不存列：存了就要维护（分配器 + 撞号重试 + 唯一索引 + 重编号脚本），
       *      而它只是个显示位置；现算还顺带保证"序号一定连续"。
       */
      seq: rows.length - i,
    /**
     * ⚠️ 两点都要小心：
     *    · `status` 在库里是 varchar，drizzle 读到的是 `string` ⇒ 这里**收窄**成联合类型
     *      （上面的查询已经把它限定在 scored / failed 两种）；
     *    · `score` **可能是 null**（未出分那次）—— **不能 `Number(null)`**：
     *      那会变成 0，而 0 分是合法成绩，两者混起来"最低分"就错了。
     */
    status: r.status === 'failed' ? ('failed' as const) : ('scored' as const),
    score: r.score === null || r.score === undefined ? null : Number(r.score),
    createdAt: r.createdAt.toISOString(),
    scheduleDate: r.scheduleDate ?? null,
    isPublic: r.isPublic === true,
  }))

  /**
   * ⚠️ 最好成绩 / 次数**现算**，而不是读 participations：
   *    那个派生索引是"一人一句一行"的榜单口径，这里要的是同一份真相的
   *    另一种投影 —— 两者都由 submissions 推出，不会互相矛盾。
   */
  /**
   * ⭐ 另外三个数给朗读页那张「我的参与」摘要卡（挑战 / 最高 / 位列 / 最低）：
   *    · 名次 —— 跨用户算的，端侧**算不出来**，必须服务端给（复用 getRank，与竞技场同一处实现）；
   *    · 参与人数 / 最低分 —— 复用 getArenaStatsBatch（与竞技场页的「参与概要」同一个来源）。
   * ⚠️ 不自己写 SQL 算名次：那套全序（分数 → 谁先拿到 → id）只在 leaderboard.ts 里有一份，
   *    抄一份出去迟早和榜单对不上（同分先后是这里最容易错的地方）。
   */
  const [stats, rankInfo] = await Promise.all([
    getArenaStatsBatch([articleId], userId).then((m) => m.get(articleId)),
    // ⚠️ getRank 对"没参与过"的人回 rank=0 ⇒ 这里统一成 null（0 会被读成"第 0 名"）
    getRank(articleId, userId).then((r) => (r.rank > 0 ? r.rank : null)),
  ])

  const data: ParticipationSubmissionsResponse = {
    items,
      /**
       * ⚠️ `score` 可能是 null（未出分那次）⇒ 先滤掉再取最高：
       *    `Math.max(...)` 里混进 null 会当成 0，"最高分"就变成 0 了。
       *    ⚠️ 而 **0 分是合法成绩** —— 两种都不能混。
       */
      bestScore: (() => {
        const scored = items.map((i) => i.score).filter((s): s is number => typeof s === 'number')
        return scored.length === 0 ? null : Math.max(...scored)
      })(),
      /**
       * ⚠️ **"挑战过"的口径 = scored + failed**（用户 2026-09 定）——
       *    与列表行数一致，也与服务端 participations.attempts 一致。
       */
      attempts: items.length,
    rank: rankInfo,
    participantCount: stats?.participantCount ?? 0,
    lowestScore: stats?.lowestScore ?? null,
  }
  return c.json({ ok: true, data }, 200)
})

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
const participationsRoute = createRoute({
  method: 'get',
  path: '/participations',
  tags: ['我的'],
  summary: '我参与过的场次（一句一行 = 一个竞技场）',
  security: [{ userToken: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: ParticipationRecordListSchema } },
      description: '成功',
    },
  },
})

userRoutes.openapi(participationsRoute, async (c) => {
  const userId = c.get('userId')

  /**
   * ⭐ 直接读**参与记录**（一人一行）—— 不再对 submissions 做 GROUP BY：
   *    attempts / best / worst / last_at 全都是写入时算好的，
   *    而且它们与榜单**同源**（见 services/participations.ts）。
   * ⚠️ 排序键 last_at 与索引 participations_user_time_idx 同序。
   */
  const rows = await db
    .select({
      articleId: participations.articleId,
      attempts: participations.attempts,
      best: participations.bestScore,
      worst: participations.worstScore,
      lastAt: participations.lastAt,
        /**
        * ⭐⭐⭐ **两个快照列**（用户 2026-09 定）：
        *    · `words` —— 词表（含标点，**端侧拼出原文**）+ 逐词音标/释义/技巧；
        *    · `links` —— 词间连读标注。
        * ⚠️ 原来还有一个 `text` 快照列，**已删**：原文是 `words[].text` 的派生值，
        *    再存一份就是第二份真相（还闹出过"空数组 ⇒ 词数显示 0"的 bug）。
        * ⚠️ 有了它们，历史才自足：句子没上线 / 内容改过，列表照样显示当时那一份。
        */
        words: participations.words,
        links: participations.links,
        /**
        * ⚠️ 只用于**快照为空时**的兜底原文（内容缺口：3 篇的 articles.words 是空的）。
        *    正常行用不到它 —— 端侧自己从 words 拼（见 toParticipationRecord）。
        */
        articleText: articles.text,
        theme: articles.theme,
        /** ⭐ 这一行的地址（派生值）—— 记录自带它，端侧才能直接分享/跳转 */
        id: participations.id,
        /** ⭐ 这一句累计赚到的饼干（这条参与下已出分 submissions 的 cookies_earned 之和） */
        cookies: participations.cookies,
    })
    .from(participations)
    .innerJoin(articles, eq(articles.id, participations.articleId))
    .where(eq(participations.userId, userId))
    .orderBy(desc(participations.lastAt))

  /**
   * ⚠️ 映射走 services/participations.ts 的 `toParticipationRecord` ——
   *    与单取接口 `GET /api/user/participation/{articleId}` **共用同一份口径**
   *    （原文/词数取快照、名次跨用户现算），两处各写一遍迟早自相矛盾。
   */
  const items = await Promise.all(
    rows.map(async (r) => toParticipationRecord(r, await getRank(r.articleId, userId))),
  )

  return c.json({ ok: true, data: { items } }, 200)
})

/**
 * ⭐⭐ **我在这条句子上的参与记录**（`GET /api/user/participation/{articleId}`）。
 *
 * ⚠️ 与上面的「参与场次」列表是**同一个事实的单取形式**：列表给全部、这条给一条。
 *    形状完全一样（ParticipationRecord），**没参与过时 data 为 null**
 *    （不是 404、更不是一条全 0 的假记录 —— 0 分是合法成绩）。
 *
 * ⚠️ 鉴权前缀 `/api/user/*` ⇒ 只有本人能读自己的记录；articleId 只是个筛选键，
 *    不会因此看到别人的数据（见 routes/participation-scope.test.ts）。
 */
const participationRoute = createRoute({
  method: 'get',
  path: '/participation/{articleId}',
  tags: ['我的'],
  summary: '我在这条句子上的参与记录（没参与过为 null）',
  security: [{ userToken: [] }],
  request: { params: z.object({ articleId: z.string() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: ParticipationRecordResponseSchema } },
      description: '成功（data 为 null = 我还没挑战过这一句）',
    },
  },
})

userRoutes.openapi(participationRoute, async (c) => {
  const userId = c.get('userId')
  const articleId = c.req.param('articleId')
  return c.json({ ok: true, data: await participationRecordOf(userId, articleId) }, 200)
})

/** 个人主页：Streak（含解冻卡）/ 能量 / 三个成长值 / 战绩计数 */
const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['我的'],
  summary: '我是谁（昵称/头像/累计数/连战/能量）',
  security: [{ userToken: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: MeResponseSchema } },
      description: '成功',
    },
  },
})

userRoutes.openapi(meRoute, async (c) => {
  const user = c.get('user')

  /**
   * ⚠️⚠️ 能走到这里就说明**已经注册过**：`/api/user/*` 上的 authMiddleware
   *    只按 openid **查**行（不再建行），查不到直接 403 `NOT_REGISTERED`。
   *    ⇒ 这个接口不再是「打开小程序就顺带建号」的落点（那件事 2026-09 取消）。
   *    构造逻辑抽在 services/me-view.ts，与 `POST /api/auth/register` 共用。
   */
  return c.json({ ok: true, data: await buildMeView(user) }, 200)
})

/**
 * ⭐ 「连战记录」—— 一个月的日历：哪天读了（连战）、哪天的缺口是解冻卡补的。
 *
 * ⚠️ 纯查询，**不落表**：连战日从 submissions 现算、解冻日从卡的 used_at 反推
 *    （见 services/streak-record.ts 的说明）。存一份"日历"就是第二份真相。
 * ⚠️ month 只接受 'YYYY-MM'，缺省 = 服务端的这个月；非法值直接按缺省处理
 *    （这是只读接口，报错没有意义，给用户一屏正常的内容更好）。
 */
const streakRecordRoute = createRoute({
  method: 'get',
  path: '/streak-record',
  tags: ['我的'],
  summary: '连战日历（一个月：哪天读了 / 哪天用卡补的）',
  security: [{ userToken: [] }],
  request: { query: z.object({ month: z.string().optional() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: StreakRecordResponseSchema } },
      description: '成功',
    },
  },
})

userRoutes.openapi(streakRecordRoute, async (c) => {
  const userId = c.get('userId')
  const data = await readStreakRecord(userId, c.req.query('month'))
  return c.json({ ok: true, data }, 200)
})

/**
 * ⭐ 能量：余额 + 流水（me/energy 页）。
 *
 * ⚠️ 余额走 readEnergy() 而不是直接读 users.energy —— 它内部**先做每日补足**，
 *    所以端侧拿到的一定是「现在真正能用几点」，而不是昨天留下的旧值。
 *
 * ⚠️ 分页用**游标**（before = 上一条的 id）而不是 offset：
 *    流水只会往前长，offset 分页在「一边翻页一边有新记录」时会漏条/重条。
 * ⚠️ limit 不信任端侧：夹在 5–100。
 */
const energyRoute = createRoute({
  method: 'get',
  path: '/energy',
  tags: ['我的'],
  summary: '我的能量余额与流水（分页）',
  security: [{ userToken: [] }],
  request: { query: z.object({ limit: z.string().optional(), before: z.string().optional() }) },
  responses: {
    200: {
      content: { 'application/json': { schema: EnergyResponseSchema } },
      description: '成功',
    },
  },
})

userRoutes.openapi(energyRoute, async (c) => {
  const userId = c.get('userId')

  const limitRaw = Number(c.req.query('limit'))
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(5, Math.trunc(limitRaw))) : 30
  const beforeRaw = Number(c.req.query('before'))
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? Math.trunc(beforeRaw) : null

  const energy = await readEnergy(userId)

  const rows = await db
    .select()
    .from(energyLedger)
    .where(before === null ? eq(energyLedger.userId, userId) : and(eq(energyLedger.userId, userId), lt(energyLedger.id, before)))
    .orderBy(desc(energyLedger.id))
    .limit(limit)

  const items: EnergyLedgerItem[] = rows.map((r) => ({
    id: r.id,
    delta: r.delta,
    reason: r.reason,
    refType: r.refType,
    refId: r.refId,
    createdAt: r.createdAt.toISOString(),
  }))

  return c.json({
    ok: true,
    data: {
      energy,
      perChallenge: ENERGY_PER_CHALLENGE,
      dailyFloor: ENERGY_DAILY_FLOOR,
      items,
      /** ⭐ 只有「刚好取满一页」时才可能还有下一页 —— 少取一条就说明到底了 */
      nextBefore: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
    },
    }, 200)
})

/**
 * ⭐⭐ **补签** —— 断档之后花能量把缺口填上。规格：prd §7.8 / plan B50。
 *
 * ⚠️ 它是**用户主动点的**，不会被任何自动流程调用。
 *
 * ⚠️⚠️ 客户端拿到成功之后要**立刻引导他去读今天这一句**：
 *    补签只是把缺口填上、**本身不加天数**，今天不读，今天就成了新的缺口
 *    （见 shared/makeup.ts 的说明）。文案说「补上了，今天读一句就接上」，
 *    而不是「连战已恢复」。
 *
 * ⚠️ 失败有两种**完全不同**的原因，端侧要分开说：
 *    · 连战那边：今天已读 / 没断档 / 断太久（`too-long` ⇒ 说成"重新开始"，别说失败）
 *    · 能量那边：`not-enough-energy` ⇒ 带上 `shortfall`，指向"吃饼干 / 充值"
 */
/**
 * ⭐⭐ **吃饼干补充能量** —— 40 块换 1 点（`COOKIES_PER_ENERGY`）。
 *
 * ⚠️ **一次换完**（把余额能换的都换掉），不接受数量：
 *    能量比饼干**更通用**（能读句子、也能补签），而饼干只有这一个用途 ⇒
 *    留着它没有任何好处，让用户填数量只是白加一步。
 *
 * ⚠️⚠️ `requestId` 由**客户端**生成（按一次按钮生成一个）——
 *    两个账本各用它挡重，连点 / 重试都不会换两次。
 *    没有它的话，双击一次按钮就会白扣 40 块。
 */
const exchangeRoute = createRoute({
  method: 'post',
  path: '/exchange',
  tags: ['我的'],
  summary: '吃饼干换能量（40 块 = 1 点，一次换完）',
  security: [{ userToken: [] }],
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({ requestId: z.string().min(8).max(64) }),
        },
      },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ExchangeResponseSchema } },
      description: '成功（⚠️ `data.ok` 才是"换成了没有"）',
    },
  },
})

userRoutes.openapi(exchangeRoute, async (c) => {
  const userId = c.get('userId')
  const { requestId } = c.req.valid('json')
  // ⚠️ 换不成也返回 200（业务结果，不是请求错误）
  return c.json({ ok: true, data: await exchangeCookiesForEnergy(userId, requestId) }, 200)
})

const makeupRoute = createRoute({
  method: 'post',
  path: '/makeup',
  tags: ['我的'],
  summary: '补签（花能量填断档）—— 一天只能补一次，最多补 3 天',
  security: [{ userToken: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: MakeupResponseSchema } },
      description: '成功（⚠️ `data.ok` 才是"补成了没有"；补不成也走 200，靠 reason 区分）',
    },
  },
})

userRoutes.openapi(makeupRoute, async (c) => {
  const userId = c.get('userId')
  const r = await makeUpStreak(userId)
  /**
   * ⚠️ 补不成**也返回 200**，不返回 4xx：
   *    这不是"请求错了"，是一个正常的业务结果（今天读过了 / 断太久了 / 能量不够），
   *    而 4xx 会让端侧的通用错误处理弹一句无用的"网络异常"。
   */
  return c.json({ ok: true, data: r }, 200)
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
const profileRoute = createRoute({
  method: 'post',
  path: '/profile',
  tags: ['我的'],
  summary: '保存我的资料（昵称/头像/性别/年龄/简介）',
  security: [{ userToken: [] }],
  request: {
    body: { content: { 'application/json': { schema: /** ⚠️ `nickname` **刻意不标必填**：标了之后空昵称会被框架先拦下，
             错误文案变成「nickname：Required」，而 handler 里那句
             「昵称不能为空（1–32 个字符）」才是给人看的（也才是原来的行为）。 */
        z.object({
          nickname: z.string().nullish(),
          avatarUrl: z.string().nullish(),
          gender: z.enum(['male', 'female']).nullish(),
          age: z.number().nullish(),
          bio: z.string().nullish(),
        }) } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ProfileUpdateResponseSchema } },
      description: '成功',
    },
    400: errorResponse('昵称不能为空（1–32 个字符）'),
  },
})

userRoutes.openapi(profileRoute, async (c) => {
  const userId = c.get('userId')
  const body = await c.req.json<{
    nickname?: string
    avatarUrl?: string
    gender?: string | null
    age?: number | string | null
    bio?: string | null
  }>()

  const nickname = normalizeNickname(body.nickname)
  if (!nickname) {
    return c.json({ ok: false, error: '昵称不能为空（1–32 个字符）' }, 400)
  }
  const avatarUrl = normalizeAvatarUrl(body.avatarUrl)

  /**
   * ⭐⭐ 三态语义：**键不存在 = 这次不改这一格；显式 null / 空串 = 清空；有值 = 设置**。
   *
   *    ⚠️ 不能把「没传」和「传了 null」当成一回事：
   *       前者是「这次不编辑这一格」，后者是用户明确要把它清掉。
   *       混在一起，编辑页就永远清不掉一个字段。
   *    ⚠️ 头像沿用旧规则：只有真的选了新头像才传 avatarUrl，没传就保持库里那张。
   */
  const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k)
  const patch: {
    nickname: string
    avatarUrl?: string
    gender?: 'male' | 'female' | null
    age?: number | null
    bio?: string | null
  } = { nickname }
  if (avatarUrl) patch.avatarUrl = avatarUrl
  if (has('gender')) patch.gender = normalizeGender(body.gender)
  if (has('age')) patch.age = normalizeAge(body.age)
  if (has('bio')) patch.bio = normalizeBio(body.bio)

  await db.update(users).set(patch).where(eq(users.id, userId))

  /**
   * ⚠️⚠️ 回**库里存着的**那一份，而不是把入参回显出去。
   *
   *    差别在"这次没传 avatarUrl"的时候：库里那张头像还在，
   *    回显 null 会让客户端以为"我没有头像了"，把界面上的头像抹掉。
   *    客户端拿这个返回值直接更新本地状态（见 store 的 applyProfilePatch），
   *    所以它必须是**更新之后的真相**，不是这次请求的输入。
   */
  const [row] = await db
    .select({
      nickname: users.nickname,
      avatarUrl: users.avatarUrl,
      gender: users.gender,
      age: users.age,
      bio: users.bio,
    })
    .from(users)
    .where(eq(users.id, userId))

  return c.json({
    ok: true,
    data: {
      nickname: row?.nickname ?? nickname,
      avatarUrl: row?.avatarUrl ?? null,
      gender: (row?.gender ?? null) as 'male' | 'female' | null,
      age: row?.age ?? null,
      bio: row?.bio ?? null,
    },
  }, 200)
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

/**
 * 性别净化：只认 'male' / 'female'，其余（含未填、乱填）一律 null。
 * ⚠️ 不做「猜」——把 '男' / 'M' / '1' 映射过来，等于替用户改数据。
 */
export function normalizeGender(raw: unknown): 'male' | 'female' | null {
  return raw === 'male' || raw === 'female' ? raw : null
}

/**
 * 年龄净化：整数、6–120；空 / 非数字 / 越界一律 null。
 * ⚠️ 上限存在是因为 age 会进榜/进主页那类展示，一个 99999 摆上去就是脏数据。
 */
export function normalizeAge(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim())
  if (!Number.isInteger(n) || n < 6 || n > 120) return null
  return n
}

/**
 * 简介净化：剥控制字符 / 折叠空白 / 限 200 字；空 → null。
 * ⚠️ 与昵称共用同一类风险：它会显示在界面上，换行和零宽字符会把排版搞乱。
 */
export function normalizeBio(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return value || null
}
