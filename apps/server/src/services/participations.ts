import { and, asc, count, desc, eq, max, min, or } from 'drizzle-orm'

import { db } from '../db'
import { plainWordsOf } from '@jushuo/shared'
import type { ArticleTheme, ArticleWordItem, ParticipationRecord } from '@jushuo/shared'
import { getRank } from './leaderboard'

import { articles, participations, submissions } from '../db/schema'

/**
 * ⭐⭐ **参与记录的唯一写入方**。
 *
 * 层级（用户 2026-09 定）：竞技场（一篇正文）⊃ 参与记录（一人一行）⊃ 挑战记录（submissions）。
 * 真相永远在 submissions；participations 是**派生索引** —— 与 articles.difficulty /
 * articles.difficulty 同一套路（见 services/article-index.ts 的说明）：
 *   · **只由这里写**；
 *   · **随时可整表重建**，重建前后必须一模一样（rebuildParticipations 的 check 模式就是这条判据）。
 *
 * ⚠️⚠️ **重算，不是累加**：每次挑战结算后拿 submissions 现算**整行**再 upsert。
 *    所以重试 / 重放 / 打分被接管重跑都是**幂等**的，也不会出现
 *    「自增漏了一次就永远差一」这种只有对账才能发现的漂移 ——
 *    0034 删掉的 participant_count / conquered_count 正是那样坏掉的。
 *
 * ⚠️ 口径与 conquest 一致：**只算 status = scored 的挑战** ——
 *    「音频读不出来 / 引擎判无效」那几次不算参与。
 * ⚠️ **对比标准**（bestSubmissionId）= 按榜单的三键全序
 *    （分数降序 → 首次达到该分的时刻升序 → id 升序）取第一条。
 *    所以「我拿什么去比」与「我在榜上排第几」共用同一个定义，不可能各说各话。
 */

/** 库句柄 —— 可注入，理由同 services/article-index.ts 的 Database */
type Database = typeof db

/** 参与记录的一行（不含任何时间戳以外的派生） */
export interface ParticipationRow {
  userId: number
  articleId: string
  attempts: number
  bestScore: string
  worstScore: string
  firstAt: Date
  lastAt: Date
  lastScheduleDate: string | null
  bestSubmissionId: string
  reachedAt: Date
  /**
   * ⭐ 这一句的**原文快照**（用户 2026-09 要求）—— 参与列表靠它自足：
   *    句子没上线 / 内容改过 / 被删，列表照样显示「我当时读的是哪句」。
   *    ⚠️ 只在重算时刷新；句子查不到时退回表里已有的值（见 computeParticipation）。
   */
  text: string | null
  /**
   * ⭐ 这一句的**词表快照**（用户 2026-09 要求：「participation 应该快照的（是）words」）。
   * ⚠️ 参与列表的「多少个词」原来靠 `plainWordsOf(text).length` 回查 ——
   *    切词规则一改、或内容改了，历史卡片的词数就跟着变，而用户当时读的是旧那一份。
   * ⚠️ 与 text 同源：重算时读一次 articles.words 落下来（形状同 articles.words）。
   */
  words: ArticleWordItem[] | null
}

/** 只算这一句上「已出分」的那批挑战 —— 全文件共用，别在别处各写一遍口径 */
function scoredOf(userId: number, articleId: string) {
  return and(
    eq(submissions.userId, userId),
    eq(submissions.articleId, articleId),
    eq(submissions.status, 'scored'),
  )
}

/**
 * ⭐ **"挑战过"的口径**（用户 2026-09 定）：`scored` **或** `failed`。
 *
 * ⚠️⚠️ 为什么 `failed` 也算：它是**检测真的跑到了、并且给了结论**
 *    （"未检测到有效语音"）—— 用户确实读了一遍、系统也确实调了引擎。
 *    只算 `scored` 会直接露在界面上：卡片写"挑战 5 次"，列表里却出现"第 6 次"。
 *
 * ⚠️ 但 **best / worst / first / last 仍只按 `scored` 算**（见 `scoredOf`）——
 *    `failed` 那次没有分数，混进去会让"最低分"变成 null。
 */
function attemptedOf(userId: number, articleId: string) {
  return and(
    eq(submissions.userId, userId),
    eq(submissions.articleId, articleId),
    or(eq(submissions.status, 'scored'), eq(submissions.status, 'failed')),
  )
}

/**
 * 算出一行参与记录 —— **只读，不写**。
 * sync 与 rebuild **共用这一份**，所以「每次挑战后写下的」和「整表重建算出来的」
 * 不可能分叉。
 *
 * @returns 这一句上没有已出分的挑战时 null（调用方据此什么也不做）
 */
async function computeParticipation(
  userId: number,
  articleId: string,
  database: Database,
): Promise<ParticipationRow | null> {
  /**
   * ⚠️⚠️ **这一行只由"有分"的提交撑起来**（`scored`）—— 不改这个口径，原因很硬：
   *
   *    `participations.best_submission_id` 与 `reached_at` 是 **NOT NULL** ——
   *    "我的最高分是哪一次"必须存在。而一个**只有 failed** 的句子根本没有最高分，
   *    于是**写不出这一行**（真实事故：我一度把 attempts 改成 scored+failed，
   *    结果聚合里 best/worst 变 null，守卫抛"聚合缺字段"，整行都写不进去）。
   *
   *    ⇒ 「检测跑到了但没出分」那一次**不计入这里**；它"算一次挑战"体现在
   *      **列表**上（`/api/user/article-records` 连 failed 一起返回），
   *      卡片上的次数直接数那个列表的行数 —— 两边同一个来源，不会打架。
   */
  const [agg] = await database
    .select({
      attempts: count(),
      best: max(submissions.score),
      worst: min(submissions.score),
      firstAt: min(submissions.createdAt),
      lastAt: max(submissions.createdAt),
    })
    .from(submissions)
    .where(scoredOf(userId, articleId))

  if (!agg || Number(agg.attempts ?? 0) === 0) return null


  /**
   * ⭐ 对比标准 = 全序的第一条。
   * ⚠️ 三个键与 services/leaderboard.ts 的排序**逐字相同**：
   *    分数降序 → reachedAt 升序 → userId 升序。所以「最高分挑战」天然就是
   *    「同分时先达到的那条」，榜单的同分先后也就不用再单独解释一遍。
   */
  const [best] = await database
    .select({ id: submissions.id, createdAt: submissions.createdAt })
    .from(submissions)
    .where(scoredOf(userId, articleId))
    .orderBy(desc(submissions.score), asc(submissions.createdAt), asc(submissions.id))
    .limit(1)

  /** 最近一次挑战是从哪一天的排期进来的（显示用） */
  const [last] = await database
    .select({ scheduleDate: submissions.scheduleDate })
    .from(submissions)
    .where(scoredOf(userId, articleId))
    .orderBy(desc(submissions.createdAt), desc(submissions.id))
    .limit(1)

  if (
    !best ||
    agg.best === null ||
    agg.best === undefined ||
    agg.worst === null ||
    agg.worst === undefined ||
    !agg.firstAt ||
    !agg.lastAt
  ) {
    // attempts > 0 时上面几个聚合必然非空 —— 真到这一步说明数据坏了。
    // ⚠️ 宁可不写，也不要写半行（半行会让榜单显示一个错的分数）
    throw new Error(
      '参与记录算不出来（submissions 聚合缺字段）：user=' + userId + ' article=' + articleId,
    )
  }

    /**
     * ⭐ 取这一句的原文（快照的**取数来源**）。
     * ⚠️ 句子查不到（只有"没有任何用户数据"时才允许被删）时**不报错**，
     *    这一次给 null —— `upsertOne` 走的是 upsert，但为了不把历史快照抹成 NULL，
     *    这里沿用表里已有的值（见下面的 existingText）。
     */
    const [art] = await database
      .select({ text: articles.text, words: articles.words })
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1)

    /**
     * ⚠️ 句子查不到时**就写 null**（不报错）：这种行不该出现 ——
     *    有用户数据的句子**不允许被删**（见 services/article-delete.ts），
     *    所以 `articles` 那行一定在。真查不到时记 null 比编一个快照诚实。
     */
    const text = art?.text ?? null
    /** ⚠️ 与 text 同源、同一次读取：词表快照 */
    const words = art?.words ?? null

  return {
      text,
      words,
    userId,
    articleId,
    attempts: Number(agg.attempts),
    // ⚠️ DECIMAL 读回来是字符串，原样带过去（drizzle 的 decimal 列就要字符串）
    bestScore: String(agg.best),
    worstScore: String(agg.worst),
    firstAt: agg.firstAt,
    lastAt: agg.lastAt,
    lastScheduleDate: last?.scheduleDate ?? null,
    bestSubmissionId: best.id,
    // ⚠️ 不变量：reachedAt = 对比标准那一条的 created_at
    reachedAt: best.createdAt,
  }
}

/** 幂等写一行 */
async function upsertOne(row: ParticipationRow, database: Database): Promise<void> {
  await database
    .insert(participations)
    .values(row)
    .onDuplicateKeyUpdate({
      set: {
        attempts: row.attempts,
        bestScore: row.bestScore,
        worstScore: row.worstScore,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        lastScheduleDate: row.lastScheduleDate,
        bestSubmissionId: row.bestSubmissionId,
        reachedAt: row.reachedAt,
        text: row.text,
        words: row.words,
      },
    })
}

/**
 * ⭐ **每次挑战结算后调用** —— 参与记录唯一的生产入口（见 services/scoring.ts）。
 *
 * ⚠️ 结算前那一条还是 scoring / 失败的，口径上不算参与 ⇒ 这里会直接返回、不写。
 */
export async function syncParticipation(
  userId: number,
  articleId: string,
  database: Database = db,
): Promise<void> {
  const row = await computeParticipation(userId, articleId, database)
  if (!row) return
  await upsertOne(row, database)
}

export interface ParticipationMismatch {
  userId: number
  articleId: string
  what: string
  expected: string
  actual: string
}

export interface RebuildResult {
  /** 算出来的参与记录条数 */
  computed: number
  /** 实际写入 / 检查的条数 */
  rows: number
  /** 表里有、但按 submissions 不该有的（只有写入模式会删） */
  orphans: number
  mismatches: ParticipationMismatch[]
}

/** 把一行摊成可比较的字符串（Date → ISO，NaN 之类都在这里暴露） */
function flat(row: ParticipationRow | null): Record<string, string> | null {
  if (!row) return null
  return {
    attempts: String(row.attempts),
    bestScore: String(row.bestScore),
    worstScore: String(row.worstScore),
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString(),
    lastScheduleDate: String(row.lastScheduleDate),
    bestSubmissionId: String(row.bestSubmissionId),
    reachedAt: row.reachedAt.toISOString(),
    // ⚠️ 两个快照列也进对账：重建前后不一致要报出来（"派生索引"的验收判据）
    text: String(row.text ?? ''),
    words: JSON.stringify(row.words ?? null),
  }
}

/**
 * 整表重建 / 对账。
 *
 * ⚠️ 两种模式共用同一份计算：
 *   · 默认（写入）：把每个 (user, article) 重算一遍写回去，**并删掉孤儿行**
 *     （挑战记录被清掉之后留下的参与行 —— 不删的话榜单会显示"幽灵参与者"）；
 *   · check: true：**只算不写**，把与表里不一致的逐字段报出来。
 *     ⚠️ 这是它作为"派生索引"的验收判据：全量重建前后必须完全一致。
 */
export async function rebuildParticipations(
  opts: { check?: boolean; database?: Database } = {},
): Promise<RebuildResult> {
  const database = opts.database ?? db
  const check = opts.check ?? false

  /** 该有参与记录的那些 (user, article) —— 从**真相**里数出来，不是从表里读 */
  const pairs = await database
    .selectDistinct({ userId: submissions.userId, articleId: submissions.articleId })
    .from(submissions)
    .where(eq(submissions.status, 'scored'))

  const existing = await database
    .select({
      userId: participations.userId,
      articleId: participations.articleId,
      attempts: participations.attempts,
      bestScore: participations.bestScore,
      worstScore: participations.worstScore,
      firstAt: participations.firstAt,
      lastAt: participations.lastAt,
      lastScheduleDate: participations.lastScheduleDate,
      bestSubmissionId: participations.bestSubmissionId,
      reachedAt: participations.reachedAt,
      // ⚠️ 两个快照列必须在这里也选出来：漏了的话对账会拿 undefined 去比，
      //    报出"expected 有值 / actual 空"的假不一致（我第一次就漏了）
      text: participations.text,
      words: participations.words,
    })
    .from(participations)

  const stored = new Map<string, Record<string, string>>()
  for (const r of existing) {
    stored.set(r.userId + ':' + r.articleId, {
      attempts: String(r.attempts),
      bestScore: String(r.bestScore),
      worstScore: String(r.worstScore),
      firstAt: r.firstAt.toISOString(),
      lastAt: r.lastAt.toISOString(),
      lastScheduleDate: String(r.lastScheduleDate),
      bestSubmissionId: String(r.bestSubmissionId),
      reachedAt: r.reachedAt.toISOString(),
      text: String(r.text ?? ''),
      words: JSON.stringify(r.words ?? null),
    })
  }

  let computed = 0
  let rows = 0
  const mismatches: ParticipationMismatch[] = []

  for (const p of pairs) {
    const expected = await computeParticipation(p.userId, p.articleId, database)
    if (!expected) continue
    computed++

    const actual = stored.get(p.userId + ':' + p.articleId)
    if (check) {
      if (!actual) {
        mismatches.push({
          userId: p.userId,
          articleId: p.articleId,
          what: '整行缺失',
          expected: JSON.stringify(flat(expected)),
          actual: '(表里没有)',
        })
        continue
      }
      for (const [what, want] of Object.entries(flat(expected) ?? {})) {
        const got = actual[what] ?? ''
        if (got !== want) {
          mismatches.push({ userId: p.userId, articleId: p.articleId, what, expected: want, actual: got })
        }
      }
      continue
    }

    await upsertOne(expected, database)
    rows++
  }

  let orphans = 0
  if (!check) {
    const want = new Set(pairs.map((p) => p.userId + ':' + p.articleId))
    for (const key of stored.keys()) {
      if (want.has(key)) continue
      orphans++
      const [userId, articleId] = key.split(':')
      await database
        .delete(participations)
        .where(and(eq(participations.userId, Number(userId)), eq(participations.articleId, String(articleId))))
    }
  }

  return { computed, rows, orphans, mismatches }
}

/**
 * ⭐⭐ **一条 ParticipationRecord**（一人一句）—— 列表与单取**共用同一个投影**。
 *
 * ⚠️⚠️ 为什么要有这个函数：`GET /api/user/participations`（列表）与
 *    `GET /api/user/participation/{articleId}`（单取）回答的是**同一个事实**。
 *    两处各写一遍映射，迟早出现"列表说读了 3 次、单取说 1 次"这种同一屏自相矛盾。
 *    ⇒ 口径（原文取快照、词数优先用快照、名次跨用户现算）只留这一份。
 *
 * ⚠️ 原始行的列名与 drizzle 的 select 别名一一对应（`best` / `worst` 是别名）。
 * ⚠️ DECIMAL 读回来是**字符串** ⇒ 一律 Number()；`lastAt` 可能是字符串或 Date。
 */
export interface ParticipationRecordSource {
  articleId: string
  attempts: number
  /** DECIMAL，drizzle 读回来是字符串 */
  best: string | number | null
  /** 同上 */
  worst: string | number | null
  lastAt: Date | string
  lastScheduleDate: string | null
  /** 这一句的原文**快照**（历史自足：句子下线/改过也要认得出当时读的是哪句） */
  text: string | null
  /** 词表**快照**；老记录没有 ⇒ 退回用 text 现算 */
  words: unknown
  theme: ArticleTheme | null
}

/** 参与行 + 名次 → ParticipationRecord（两个接口唯一的映射入口） */
export function toParticipationRecord(
  row: ParticipationRecordSource,
  rankInfo: { rank: number; participantCount: number },
): ParticipationRecord {
  const text = row.text ?? ''
  return {
    articleId: row.articleId,
    text,
    /**
     * ⚠️ 词数用**快照**，不再拿 text 现算 —— 现算的话切词规则一改，
     *    历史卡片的词数就跟着变（而用户当时读的是旧那一份）。
     *    没有快照的老记录退回现算，别让卡片显示 0。
     */
    words: Array.isArray(row.words) ? row.words.length : plainWordsOf(text).length,
    attempts: Number(row.attempts ?? 0),
    bestScore: Number(row.best ?? 0),
    worstScore: Number(row.worst ?? 0),
    rank: rankInfo.rank,
    participantCount: rankInfo.participantCount,
    lastAt: new Date(row.lastAt as unknown as string).toISOString(),
    /**
     * ⭐ 最近这一次挑战属于哪一天 —— 卡片点进**竞技场**要用它。
     * ⚠️ 竞技场是按日期取场次的，所以取「最近那次挑战的 schedule_date」，
     *    而不是端侧算今天：用户参与的可能是几天前那一场。
     */
    lastScheduleDate: row.lastScheduleDate ?? '',
    theme: row.theme,
  }
}

/**
 * ⭐ 单个 (userId, articleId) 的参与记录；**没参与过返回 null**。
 *
 * ⚠️ 坚决**不编一条全 0 的假记录**：0 分是合法成绩，两者混起来客户端会把
 *    「没挑战过」显示成「最高 0 分」。
 * ⚠️ 名次（rank/participantCount）走 getRank —— 跨用户算的，端侧算不出来；
 *    与榜单、与列表接口**同源**。
 */
export async function participationRecordOf(
  userId: number,
  articleId: string,
): Promise<ParticipationRecord | null> {
  const [row] = await db
    .select({
      articleId: participations.articleId,
      attempts: participations.attempts,
      best: participations.bestScore,
      worst: participations.worstScore,
      lastAt: participations.lastAt,
      lastScheduleDate: participations.lastScheduleDate,
      text: participations.text,
      words: participations.words,
      theme: articles.theme,
    })
    .from(participations)
    .innerJoin(articles, eq(articles.id, participations.articleId))
    // ⚠️ 必须同时限 userId 与 articleId（见 routes/participation-scope.test.ts）：
    //    只按 articleId 查会把**别人**的那一行当成"我的"
    .where(and(eq(participations.userId, userId), eq(participations.articleId, articleId)))
    .limit(1)

  if (!row) return null
  return toParticipationRecord(row, await getRank(articleId, userId))
}
