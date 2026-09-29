import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi'
import { and, desc, eq, inArray, lt, or } from 'drizzle-orm'
import { db } from '../db'
import { articles, energyLedger, participations, submissions, users } from '../db/schema'
import { env } from '../env'
import { loadArticleRefText } from '../services/content'
import { getTotalConquered } from '../services/conquest'
import { favoriteIdsOf } from '../services/favorites'
import { getArenaStatsBatch, getRank } from '../services/leaderboard'
import { challengeStats } from '../services/submission'
import { readEnergy } from '../services/energy'
import { claimUnfreezeCards, unfreezeStatus, useUnfreezeCards } from '../services/unfreeze'
import { readStreakRecord } from '../services/streak-record'
import { readGrowth } from '../services/growth'
import { readStreakView } from '../services/streak'
import { ENERGY_DAILY_FLOOR, ENERGY_PER_CHALLENGE, plainWordsOf } from '@jushuo/shared'
import type {
  ArenaRecord,
  ArticleRecordItem,
  ArticleRecordsResponse,
  ChallengeWordScore,
  EnergyLedgerItem,
} from '@jushuo/shared'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import {
  ChallengeRecordListSchema,
  EnergyResponseSchema,
  errorResponse,
  ParticipationRecordListSchema,
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
 * ⚠️ 粒度是**一次提交**（与「参与场次」不同：那边一人一句一行）：
 *    这一页要回答的是"我在这一句上读过几次、每次多少分"。
 * ⚠️ 只给 status = 'scored'：失败 / 进行中那次没有分数，
 *    混进来列表里就会出现一条"没有分数的历史"。
 * ⚠️ 顺序按**提交时间倒序**（最近一次在最上面）。
 * ⚠️ score 是 DECIMAL，读回来是字符串 —— 出去一律 Number（见 schema 的说明）。
 */
userRoutes.get('/article-records', async (c) => {
  const userId = c.get('userId')
  const articleId = (c.req.query('article') ?? '').trim()
  if (!articleId) return c.json({ ok: false, error: '缺 article 参数' }, 400)

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

    const items: ArticleRecordItem[] = rows.map((r, i) => ({
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

  const data: ArticleRecordsResponse = {
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
  return c.json({ ok: true, data })
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
      lastScheduleDate: participations.lastScheduleDate,
        /**
        * ⭐ **这一句的原文快照**（participations.text，用户 2026-09 要求）——
        *    历史必须自足：句子没上线 / 内容改过，列表照样显示「我当时读的是哪句」。
        * ⚠️ 这也让下面那个 `loadArticleRefText()` 回查变得不必要（原来那一步在句子
        *    关联不上时会拿到空串 ⇒ 卡片上是一片空白）。
        */
        text: participations.text,
        /** ⚠️ 词表快照：词数用它，不再拿 text 现算（见下面 words 那行的说明） */
        words: participations.words,
        theme: articles.theme,
    })
    .from(participations)
    .innerJoin(articles, eq(articles.id, participations.articleId))
    .where(eq(participations.userId, userId))
    .orderBy(desc(participations.lastAt))

    const items = await Promise.all(
      rows.map(async (r) => {
        /**
         * ⚠️ **原文取自快照**（`participations.text`，用户 2026-09 要求）——
         *    历史必须自足：句子没上线 / 内容改过，列表照样显示「我当时读的是哪句」。
         *    原来这里回查文章正文，关联不上就是一片空白。
         */
        const text = r.text ?? ''
        const rankInfo = await getRank(r.articleId, userId)
        return {
          articleId: r.articleId,
          text,
          /**
           * ⚠️ 词数用**快照**（`participations.words`），不再拿 text 现算 ——
           *    现算的话切词规则一改，历史卡片的词数就跟着变（而用户当时读的是旧那一份）。
           *    没有快照的老记录退回现算，别让卡片显示 0。
           */
          words: Array.isArray(r.words) ? r.words.length : plainWordsOf(text).length,
          attempts: Number(r.attempts ?? 0),
          bestScore: Number(r.best ?? 0),
          worstScore: Number(r.worst ?? 0),
          rank: rankInfo.rank,
          participantCount: rankInfo.participantCount,
          lastAt: new Date(r.lastAt as unknown as string).toISOString(),
          /**
           * ⭐ 最近这一次挑战属于哪一天 —— 卡片点进**竞技场**要用它。
           * ⚠️ 竞技场是按日期取场次的，所以取「最近那次挑战的 schedule_date」，
           *    而不是端侧算今天：用户参与的可能是几天前那一场。
           * ⚠️ 它随参与记录一起物化（写入时算好），不再逐行回查 submissions。
           */
          lastScheduleDate: r.lastScheduleDate ?? '',
          theme: r.theme,
        }
      }),
  )

  return c.json({ ok: true, data: { items } }, 200)
})

/**
 * ⭐ 「我在这几句上的战绩」—— **鉴权接口**（/api/user/*）。
 *
 * ⚠️⚠️ 公开的句子列表 / 竞技场**不含任何「我的」字段**；端侧把这份数据按
 *    articleId 融合进去：卡片上的描边、「已参与 N 次 · 最高 X 分」、按钮文案，
 *    以及竞技场里「我的战绩」那一卡，全部由它来。
 *    这样公开接口对所有人返回同一份（可缓存），而「我的」永远只有一个来源。
 *
 * ⚠️ 只查**被问到的那几个 id**（首页一次最多 6 个），不是「把我的全量记录拉下来」：
 *    读了几百次的人，全量会有几千行，而首屏只用到那几张卡片。
 *
 * @param ids   逗号分隔的 articleId（端侧把当前屏上的 id 一起带过来）
 * @param ranks '1' 时额外算名次 —— 名次是**跨用户**的（公开榜单只给前 20，
 *              客户端自己算不出第 500 名），所以只能服务端算，也只在这一场算一次。
 */
userRoutes.get('/arena-records', async (c) => {
  const userId = c.get('userId')
  // ⚠️ articleId 是内容 hash（字符串）—— 按原样解析，**不再转数字**
  const ids = (c.req.query('ids') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .slice(0, 20)
  if (ids.length === 0) return c.json({ ok: true, data: { items: [] } })
  const wantRanks = c.req.query('ranks') === '1'

  /**
   * ⚠️ 读**参与记录**而不是聚合 submissions：一人一句一行，
   *    「已参与 N 次 · 最高 X 分」两个数直接取，不再 GROUP BY
   *    （口径见 services/participations.ts：只算打分成功的那几次）。
   */
  const [rows, favIds] = await Promise.all([
    db
      .select({
        articleId: participations.articleId,
        attempts: participations.attempts,
        best: participations.bestScore,
      })
      .from(participations)
      .where(
        and(eq(participations.userId, userId), inArray(participations.articleId, ids)),
      ),
    favoriteIdsOf(userId, ids),
  ])

  // ⚠️ 显式标类型：下面那条"只收藏、没参与"的补充项有 null 字段，
  //    靠推断会把它推成 number（TS 报错，顺便也把契约写清楚了）
  const items: ArenaRecord[] = await Promise.all(
    rows.map(async (r) => {
      const rankInfo = wantRanks ? await getRank(r.articleId, userId) : null
      // getRank 在「没参与过」时返回 rank 0 —— 转成 null，让「没读」和「第 0 名」不混为一谈
      const ranked = rankInfo && rankInfo.rank > 0 ? rankInfo : null
      return {
        articleId: r.articleId,
        // ⚠️ best_score 是 NOT NULL（参与记录只在出分时才写），不是"没参与"那种 null
        bestScore: Number(r.best),
        attempts: Number(r.attempts ?? 0),
        rank: ranked ? ranked.rank : null,
        beatenCount: ranked ? ranked.beatenCount : null,
        isFavorite: favIds.has(r.articleId),
      }
    }),
  )

  /**
   * ⚠️⚠️ **只收藏、没参与过的句子也要返回一条**。
   *    这一份的数据源是参与记录，而"收藏"与"参与"是两件事 ——
   *    漏掉这条的话，用户在竞技场页把一句没读过的句子收藏了，
   *    下次进来按钮又变回空心（他以为收藏丢了）。
   */
  const seen = new Set(rows.map((r) => r.articleId))
  for (const id of favIds) {
    if (seen.has(id)) continue
    items.push({
      articleId: id,
      bestScore: null,
      attempts: 0,
      rank: null,
      beatenCount: null,
      isFavorite: true,
    })
  }

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
      gender: (user.gender ?? null) as 'male' | 'female' | null,
      age: user.age ?? null,
      bio: user.bio ?? null,
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
