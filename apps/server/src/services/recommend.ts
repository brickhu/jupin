import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import { dayNumber, dayStartUtc, normalizeLevel } from '@jushuo/shared'
import type { ArticleLevel } from '@jushuo/shared'
import { db } from '../db'
import { articles, participations, users } from '../db/schema'
import { hasContent } from './content'
import { getArenaStatsBatch } from './leaderboard'

/**
 * ⭐⭐ **今日推荐** —— 按参与记录**分场**，不再给所有人同一句。
 *
 * ⚠️⚠️ 与 services/schedules.ts 的分工（这是这次改动的核心）：
 *   · schedules = 「哪一天读哪一句」：运营排期 / 按天轮转，**对所有人一样**。
 *     它现在只负责「这次提交记到哪一天」；首页下半段是「最新上线」（句库按上线时间取）。
 *   · 这里 = 「**你今天适合读哪一句**」：按我的参与记录分场。
 *     ⇒ 首页那张"今日挑战"卡从这里来，不再用轮转那句。
 *
 * ⭐ 四条规则（用户 2026-09 定），**顺序就是优先级**：
 *
 *   ① **先定我的档位**（levelOf）：最近参与的句子都在哪一档，就推哪一档。
 *      长期在专家场的人不会被推回初级 —— 这正是旧轮转最鸡肋的地方。
 *   ② **同档同句**：同一档位的用户当天拿到**同一句**。不能完全千人千面 ——
 *      每个人的句子都不一样的话，就没有"竞技场"了（榜单会散成一人一张）。
 *   ③ **未读优先**（只算**今天之前**读过的）：如果这一档今天那句我**以前**参与过，
 *      就换成"我还没参与过的"。
 *      池子越小这条越关键（句子量少时，同一句几天就轮回来一次）。
 *   ④ **兜底**：该档一句都没有（内容还没铺到那一档）→ 就近换档。
 *      ⚠️ 「换了档」这件事**只记在 level / myLevel 两个字段上**（端侧要区分时自己比），
 *        曾经还拼一句 reason 显示给用户 —— 已删（见 TodayPick 的说明）。
 *
 * ⚠️ 只返回「选哪一句 + 为什么」；正文 / 统计 / 音频由路由去补
 *    （见 routes/articles.ts 的 today 路由）—— 这一层不碰内容文件。
 */

/** 库句柄 —— 可注入，理由同 services/article-index.ts 的 Database */
type Database = typeof db

/**
 * ⚠️⚠️ **这两个数是"英文水平"的定义**（用户 2026-09 亲自界定的），改这里就够了：
 *
 *   · MASTERY_SCORE 多少分算"这一档过了"
 *   · MASTERY_COUNT 要几**句**（不是几次）达到这条线才算过
 *
 * ⚠️ 记的是"句"不是"次"：参与记录是**一人一句一行**，所以"两句 ≥85"
 *    天然要求你在这一档的不同句子上都做到 —— 反复重读同一句凑不出来。
 */
const MASTERY_SCORE = 85
const MASTERY_COUNT = 2

export interface MyLevel {
  /** 我的水平档（0 初级 / 1 中级 / 2 高级 / 3 专家） */
  level: ArticleLevel
  /** 这个档位是怎么来的（人话，卡片可以直接显示，也便于排查） */
  basis: string
}

/**
 * ⚠️ 档位文案（"初级/中级/高级/专家"）—— **本文件内部在用**（下面拼推荐理由）。
 *    ⚠️ 它和 `@jushuo/shared` 的 `LEVEL_LABEL` 是**同值两份**，但这里删不掉：
 *       本文件是纯逻辑（服务端算完给一句话），而那份是给界面用的。
 *       两者要一起改 —— 或者今后把这里也换成 import 那份。
 * ⚠️ 这里原来还有一个 `levelLabelOf()`（把档位转文案）—— 2026-09 删除：
 *    全仓库零调用（是个多余的 export）。
 */
const LABEL: Record<ArticleLevel, string> = { 0: '初级', 1: '中级', 2: '高级', 3: '专家' }

/** 高 → 低，找"最高的那一档"时用 */
const DESC_LEVELS: ArticleLevel[] = [3, 2, 1, 0]

/**
 * ⭐⭐ 定我的**英文水平**。
 *
 * ⚠️⚠️ 用户 2026-09 纠正过一次概念，这里写的才是对的那个：
 *
 *     ❌ 不是「你最近老在哪个场练，就推哪个场」—— 那只是"最近去过哪儿"。
 *     ✅ 看的是**成绩单**：某一档拿到过 MASTERY_COUNT 句 MASTERY_SCORE 分以上，
 *        那一档就是你的英文水平。
 *        例：在高级场有过两次 >85 的成绩 ⇒ **高级用户**（与他在那儿读过几次无关）。
 *
 * 判定顺序：
 *   ① 从高往低扫，**最高的那一档**里"过了的句子数"够 ⇒ 就是它
 *   ② 一档都没过 ⇒ 退到**你练过的最高档**（你至少在那儿练，但还没证明）
 *   ③ 什么都没练过 ⇒ 初级（新用户）
 *
 * ⚠️ 用参与记录（rather than 逐条 submissions）是有意的：一人一句一行，
 *    "两句 ≥85"比"两条成绩 ≥85"更严 —— 重读同一句凑不出水平。
 */
export async function myLevelOf(userId: number, database: Database = db): Promise<MyLevel> {
  const rows = await database
    .select({
      // difficulty 在 articles 上（参与记录只存句子 id）—— 一次 join 拿回来
      difficulty: articles.difficulty,
      best: participations.bestScore,
    })
    .from(participations)
    .innerJoin(articles, eq(articles.id, participations.articleId))
    .where(eq(participations.userId, userId))

  if (rows.length === 0) {
    return { level: 0, basis: '还没有参与记录 —— 从初级开始' }
  }

  /** 每档：练过的句子数 / 过了线的句子数 */
  const played = new Map<ArticleLevel, number>()
  const proven = new Map<ArticleLevel, number>()
  for (const r of rows) {
    const lv = normalizeLevel(r.difficulty)
    if (lv === null) continue // 老内容没有难度 ⇒ 不进画像（不猜）
    played.set(lv, (played.get(lv) ?? 0) + 1)
    if (Number(r.best) >= MASTERY_SCORE) proven.set(lv, (proven.get(lv) ?? 0) + 1)
  }

  // ① 最高的、过了线的那一档
  for (const lv of DESC_LEVELS) {
    const n = proven.get(lv) ?? 0
    if (n >= MASTERY_COUNT) {
      return {
        level: lv,
        basis: '在' + LABEL[lv] + '场有 ' + n + ' 句拿到 ' + MASTERY_SCORE + ' 分以上 —— 你的水平在这一档',
      }
    }
  }

  // ② 没过线 ⇒ 练过的最高档
  for (const lv of DESC_LEVELS) {
    const n = played.get(lv) ?? 0
    if (n > 0) {
      return {
        level: lv,
        basis:
          '还没有哪一档拿到 ' + MASTERY_COUNT + ' 句 ' + MASTERY_SCORE + ' 分以上 —— ' +
          '先按你练过的最高档（' + LABEL[lv] + '，' + n + ' 句）',
      }
    }
  }

  // ③ 有参与记录但难度都认不出来（老内容）⇒ 兜底初级
  return { level: 0, basis: '参与过的句子没有难度信息 —— 先按初级' }
}

export interface TodayPick {
  articleId: string
  /** 实际用了哪一档（与 myLevel 不同 = 发生了兜底换档） */
  level: ArticleLevel
  /** 我原本的档位 */
  myLevel: ArticleLevel
  /** 档位是怎么来的 */
  levelBasis: string
  /**
   * ⚠️ 这里原来有一个 `reason`（"为什么是这一句"）—— **2026-09 删掉**：
   *    它承载的是下面的**选取规则**，而那是给改代码的人看的工程备注，
   *    不该出现在界面上（用户口径：「你这些信息不应该展示给用户」）。
   *    规则留在本文件顶部那段说明里。
   */
}

/** 该档的句子，顺序**必须稳定**（按 id）—— 取模结果不能让查询计划改变 */
async function bandOf(lv: ArticleLevel, database: Database): Promise<string[]> {
  const rows = await database
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.isActive, true), eq(articles.difficulty, lv)))
    .orderBy(asc(articles.id))
  return rows.map((r) => r.id)
}

/**
 * 就近换档：距离近的先试；同距离**先往下**（别把初级用户扔进专家场）。
 * ⚠️ 内容没铺满时这条会被频繁走到 —— 所以 level / myLevel 必须如实反映它。
 */
function neighborLevels(lv: ArticleLevel): ArticleLevel[] {
  const all: ArticleLevel[] = [0, 1, 2, 3]
  return all
    .filter((x) => x !== lv)
    .sort((a, b) => {
      const da = Math.abs(a - lv)
      const db2 = Math.abs(b - lv)
      if (da !== db2) return da - db2
      // 同距离先试**数值小**的（= 更简单那一档）：宁可降一点，也别把初级用户扔进专家场
      return a - b
    })
}

/**
 * ⭐⭐ 今日推荐窗口的长度 —— **以用户为单位，每 24 小时换一次**（用户 2026-09 定的口径）。
 *
 * ⚠️⚠️ 它与 shared/day.ts 的「自然日」是**两套东西**，别再混：
 *    · 自然日（北京时间 0 点切）—— streak、每日能量补足、提交归属用的还是它；
 *    · 这个 24 小时窗口 —— **只用于「首页今日挑战这一句」**。
 *    窗口的起点是**这个人第一次被分配的那一刻**（users.today_assigned_at），
 *    不是全站统一的 0 点，所以同一个人永远是「从上一次分配算起的 24 小时」。
 */
const WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * ⭐ 选今天（这一个 24 小时窗口）的这一句。
 *
 * ⚠️⚠️ 语义（2026-09 改）：
 *    · 已有分配且 now - assigned_at < 24h ⇒ **原样返回那一句**
 *      （只要文章还在、isActive；下架/删了就重新分配）；
 *    · 否则 ⇒ 按下面四条规则选一句，把 today_article_id / today_assigned_at 落库。
 *
 * ⚠️⚠️⚠️ **选句按「窗口起始日」的天号取模，不按当前时刻** —— 这是竞技场不散的根据：
 *    如果按「当前时刻」取模，那么任意两个在不同分钟开始窗口的人都会落到不同的句子上，
 *    竞技场就碎成一人一句、榜单失去可比性。
 *    按**窗口起始日**取模之后：同一天开始窗口的人拿到**同一句**；
 *    而窗口只有 24 小时，所以任意时刻每个档位**最多两句「在飞」**
 *    （昨天开始、还没到 24 小时的那句 + 今天开始的这句）。
 *    ⇒ 首页那一句只可能和另一批人在同一个竞技场里，榜单是满的。
 *
 * @param date 'YYYY-MM-DD'（服务端的今天，见 shared/day.ts）——
 *   它是**新窗口的起始日**，不是「当前时刻」。同一天分配的人取模结果相同。
 * @returns 句库一句都没有时 null（调用方按"部署问题"报 503）
 */
export async function recommendToday(
  userId: number,
  date: string,
  database: Database = db,
): Promise<TodayPick | null> {
  const me = await myLevelOf(userId, database)

  /**
   * ★ ① 先认这个用户**当前窗口里已经分到的那一句**。
   *
   * ⚠️⚠️ 这一步是这轮改动的核心，别再删：窗口内一律以**库里那一句**为准。
   *    不能因为「他刚把这一句读了」就重选 —— 那正是上一个 bug 的形状
   *    （读完返回首页，卡片当着他的面变成另一句，当天的成果也跟着没了）。
   *    「今天读了它」= 正在完成这件事，不是「该换一句」的理由。
   *
   * ⚠️ 分配过的文章**下架或删了**（isActive=false / 查不到）就作废、往下重新分配 ——
   *    否则用户会拿到一张点进去「正文加载失败」的卡。
   * ⚠️ 只看 assigned_at 与 now 的差；**不按自然日**判断（那是上一版口径）。
   */
  const [assigned] = await database
    .select({ articleId: users.todayArticleId, assignedAt: users.todayAssignedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1)

  if (assigned?.articleId && assigned.assignedAt) {
    const ageMs = Date.now() - new Date(assigned.assignedAt).getTime()
    // ⚠️ ageMs >= 0：时间戳在未来（时钟回拨等脏数据）不算「窗口内」，重新分配更安全
    if (ageMs >= 0 && ageMs < WINDOW_MS) {
      const [stillThere] = await database
        .select({ id: articles.id, difficulty: articles.difficulty })
        .from(articles)
        .where(and(eq(articles.id, assigned.articleId), eq(articles.isActive, true)))
        .limit(1)
      if (stillThere) {
        return {
          articleId: stillThere.id,
          // ⚠️ 实际档位以**这一句自己的难度**为准（分配时可能发生过兜底换档）
          level: normalizeLevel(stillThere.difficulty) ?? me.level,
          myLevel: me.level,
          levelBasis: me.basis,
        }
      }
    }
  }

  // ★ ② 该档的候选；空了就就近换档
  let level = me.level
  let pool = await bandOf(level, database)
  if (pool.length === 0) {
    for (const alt of neighborLevels(me.level)) {
      const p = await bandOf(alt, database)
      if (p.length > 0) {
        pool = p
        level = alt
        break
      }
    }
  }
  if (pool.length === 0) return null

  // ★ ③ 同档同句：**窗口起始日**的天号取模（不是当前时刻，见上面的说明）
  let pickId = pool[((dayNumber(date) % pool.length) + pool.length) % pool.length] as string
  let why = ''

  /**
   * ★ ④ 未读优先 —— 判据是「**这个窗口开始之前**读过的」，
   *    不是「今天之前」也不是「曾经读过」。
   *
   * ⚠️⚠️ 为什么必须是「窗口开始之前」，把上一版的口径讲清楚：
   *    上一版按自然日判（lastAt < dayStartUtc(date)，date = 今天），
   *    于是「今天刚读完这一句」会被判成读过 ⇒ 返回首页时规则④立刻换一句，
   *    卡片当着他的面变（这个 bug 用户报过）。
   *    现在把比较基准换成**窗口起始日的 UTC 起点**（dayStartUtc(窗口起始日)）：窗口内读的那次不算数，
   *    只有「窗口开始前就参与过这一句」才会被挪开。
   *    窗口内那一句是**固定**的，这条与上面的 ★① 一起构成那个保证。
   *
   * ⚠️ 仍然只看**这个档位的池子**：换档才需要重新判未读，别的档读了不算。
   */
  const mine = await database
    .select({ articleId: participations.articleId, lastAt: participations.lastAt })
    .from(participations)
    .where(
      and(
        eq(participations.userId, userId),
        inArray(participations.articleId, pool),
        // ⚠️ date 是窗口起始日；它的 UTC 起点就是窗口开始的自然日边界
        lt(participations.lastAt, dayStartUtc(date)),
      ),
    )
  const read = new Map(mine.map((r) => [r.articleId, r.lastAt]))

  if (read.has(pickId)) {
    const fresh = pool.filter((id) => !read.has(id))
    if (fresh.length > 0) {
      pickId = fresh[((dayNumber(date) % fresh.length) + fresh.length) % fresh.length] as string
    } else {
      // ★ ⑤ 整档都读过了 → 挑**放得最久**的那句（不是随机，也不是从头再来）
      let oldest = pickId
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, at] of read) {
        const t = new Date(at as unknown as string).getTime()
        if (t < oldestAt) {
          oldestAt = t
          oldest = id
        }
      }
      pickId = oldest
    }
  }

  /**
   * ⚠️⚠️ 这里原来会拼一句 `reason`（「这一句在你当前的 24 小时窗口里是固定的 ——
   *    窗口内不会换」/「这一档你都读过了 —— 挑了放得最久的那句」/…），
   *    端侧把它当卡片上那行小字显示 —— **那全是选取规则，是工程备注，不是给用户看的话**
   *    （用户 2026-09：「你这些信息不应该展示给用户，它是你的工作备注」）。
   *
   *    ⇒ 整段删掉，不再往外给 `reason`。选取规则留在上面的注释里（那才是它该在的地方），
   *      卡片上因此少一行小字 —— 今日挑战那张卡的头部本来就已经说了这是今天要读的句子。
   *    ⚠️ 别为了"看着空"再补一句场面话：那是同一个错误的软版本。
   */

  /**
   * ★ ⑥ 落库 —— 这是「同一个窗口内不再变」的唯一依据。
   * ⚠️ assigned_at 记的是**现在**（窗口从此刻开始，24 小时后才允许换），
   *    而取模用的是**窗口起始日**（上面的 date）。
   * ⚠️ 必须 UPDATE 到 users 这一行：没有它，下一次请求又会从参与记录现算，
   *    而参与记录会因为他刚读完而变 —— 那正是要消灭的行为。
   */
  await database
    .update(users)
    .set({ todayArticleId: pickId, todayAssignedAt: new Date() })
    .where(eq(users.id, userId))

  return {
    articleId: pickId,
    level,
    myLevel: me.level,
    levelBasis: me.basis,
  }
}

/**
 * ⭐ **加权随机（轮盘赌）** —— 纯函数，单独抽出来是为了能单测。
 *
 * ⚠️ 权重 ≤ 0 的一律按 0 处理（参与人数不可能为负，但脏数据不该让抽样炸掉）。
 * ⚠️ 总权重 ≤ 0（冷启动：这一档还没人参与过）⇒ **等概率**，
 *    而不是固定挑第一条 —— 否则游客永远只看到同一句。
 *
 * @param rng 随机源，默认 Math.random；单测注入它把边界钉死
 * @returns 空数组时 null
 */
export function weightedPick<T>(
  items: T[],
  weights: number[],
  rng: () => number = Math.random,
): T | null {
  if (items.length === 0) return null
  const total = weights.reduce((a, w) => a + Math.max(0, w), 0)
  if (total <= 0) return items[Math.floor(rng() * items.length)] ?? items[0] ?? null

  let roll = rng() * total
  for (let i = 0; i < items.length; i++) {
    roll -= Math.max(0, weights[i] ?? 0)
    if (roll < 0) return items[i]!
  }
  // 浮点边界兜底（rng() 逼近 1 时理论上到不了这里）
  return items[items.length - 1]!
}

/**
 * ⭐⭐ **匿名推荐**（未登录 / 无 uid）—— 首页对游客也要有一张"今日"卡。
 *
 * 口径（用户 2026-09 定）：
 *   · **默认初级档**（0）—— 游客没有画像，从最简单那一档开始；
 *   · 在该档**有正文**的句子里**随机**挑一条；
 *   · 且**参与人数多的更容易被挑中** —— 越热闹的场子越可能被游客看到
 *     （卡片上那行"N 人参与"也更好看）。
 *
 * ⚠️ 与 recommendToday 的关系，以及为什么**不**复用它的 uid=0 分支：
 *   · 有 uid：24 小时窗口 + 这个人的难度档，**确定性**、窗口内固定（会写 users 那一行）；
 *   · 无 uid：根本没有"这个人"，也就没有窗口可谈 ⇒ 每次请求现摇一次，
 *     而且**一个用户行都不写**（纯只读兜底 —— 公开接口不该有建号/改库的副作用）。
 *     recommendToday(0) 是"按窗口起始日取模"的确定性选法，与"随机 + 热度"不是一回事。
 *
 * ⚠️ 权重 = 参与人数（与卡片上"N 人参与"**同源**，都来自 getArenaStatsBatch）。
 * ⚠️ 只从**有正文**的行里挑：给一张点进去空白的卡比不给更糟。
 *
 * @returns 初级档一句都没有（内容没铺到那一档 / 句库为空）时 null，调用方按部署问题报 503
 */
export async function pickAnonymousArticle(database: Database = db): Promise<string | null> {
  // ① 初级档 + 有正文 —— 顺序按 id，保证"等概率"那一支抽样的集合是稳定的
  const rows = await database
    .select({ id: articles.id, text: articles.text })
    .from(articles)
    .where(and(eq(articles.isActive, true), eq(articles.difficulty, 0)))
    .orderBy(asc(articles.id))
  const pool = rows.filter((r) => hasContent(r))
  if (pool.length === 0) return null

  // ② 热度 = 参与人数（一次批量取数，走与卡片、与榜单同一处实现）
  const stats = await getArenaStatsBatch(
    pool.map((r) => r.id),
    0,
  )
  const weights = pool.map((r) => stats.get(r.id)?.participantCount ?? 0)

  return weightedPick(pool, weights)?.id ?? null
}
