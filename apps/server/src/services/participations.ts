import { and, asc, count, desc, eq, max, min, or, sum } from 'drizzle-orm'

import { db } from '../db'
import { participationIdOf } from '@jushuo/shared'
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
  /** ⭐ 对外地址（派生值，见 participationIdOf） */
  id: string
  userId: number
  articleId: string
  attempts: number
  /** ⭐ 三项成长值累计（这条参与下已出分 submissions 之和，见 schema 的说明） */
  cookies: number
  bestScore: string
  worstScore: string
  firstAt: Date
  lastAt: Date
  bestSubmissionId: string
  reachedAt: Date
  /**
   * ⭐ 这一句的**词表快照**（用户 2026-09 要求：「participation 应该快照的（是）words」）。
   * ⚠️ 它同时承载**原文**：`words[].text` 含标点，拼起来就是原句 ——
   *    所以 2026-09 把 `text` 列删了（原文是派生值，不再存第二份）。
   * ⚠️ 只在重算时刷新；句子查不到时退回表里已有的值（见 computeParticipation）。
   */
  words: ArticleWordItem[] | null
  /** ⭐ 与 words 同源同一次读取的**连读标注快照**（`links[i]` 描述 words[i]→words[i+1]） */
  links: string[] | null
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
      /**
       * ⭐⭐ 三项**成长值累计**（用户 2026-09 要求）：这条参与下每次挑战各加一点，
       *    这里汇总成一行 —— 口径与 attempts 完全一致（**只算 scored**）。
       * ⚠️ 没出分的那次本来就没加成长值（成长值在 settle 时才写进 submissions），
       *    把它算进来只会凭空多出 0 或旧值。
       */
      cookies: sum(submissions.cookiesEarned),
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

  /** ⚠️ 这里原来还会查一次"最近那次挑战的 schedule_date"（last_schedule_date 那一列）——
   *  该列 2026-09 删除（没有任何读它的地方），这条查询也随之去掉。 */

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
     * ⭐ 取这一句的**快照来源**：词表 + 连读标注。
     * ⚠️ 句子查不到（只有"没有任何用户数据"时才允许被删）时**不报错**，
     *    这一次给 null；`upsertOne` 走的是 upsert，真查不到就记 null ——
     *    记 null 比编一份快照诚实。
     */
    const [art] = await database
      .select({ words: articles.words, links: articles.links })
      .from(articles)
      .where(eq(articles.id, articleId))
      .limit(1)

    /** ⚠️ 与 words 同源、同一次读取：连读标注快照 */
    const words = art?.words ?? null
    const links = art?.links ?? null

  return {
      words,
      links,
    userId,
    articleId,
    id: participationIdOf(userId, articleId),
    attempts: Number(agg.attempts),
    // ⚠️ SUM() 在 MySQL 上回来是 DECIMAL（字符串），且没有行时是 null ⇒ 一律 Number + 兜底 0
    cookies: Number(agg.cookies ?? 0),
    // ⚠️ DECIMAL 读回来是字符串，原样带过去（drizzle 的 decimal 列就要字符串）
    bestScore: String(agg.best),
    worstScore: String(agg.worst),
    firstAt: agg.firstAt,
    lastAt: agg.lastAt,
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
        // ⚠️ id 是派生值，重算必然相同 —— 但仍然写上去：万一某天算法改了，
        //    这一行会跟着修正，而不是留着一个按旧算法算出来的地址
        id: row.id,
        attempts: row.attempts,
        bestScore: row.bestScore,
        worstScore: row.worstScore,
        firstAt: row.firstAt,
        lastAt: row.lastAt,
        bestSubmissionId: row.bestSubmissionId,
        reachedAt: row.reachedAt,
        words: row.words,
        links: row.links,
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
    id: String(row.id),
    attempts: String(row.attempts),
    cookies: String(row.cookies),
    bestScore: String(row.bestScore),
    worstScore: String(row.worstScore),
    firstAt: row.firstAt.toISOString(),
    lastAt: row.lastAt.toISOString(),
    bestSubmissionId: String(row.bestSubmissionId),
    reachedAt: row.reachedAt.toISOString(),
    // ⚠️ 两个快照列也进对账：重建前后不一致要报出来（"派生索引"的验收判据）
    words: JSON.stringify(row.words ?? null),
    links: JSON.stringify(row.links ?? null),
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
      bestSubmissionId: participations.bestSubmissionId,
      reachedAt: participations.reachedAt,
      /** ⚠️ 同上：对账要逐字段比，id 与三项成长值不选出来就会报假不一致 */
      id: participations.id,
      cookies: participations.cookies,
      // ⚠️ 两个快照列必须在这里也选出来：漏了的话对账会拿 undefined 去比，
      //    报出"expected 有值 / actual 空"的假不一致（我第一次就漏了）
      words: participations.words,
      links: participations.links,
    })
    .from(participations)

  const stored = new Map<string, Record<string, string>>()
  for (const r of existing) {
    stored.set(r.userId + ':' + r.articleId, {
      /** ⚠️ 这里和上面那个 select 是**两处**：选出来了还要在映射里放进去，
       *  漏了就会报「expected 有值 / actual 空」的假不一致（id 上我正好又踩了一次） */
      id: String(r.id),
      attempts: String(r.attempts),
      cookies: String(r.cookies),
      bestScore: String(r.bestScore),
      worstScore: String(r.worstScore),
      firstAt: r.firstAt.toISOString(),
      lastAt: r.lastAt.toISOString(),
      bestSubmissionId: String(r.bestSubmissionId),
      reachedAt: r.reachedAt.toISOString(),
      words: JSON.stringify(r.words ?? null),
      links: JSON.stringify(r.links ?? null),
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

  /**
   * ⭐⭐ 顺带核对 / 修复 `submissions.participation_id` —— 它是**派生列**，
   *    按同一个式子（shared 的 participationIdOf）现算，不依赖参与行是否存在。
   *
   * ⚠️ 为什么必须有这一段：这一列没有外键兜底（提交先于参与行存在，加了外键就写不进去），
   *    所以"写歪了"只能靠这里发现并修回来 —— 老代码写的、手改的、迁移出错的，都归它管。
   * ⚠️ 它是这一列的**唯一读者**（见 db/schema.ts 的说明），也是它敢存在的理由。
   */
  const links = await database
    .select({
      id: submissions.id,
      participationId: submissions.participationId,
      userId: submissions.userId,
      articleId: submissions.articleId,
    })
    .from(submissions)

  for (const l of links) {
    const want = participationIdOf(l.userId, l.articleId)
    if (l.participationId === want) continue
    /**
     * ⚠️ 只有 **check 模式**才报出来（与上面 participations 那段同一套写法）：
     *    apply 模式是"把它改对"，改对了就不再是"不一致" —— 报出来会让
     *    `pnpm db:participations --apply` 永远以失败退出，运维就分不清
     *    "修好了" 和 "修不动" 了（我第一版就是这么写的，实测才发现）。
     */
    if (check) {
      mismatches.push({
        userId: l.userId,
        articleId: l.articleId,
        what: `submissions.participation_id（${l.id}）`,
        expected: want,
        actual: l.participationId,
      })
      continue
    }
    await database.update(submissions).set({ participationId: want }).where(eq(submissions.id, l.id))
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
  /** ⭐ 三项成长值累计（这条参与下已出分 submissions 之和） */
  /** ⭐ 这条参与累计赚到的饼干 */
  cookies: number
  /** DECIMAL，drizzle 读回来是字符串 */
  best: string | number | null
  /** 同上 */
  worst: string | number | null
  lastAt: Date | string
  /** 词表**快照**（同时是原文的来源：`words[].text` 拼起来就是原句） */
  words: unknown
  /** ⭐ 对外地址（派生值，见 participationIdOf） */
  id: string
  /** 连读标注**快照**（与 words 一一对应；老记录没有 ⇒ 空数组） */
  links: unknown
  /**
   * ⭐ `articles.text`（**不是快照**）—— 只用于"词表快照为空"时的**兜底原文**。
   * ⚠️ 有 3 篇内容的 `articles.words` 是空的（内容缺口），那种句子拼不出原文，
   *    只能现取一次 articles.text（路由本来就 join 了 articles）。
   */
  articleText?: string | null
  theme: ArticleTheme | null
}

/** 参与行 + 名次 → ParticipationRecord（两个接口唯一的映射入口） */
export function toParticipationRecord(
  row: ParticipationRecordSource,
  rankInfo: { rank: number; participantCount: number },
): ParticipationRecord {
  /**
   * ⚠️ **直接给快照本身**（2026-09 改）：以前这里只给一个词数（`words.length`），
   *    而原文又要靠另一个 `text` 列 —— 于是同一件事有两份数据，还闹出过
   *    「快照是空数组 ⇒ 词数显示 0」的 bug（`Array.isArray([])` 为真，兜底走不到）。
   *    现在：`words`（含标点，**端侧拼出原文**）+ `links`（连读标注）。
   */
  const words = Array.isArray(row.words) ? (row.words as ArticleWordItem[]) : []
  const links = Array.isArray(row.links) ? (row.links as string[]) : []
  /**
   * ⚠️⚠️ **兜底**：词表快照为空（内容缺口，`articles.words = []`）时，
   *    端侧拼不出任何字 ⇒ 这时才把 `articles.text` 现取一次带上（**不落库**）。
   *    ⚠️ 只有这一种情况会给 `text` —— 正常行**没有**这个字段，
   *      免得它变成第二份原文（那正是这轮删掉的东西）。
   */
  const fallbackText =
    words.length === 0 && row.articleText ? { text: row.articleText } : {}

  return {
    id: row.id,
    articleId: row.articleId,
    /**
     * ⭐ 这一句累计赚到的饼干（与 users.cookies 同一套口径）。
     * ⚠️ 公开接口也给：成长值本来就是公开的（/api/profile/{id} 就展示这三项）。
     */
    cookies: Number(row.cookies ?? 0),
    words,
    links,
    ...fallbackText,
    attempts: Number(row.attempts ?? 0),
    bestScore: Number(row.best ?? 0),
    worstScore: Number(row.worst ?? 0),
    rank: rankInfo.rank,
    participantCount: rankInfo.participantCount,
    lastAt: new Date(row.lastAt as unknown as string).toISOString(),
    theme: row.theme,
  }
}

/**
 * ⭐ **按地址取一行**（`GET /api/participation/{id}` 用）—— 地址就是 participations.id。
 *
 * ⚠️ 与 participationRecordOf 共用同一套映射（toParticipationRecord）与同一个名次来源
 *    （getRank，跨用户算的），所以"从榜单点进来"看到的数就是榜上那一行的数。
 * ⚠️ 没有这一行 ⇒ null（**不是**一条全 0 的假记录）。
 */
export async function participationRecordById(
  participationId: string,
): Promise<ParticipationRecord | null> {
  const [row] = await db
    .select({
      id: participations.id,
      articleId: participations.articleId,
      userId: participations.userId,
      attempts: participations.attempts,
      cookies: participations.cookies,
      best: participations.bestScore,
      worst: participations.worstScore,
      lastAt: participations.lastAt,
      words: participations.words,
      links: participations.links,
      /** ⚠️ 只用于"词表快照为空"时的兜底原文（不落库，见 toParticipationRecord） */
      articleText: articles.text,
      theme: articles.theme,
    })
    .from(participations)
    .innerJoin(articles, eq(articles.id, participations.articleId))
    .where(eq(participations.id, participationId))
    .limit(1)

  if (!row) return null
  return toParticipationRecord(row, await getRank(row.articleId, row.userId))
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
      id: participations.id,
      articleId: participations.articleId,
      attempts: participations.attempts,
      best: participations.bestScore,
      worst: participations.worstScore,
      /** ⭐ 这一句累计赚到的饼干（与列表、详情同一份口径） */
      cookies: participations.cookies,
      lastAt: participations.lastAt,
      words: participations.words,
      links: participations.links,
      /** ⚠️ 只用于"词表快照为空"时的兜底原文（不落库，见 toParticipationRecord） */
      articleText: articles.text,
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
