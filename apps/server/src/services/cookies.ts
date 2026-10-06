import { and, desc, eq, lt, ne, sql } from 'drizzle-orm'
import {
  COOKIE_PASS_LINE,
  COOKIES_PER_ENERGY,
  cookieAwardOf,
  energyFromCookies,
  type ArticleLevel,
  type CookieAward,
  type CookieAwardView,
  type CookiesResponse,
  type ExchangeResponse,
} from '@jushuo/shared'

import { db, type Executor } from '../db'
import { ENERGY_REASON, addEnergy } from './energy'
import { articles, cookieLedger, submissions, users } from '../db/schema'

/**
 * ⭐ 饼干的**取数与记账** —— 算法在 `@jushuo/shared/cookies.ts`（纯函数），
 *    这里只负责三件事：
 *      ① 把「提交那一刻的历史」查出来（我在这句的历史最好分、当时的榜单分位）；
 *      ② 算出这一次赚多少；
 *      ③ 把结果写进快照 + 余额 + 流水（**同一个事务**）。
 *
 * ⚠️⚠️ 这是 `services/growth.ts` 的重写版（成长值三个维度已整体废除，见 prd §7.6）。
 *    保留它最要紧的那条约束：**必须排除本次提交**。结算发生在分数已经落库之后，
 *    不排除的话「历史最好分」就是它自己 ⇒ 永远算成"没刷新" ⇒ 永远不发饼干。
 *
 * ⚠️⚠️ 全都**现查**，不能事后重算 —— 这也是为什么结果必须落快照。
 */

const MAX_SCORE = sql<number | null>`MAX(${submissions.score})`

/**
 * ⭐ 读一句的**难度档位** —— 饼干基准（10/20/30/40）由它决定。
 *
 * ⚠️ `articles.difficulty` 是**派生列**（由判据分算出来），直接读即可，
 *    不要在这里重算 `difficultyFromScores` —— 那会多出第二份算法。
 * ⚠️ 它是 nullable 的（老内容没有判据分）⇒ 交给 `cookieBaseOf` 按初级兜底。
 */
export async function difficultyOf(
  articleId: string,
  tx: Executor = db,
): Promise<ArticleLevel | null> {
  const [row] = await tx
    .select({ difficulty: articles.difficulty })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1)
  return (row?.difficulty ?? null) as ArticleLevel | null
}

/** 我在这句上的历史最高分（**本次之前**）—— 攻克线的基准 */
export async function highestInSentence(
  userId: number,
  articleId: string,
  excludeSubmissionId: string,
  tx: Executor = db,
): Promise<number | null> {
  const [row] = await tx
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

/**
 * ⭐ 该场的**榜单分数快照** —— 每个参与者取历史最高分、**一人一条**。
 *
 * ⚠️ 与榜单**同一个口径**（用户能自己对着榜单核对位置），但它**故意读 submissions
 *    而不是 participations**：参数要排除**当前这一次提交**，
 *    而参与记录里只留了最高那一条 —— 如果最高分恰好是本次，
 *    从参与记录里根本答不出「排除它之后我还剩多少」。
 *    这是「某一次结算时刻的快照」，不是「榜单读数」，所以两边分工不同。
 *
 * ⚠️ 一人一条同样重要：一个用户在同一句挑战 100 轮，只有最高分那一次算数 ——
 *    否则一个人反复读就能把自己的分位推上去（等于替自己刷排名系数）。
 */
export async function arenaSnapshot(
  articleId: string,
  excludeSubmissionId: string,
  tx: Executor = db,
): Promise<number[]> {
  const rows = await tx
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

export interface CookiePercentile {
  /** 名次分位：**0 = 最好**、趋近 1 = 最差 */
  percentile: number
  /** 样本量（**含本人**）—— 决定要不要按分位算（见 COOKIE_RANK_MIN_SAMPLE） */
  sampleSize: number
}

/**
 * ⭐ **我在这一句的名次分位**。
 *
 * ~~~
 * 比我高或平手的人数 / (其他人 + 我)
 * ~~~
 *
 * ⚠️ 分母**含本人**：所以"我是唯一一个"时是 `0 / 1 = 0` ⇒ 前 10% ⇒ 满额。
 *    这正是想要的效果（早鸟优势：去填补没人读过的句子），见 prd §7.6。
 * ⚠️ 上界取不到 1：最后一名是 `n/(n+1)`，所以不会掉进"第 11 档"。
 * ⚠️ 用 **>=** 而不是 `>`：平手时算"我不占优" —— 与榜单"先来的在前"一致，
 *    而且它让"刷到和最高分一样"没有额外收益。
 */
export function cookiePercentileOf(score: number, snapshot: readonly number[]): CookiePercentile {
  const others = snapshot.filter((v) => Number.isFinite(v))
  const beatMe = others.filter((v) => v >= score).length
  const sampleSize = others.length + 1
  return { percentile: beatMe / sampleSize, sampleSize }
}

export interface CookieComputation extends CookieAward {
  /** 记账依据 —— 回看结果页要能回答「还差多少」与「为什么是这个数」 */
  meta: Record<string, unknown>
}

/**
 * ⭐ **一次结算能拿多少饼干** —— 纯输入输出，方便单测与落快照。
 *
 * ⚠️ 只在**打分成功**时才走到这里：读不出来的录音不该给饼干
 *    （「我明明没读成功，怎么算我攻克了」）。
 * ⚠️ 它与 `growth.ts` 的三维版本最大的不同：**连续天数不再参与**
 *    （「坚持不懈」与连战是同一个数，已删；连战的奖励走解冻/补签那条线）。
 */
export function computeCookies(input: {
  score: number
  difficulty: ArticleLevel | null | undefined
  highestInSentence: number | null
  snapshot: number[]
}): CookieComputation {
  const { percentile, sampleSize } = cookiePercentileOf(input.score, input.snapshot)
  const award = cookieAwardOf({
    score: input.score,
    bestInSentence: input.highestInSentence,
    difficulty: input.difficulty,
    percentile,
    sampleSize,
  })

  return {
    ...award,
    meta: {
      // ⭐ 结果页要的两件事，全靠这几个数：
      //    「还差 X 分」需要 passLine；「为什么是这个数」需要 base / rankFactor
      bestInSentence: input.highestInSentence,
      passLine: award.passLine,
      difficulty: input.difficulty ?? null,
      base: award.base,
      rankFactor: award.rankFactor,
      percentile,
      sampleSize,
    },
  }
}

/** ⭐ 饼干的**累计值**（展示用）—— 两个位置：累计获得（只增）/ 可用（可花） */
export interface CookieTotals {
  /** 累计获得：流水里所有正数之和。**只增不减** */
  total: number
  /** 可用余额：`users.cookies`（缓存，真相在流水里） */
  balance: number
}

/**
 * ⭐ 读饼干的两个数。
 *
 * ⚠️ 「累计获得」**现算**（`SUM(delta) WHERE delta > 0`），不存列 ——
 *    它只在个人主页出现一次，多存一列就多一处会漂移的地方。
 * ⚠️ 两个数一起去，别只给一个：只给余额的话，花掉时看起来像**退步**
 *    （损失厌恶），而「累计获得」才是那条只增的进步线（prd §7.6）。
 */
export async function readCookies(userId: number, tx: Executor = db): Promise<CookieTotals> {
  const [balanceRow] = await tx
    .select({ balance: users.cookies })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  const [totalRow] = await tx
    .select({ total: sql<number | null>`SUM(CASE WHEN ${cookieLedger.delta} > 0 THEN ${cookieLedger.delta} ELSE 0 END)` })
    .from(cookieLedger)
    .where(eq(cookieLedger.userId, userId))

  return {
    total: Number(totalRow?.total ?? 0),
    balance: balanceRow?.balance ?? 0,
  }
}

/**
 * ⭐⭐ **入账** —— 加余额 + 记一笔流水。⚠️ 必须在调用方的事务里跑。
 *
 * ⚠️⚠️ **快照不在这里写**：`submissions.cookies_earned / cookie_meta` 由调用方
 *    （settle.ts）在那条**带 `IS NULL` 守卫**的更新里一起写 ——
 *    幂等的关键就是"只有还没结算过的那一次能写进去"，
 *    把这个判断拆成两处，重复结算就会重复加余额（而且不报错，最难发现）。
 *
 * ⚠️ 这里的第二道保险是流水上的 `unique(reason, ref_type, ref_id, user_id)`。
 * ⚠️ `earned === 0` 时**什么都不做**（没攻克就没有账要记）。
 */
export async function grantCookies(
  tx: Executor,
  input: { userId: number; submissionId: string; earned: number },
): Promise<void> {
  if (input.earned <= 0) return

  await tx
    .update(users)
    .set({ cookies: sql`${users.cookies} + ${input.earned}` })
    .where(eq(users.id, input.userId))

  await tx
    .insert(cookieLedger)
    .values({
      userId: input.userId,
      delta: input.earned,
      reason: 'conquer',
      refType: 'submission',
      refId: input.submissionId,
    })
    .onDuplicateKeyUpdate({ set: { delta: sql`${cookieLedger.delta}` } })
}

/**
 * ⭐ 把落库的 `cookie_meta`（JSON）解析出来。
 *
 * ⚠️⚠️ **绝不抛**：这是历史数据，可能是老版本写的、也可能被手工改坏。
 *    解析失败就当"没有依据"（各字段走兜底），**不要让一个人看不懂自己结果页的
 *    原因变成整个接口 500**。
 */
function parseCookieMeta(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const v: unknown = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * ⭐ 把一条 submission 的快照还原成接口形状 —— 端侧只用它做两件事：
 *    · 显示 `+N 🍪`（`earned > 0` 时）；
 *    · 显示「还差 X 分」（`pointsToConquer(score, passLine)`）。
 *
 * ⚠️ `passLine` 兜底成 `COOKIE_PASS_LINE`（85）而不是 0：
 *    依据丢了的时候，"还差多少"宁可算得保守一点，也不要显示成"已经攻克但没给饼干"。
 */
export function cookieAwardViewOf(row: {
  cookiesEarned: number | null
  cookieMeta: string | null
}): CookieAwardView {
  const meta = parseCookieMeta(row.cookieMeta)
  return {
    earned: row.cookiesEarned ?? 0,
    passLine: num(meta.passLine) ?? COOKIE_PASS_LINE,
    base: num(meta.base) ?? 0,
    rankFactor: num(meta.rankFactor) ?? 1,
  }
}

/**
 * ⭐⭐ **吃饼干补充能量** —— 40 块换 1 点（`COOKIES_PER_ENERGY`）。
 *
 * ## 为什么只能单向（饼干 → 能量），不能反过来
 *
 * 🍪 是**资源**、能量是**行动力**：吃饼干补体力说得通，把体力变回饼干说不通
 * （prd §7.7 的隐喻是刻意的）。⚠️ 而且双向兑换会开出套利空间。
 *
 * ## 为什么是"一次换完"而不是让用户填数量
 *
 * ⚠️ 能量比饼干**更通用**：它能读句子、也能补签；而饼干只有这一个用途。
 *    ⇒ 留着饼干没有任何好处，"换完"就是最优解，让用户选数量只是白加一步。
 *    ⚠️ 按钮文案要把**换多少**说清楚（"换 8 点、用掉 320 块"），
 *    而不是一个含糊的"兑换"。
 *
 * ## 两个账本必须同事务
 *
 * ⚠️⚠️ 扣饼干（cookie_ledger）与加能量（energy_ledger + users.energy）
 *    要么一起成功、要么一起失败。**只成功一半 = 用户的钱凭空没了** ——
 *    而这种错没有任何东西看起来是坏的。
 *
 * ⚠️ 幂等：两个账本各用 `(reason, refType, refId, userId)` 挡重，
 *    `refId` 用调用方给的 `requestId`（客户端按一次按钮生成一个）——
 *    重试 / 连点都不会换两次。
 */
export async function exchangeCookiesForEnergy(
  userId: number,
  requestId: string,
): Promise<ExchangeResponse> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({ cookies: users.cookies, energy: users.energy })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
      .limit(1)

    const cookies = row?.cookies ?? 0
    const gained = energyFromCookies(cookies)

    // 不够换 1 点 ⇒ 什么都不做（⚠️ 不报错，让端侧说"再攒攒"）
    if (gained <= 0) {
      const totals = await readCookies(userId, tx)
      return {
        ok: false,
        energyGained: 0,
        cookiesSpent: 0,
        cookies: totals,
        energy: row?.energy ?? 0,
        reason: 'not-enough-cookies',
      }
    }

    const spent = gained * COOKIES_PER_ENERGY

    // ① 扣饼干（余额 + 流水）
    await tx.update(users).set({ cookies: cookies - spent }).where(eq(users.id, userId))
    await tx.insert(cookieLedger).values({
      userId,
      delta: -spent,
      reason: 'exchange',
      refType: 'exchange',
      refId: requestId,
    })

    /**
     * ② 加能量 —— 走 energy.ts 的 `addEnergy(tx, …)`。
     *
     * ⚠️⚠️ **必须用 `addEnergy`（接受事务的那个），不能用 `grantEnergy`**：
     *    后者内部**自己开一个事务**（`db.transaction(tx => addEnergy(tx, …))`）——
     *    在别人的事务里调它，两笔写入就**不在同一个事务**里了。
     *    后果是：我的事务一旦回滚，**能量已经加到账上了**，而饼干没扣 ⇒ 白送。
     *    这正是本函数头那段说的"只成功一半"，而且它没有任何东西看起来是坏的。
     *
     * ⚠️ 走 energy.ts 而不是在这里直接改 users.energy：那一列的写入方只能是
     *    energy.ts（所有权守卫盯着这件事，而它拦得对）。
     */
    await addEnergy(tx, {
      userId,
      amount: gained,
      reason: ENERGY_REASON.exchange,
      refType: 'exchange',
      refId: requestId,
    })

    const totals = await readCookies(userId, tx)
    return {
      ok: true,
      energyGained: gained,
      cookiesSpent: spent,
      cookies: totals,
      /**
       * ⚠️ 直接 `锁里读到的余额 + 换到的点数`，**不要再去 readEnergy** ——
       *    那个函数会先跑一次「每日补足」（一次写），在别人的事务里再开写不合适；
       *    而且 grantEnergy 正是按 `energy + amount` 写的，这里算出来与库里的值一致。
       */
      energy: (row?.energy ?? 0) + gained,
    }
  })
}

/**
 * ⭐ **饼干页的数据**：两个位置的余额 + 一页流水（游标分页）。
 *
 * ⚠️ 与能量页那份**同一套分页形状**（游标 = 上一条的 id，倒序）——
 *    两页的翻页行为必须一样，否则用户会以为其中一页坏了。
 * ⚠️ `nextBefore` 只在**刚好取满一页**时才给：少取一条就说明到底了
 *    （比 `COUNT(*)` 便宜，也不会在翻页时出现"空跑一页"）。
 */
export async function readCookieLedger(
  userId: number,
  limit: number,
  before: number | null,
  tx: Executor = db,
): Promise<CookiesResponse> {
  const rows = await tx
    .select()
    .from(cookieLedger)
    .where(
      before === null
        ? eq(cookieLedger.userId, userId)
        : and(eq(cookieLedger.userId, userId), lt(cookieLedger.id, before)),
    )
    .orderBy(desc(cookieLedger.id))
    .limit(limit)

  return {
    cookies: await readCookies(userId, tx),
    items: rows.map((r) => ({
      id: r.id,
      delta: r.delta,
      reason: r.reason,
      refType: r.refType,
      refId: r.refId,
      createdAt: r.createdAt.toISOString(),
    })),
    nextBefore: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
  }
}
