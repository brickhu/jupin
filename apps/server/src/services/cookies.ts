import { and, desc, eq, lt, ne, sql } from 'drizzle-orm'
import {
  COOKIE_PASS_LINE,
  COOKIES_PER_ENERGY,
  cookieAwardOf,
  energyFromCookies,
  type ArticleLevel,
  type CookieAward,
  type CookieAwardView,
  type CookieView,
  type CookiesResponse,
  type ExchangeResponse,
} from '@jushuo/shared'

import { db, type Executor } from '../db'
import { ENERGY_REASON, addEnergy } from './energy'
import { articles, cookieLedger, participations, submissions, users } from '../db/schema'

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
  input: { userId: number; submissionId: string; participationId?: string | null; earned: number },
): Promise<boolean> {
  if (input.earned <= 0) return false

  /**
   * ⚠️⚠️ **先查重，再锁用户行，最后才写** —— 顺序和理由都照抄 services/energy.ts 的 addEnergy。
   *
   * ## 为什么不能用 affectedRows 判（我第一版就是这么写的，**实测重复发了** ✗）
   *
   * 第一版：先 `INSERT ... ON DUPLICATE KEY UPDATE delta = delta`，再看 affectedRows 是不是 1。
   * 理论上"值没变 ⇒ 0" —— 实测不成立：**第二次领取照样把余额加了 10** ⇒ 用户白拿一倍 ✗
   * ⚠️ energy.ts 顶上那句注释早就写着这一课：「要靠 affectedRows 判断，**很容易漏**」。
   *    我又踩了一遍。
   *
   * ## 正确做法
   *   ① SELECT 查 (reason, refType, refId, userId) 有没有 —— 有就说明**发过了** ⇒ 直接返回 false
   *   ② **锁住这个用户那一行**（FOR UPDATE）—— 两个并发请求在这里**串行化**，
   *      否则①②之间存在竞态：两边都查到"没有"，然后各插一次（唯一键只挡住第二条 insert，
   *      而余额已经加了两遍 ✗）
   *   ③ 加余额 + 插账本
   */
  const [dup] = await tx
    .select({ id: cookieLedger.id })
    .from(cookieLedger)
    .where(
      and(
        eq(cookieLedger.reason, 'conquer'),
        eq(cookieLedger.refType, 'submission'),
        eq(cookieLedger.refId, input.submissionId),
        eq(cookieLedger.userId, input.userId),
      ),
    )
    .limit(1)
  if (dup) return false

  // ⭐ 锁住用户行：并发领取在这条 SELECT ... FOR UPDATE 上排队（详见上面那段）
  const [locked] = await tx
    .select({ cookies: users.cookies })
    .from(users)
    .where(eq(users.id, input.userId))
    .for('update')
    .limit(1)
  if (!locked) return false

  await tx
    .update(users)
    .set({ cookies: sql`${users.cookies} + ${input.earned}` })
    .where(eq(users.id, input.userId))

  await tx.insert(cookieLedger).values({
    userId: input.userId,
    delta: input.earned,
    reason: 'conquer',
    refType: 'submission',
    refId: input.submissionId,
    // ⭐ 记下"这一笔属于哪一次参与" —— 账本按参与/句子汇总要用（见 schema 里的说明）
    participationId: input.participationId ?? null,
  })

  return true
}

/**
 * ⭐⭐ **领取这一把的饼干**（用户 2026-10 定：改成"点了那颗按钮才发放"）。
 *
 * ## 为什么发放要跟"看到结果"绑在一起
 *
 * 饼干是"攻克"的奖赏，而**攻克这件事要被看见才算数** ——
 * 用户点下那颗状态胶囊 = "我看到了，这一把结束"，那一刻才入账 ✓
 *
 * ⚠️⚠️ 但它**不能只认那一个点击**：用户还有另一条路离开结果态 ——
 *    **直接开始下一次录音**（reading.ts 的 startRecording 会清掉结果缓存）。
 *    若只在点击时发放，走那条路的人**永远拿不到** ✗ —— 那是最糟的失败方式
 *    （他确实攻克了，规则也判了，只是没点那颗钮）。
 *    ⇒ 所以调用方在**"结果被收起来"的任意一条路上**都要调这个函数。
 *
 * ⚠️ **幂等**：`grantCookies` 靠账本唯一键 + affectedRows 保证重复调用不会多发 ✓
 *    ⇒ 两条路都调、或者连点两下，都只会发一次 ✓
 *
 * ⚠️ 金额**不在这里算**：结算时已经算好并落进 `submissions.cookies_earned`
 *    （那是"这一把该得多少"的唯一事实）。这里只负责"发"。
 *
 * @returns null = 这条提交不存在 / 不属于这个人（调用方回 404）
 */
export async function claimCookies(
  userId: number,
  submissionId: string,
): Promise<{ claimed: number; cookies: CookieView } | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        earned: submissions.cookiesEarned,
        participationId: submissions.participationId,
      })
      .from(submissions)
      .where(and(eq(submissions.id, submissionId), eq(submissions.userId, userId)))
      .limit(1)

    if (!row) return null

    /**
     * ⚠️ 结算还没跑完（cookiesEarned 为 null）时**什么都不发**：
     *    那说明这一把还没出分，页面根本没到结果态 —— 这时候"领"是没有依据的。
     *    返回 0 而不是报错：调用方可能只是抢跑了一帧。
     */
    const earned = row.earned ?? 0
    const granted = await grantCookies(tx, {
      userId,
      submissionId,
      participationId: row.participationId,
      earned,
    })

    /**
     * ⚠️⚠️ 回的是"**这一次真的发了多少**"，不是"这一把该得多少" ✗
     *
     * 重复领取时 `grantCookies` 会返回 false（查重挡住了）⇒ 这里必须是 0 ✓
     * ⚠️ 我第一版回的是 `earned` ⇒ 客户端每次都会看到 `claimed: 10`，
     *    于是它会**把"这一句共攒了多少"再加 10** ✗✗ —— 余额没重复发，
     *    但页面上那个总数会一路虚涨（比余额错更难发现）。
     */
    return { claimed: granted ? earned : 0, cookies: await readCookies(userId, tx) }
  })
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
    /**
     * ⚠️⚠️ **先查这一笔换过没有** —— 2026-10 实测漏了它，后果是**重试直接 500**：
     *
     *     Duplicate entry 'exchange-exchange-<requestId>-<userId>'
     *     for key 'cookie_ledger.cookie_ledger_idem_idx'
     *
     * ⚠️ 而客户端**本来就会重试**（`requestWithRetries`）⇒ 一次网络抖动
     *    就会变成用户看到的"服务端错误"。
     * ⚠️ `addEnergy` 有自己的查重（返回 false），但**饼干这一侧的插入没有** ——
     *    所以必须在最前面挡一次，两道都在才叫真的幂等。
     *
     * ⭐ 幂等的正确语义是「**同一个请求返回同一个结果**」：所以这里把原来那笔的
     *    数额读回来照原样回，而不是回一个 `ok:false`（那会让客户端以为这次没成，
     *    而钱其实早就扣了）。
     */
    const [done] = await tx
      .select({ delta: cookieLedger.delta, id: cookieLedger.id })
      .from(cookieLedger)
      .where(
        and(
          eq(cookieLedger.userId, userId),
          eq(cookieLedger.reason, 'exchange'),
          eq(cookieLedger.refType, 'exchange'),
          eq(cookieLedger.refId, requestId),
        ),
      )
      .limit(1)

    if (done) {
      const spent = Math.abs(done.delta)
      const [now] = await tx
        .select({ cookies: users.cookies, energy: users.energy })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return {
        ok: true,
        // ⚠️ 数额从**那一笔流水**推回来：换算是确定的（每 40 块 1 点），不另存一列
        energyGained: Math.floor(spent / COOKIES_PER_ENERGY),
        cookiesSpent: spent,
        cookies: await readCookies(userId, tx),
        energy: now?.energy ?? 0,
      }
    }

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
  /**
   * ⚠️⚠️ **LEFT JOIN submissions** 取「成就发生的时刻」。
   *
   * 为什么要这一列：**兜底清扫会补跑结算** —— 一条 9/28 的提交可能在 10/6 才被补上
   * （进程死在写分数与结算之间）。只用 `cookie_ledger.created_at` 的话，
   * 那行显示"刚刚"，而用户以为自己刚读的那次（54 分）发了 10 块 ⇒
   * **看起来像规则算错了**，其实那条提交本来就得了 90.3 分。
   * ⇒ 端侧显示 `achievedAt`（缺了才退回 `createdAt`）。
   *
   * ⚠️ 用 LEFT JOIN 不是 INNER：换能量/运营调整那些行没有对应的提交，
   *    INNER 会把它们**整行丢掉**（流水少一条比时间不准严重得多）。
   */
  const rows = await tx
    .select({
      id: cookieLedger.id,
      delta: cookieLedger.delta,
      reason: cookieLedger.reason,
      refType: cookieLedger.refType,
      refId: cookieLedger.refId,
      createdAt: cookieLedger.createdAt,
      /** 只有 refType='submission' 的行才接得上 */
      achievedAt: submissions.createdAt,
      score: submissions.score,
    })
    .from(cookieLedger)
    .leftJoin(submissions, eq(submissions.id, cookieLedger.refId))
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
      // ⚠️ 没有对应提交（换能量 / 运营）时不给这两个键，而不是给 null —— 见契约里的说明
      ...(r.achievedAt ? { achievedAt: r.achievedAt.toISOString() } : {}),
      ...(r.score === null || r.score === undefined ? {} : { score: Number(r.score) }),
    })),
    nextBefore: rows.length === limit ? (rows[rows.length - 1]?.id ?? null) : null,
  }
}

/**
 * ⭐⭐ **这一句我一共攒了多少饼干**（用户 2026-10 定）—— 朗读页要显示它。
 *
 * ⚠️ 口径是「**这一句**」，不是「这一局」：
 *    同一句话会在**不同的参与**里被反复挑战（每次都是一局新的），
 *    而用户想问的是"这句我总共练出来多少" ⇒ 按 **article** 汇总 ✓
 *    （账本上记的是 participation_id，所以这里要 JOIN 回 submissions 拿 article_id；
 *      见 schema 里"为什么记 participation 而不是 article"那段 —— 两个维度都推得出来。）
 *
 * ⚠️ 只算 `conquer`（读出来的）：换能量 / 运营调整那些行**不是"攒"出来的 ✗**
 * ⚠️ 只算**已领取**的（账本里有行 = 已发放）——
 *    没点结果那颗钮的还在 `submissions.cookies_earned` 里躺着，不算"攒到" ✓
 */
export async function sentenceCookiesOf(
  userId: number,
  articleId: string,
  tx: Executor = db,
): Promise<number> {
  /**
   * ⭐⭐ **读物化列，不现算**（⭐ 用户 2026-10-09 指出 ✓）
   *
   * ⚠️ 原来是 `SUM(cookie_ledger.delta) JOIN submissions` ✗ ——
   *    一个**带 JOIN 的聚合查询** ✓，而它算出来的那个数
   *    ⭐ **早就在 `participations.cookies` 里** ✓✓
   *    （⭐ 迁移 0060 的头注释原话：「participations.cookies 这一句累计（派生，可整表重建）」✓）
   *    ⇒ ⭐ 现在是一次按 (userId, articleId) 的点查 ✓ 无 JOIN 无聚合 ✓
   *
   * ⚠️⚠️ **为什么这样换是安全的**（⭐ 换成物化列最大的风险是"读到旧值" ✗）：
   *    `services/scoring.ts` 在**出分之后立刻** `await syncParticipation(...)` ✓
   *    ⇒ ⭐ 任何"已经出过分"的时刻，这一列都已经是新的 ✓✓
   *    ⚠️ 而两个调用点都在出分之后（⭐ 提交状态 · 朗读页进来拉一次 ✓）
   *
   * ⚠️ 参与行不存在时给 0 ✓：⭐ 那是"这一句还没挑战过"✓ ——
   *    ⚠️ 与"真的 0 个"同一种表现 ✓（⭐ 端侧 `> 0` 才画那行 ✓ prd §7.6 ✓）
   */
  const [row] = await tx
    .select({ cookies: participations.cookies })
    .from(participations)
    .where(and(eq(participations.userId, userId), eq(participations.articleId, articleId)))
    .limit(1)
  return Number(row?.cookies ?? 0)
}
