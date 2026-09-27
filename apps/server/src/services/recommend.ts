import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { dayNumber, normalizeLevel } from '@jushuo/shared'
import type { ArticleLevel } from '@jushuo/shared'
import { db } from '../db'
import { articles, participations } from '../db/schema'

/**
 * ⭐⭐ **今日推荐** —— 按参与记录**分场**，不再给所有人同一句。
 *
 * ⚠️⚠️ 与 services/schedules.ts 的分工（这是这次改动的核心）：
 *   · schedules = 「哪一天读哪一句」：运营排期 / 按天轮转，**对所有人一样**。
 *     它仍然负责「历史挑战」和「这次提交记到哪一天」。
 *   · 这里 = 「**你今天适合读哪一句**」：按我的参与记录分场。
 *     ⇒ 首页那张"今日挑战"卡从这里来，不再用轮转那句。
 *
 * ⭐ 四条规则（用户 2026-09 定），**顺序就是优先级**：
 *
 *   ① **先定我的档位**（levelOf）：最近参与的句子都在哪一档，就推哪一档。
 *      长期在专家场的人不会被推回初级 —— 这正是旧轮转最鸡肋的地方。
 *   ② **同档同句**：同一档位的用户当天拿到**同一句**。不能完全千人千面 ——
 *      每个人的句子都不一样的话，就没有"竞技场"了（榜单会散成一人一张）。
 *   ③ **未读优先**：如果这一档今天那句我已经参与过，就换成"我还没参与过的"。
 *      池子越小这条越关键（句子量少时，同一句几天就轮回来一次）。
 *   ④ **兜底**：该档一句都没有（内容还没铺到那一档）→ 就近换档，
 *      并在 reason 里**说清楚换了**（别让用户以为系统瞎推）。
 *
 * ⚠️ 只返回「选哪一句 + 为什么」；正文 / 统计 / 音频由路由去补
 *    （见 routes/today.ts）—— 这一层不碰内容文件。
 */

/** 库句柄 —— 可注入，理由同 services/article-index.ts 的 Database */
type Database = typeof db

/**
 * ⚠️⚠️ **这几个数是产品口径**，改这里就够了（改完不用动别处）：
 *   · RECENT_N   取最近几次参与来定档（太多会被很久以前的历史拖住）
 *   · MIN_SAMPLE 样本太少就不做"升/降档"（3 次以下不下结论）
 *   · PROMOTE_AT 这一档的中位数到了这条线 ⇒ 往上一档（i+1，别把人留在舒适区）
 *   · DEMOTE_AT  中位数低于这条线 ⇒ 往下一档（别让人一直撞墙）
 */
const RECENT_N = 8
const MIN_SAMPLE = 3
const PROMOTE_AT = 85
const DEMOTE_AT = 60

export interface MyLevel {
  /** 我的档位（0 初级 / 1 中级 / 2 高级 / 3 专家） */
  level: ArticleLevel
  /** 这个档位是怎么来的（人话，卡片可以直接显示，也便于排查） */
  basis: string
}

/** 参与过的句子的档位序列（按最近参与倒序） */
async function recentLevels(
  userId: number,
  database: Database,
): Promise<{ level: ArticleLevel; best: number }[]> {
  const rows = await database
    .select({
      articleId: participations.articleId,
      lastAt: participations.lastAt,
      best: participations.bestScore,
      // difficulty 在 articles 上（参与记录只存句子 id）—— 一次 join 拿回来
      difficulty: articles.difficulty,
    })
    .from(participations)
    .innerJoin(articles, eq(articles.id, participations.articleId))
    .where(eq(participations.userId, userId))
    /**
     * ⚠️ **取最近的 N 次**：先按 lastAt 倒序，再按 id 倒序兜底
     *    （同一天连读几句时 lastAt 可能一样，不兜底"最近"就会随查询计划漂）。
     *    ⚠️ 这里曾经写成升序 + limit + reverse —— 那取到的是**最老的** 8 次，
     *    正好把画像定在用户的远古水平上。
     */
    .orderBy(desc(participations.lastAt), desc(participations.articleId))
    .limit(RECENT_N)

  const out: { level: ArticleLevel; best: number }[] = []
  for (const r of rows) {
    const lv = normalizeLevel(r.difficulty)
    if (lv === null) continue // 老内容没有难度 ⇒ 不进画像（不猜）
    out.push({ level: lv, best: Number(r.best) })
  }
  return out
}

/** 中位数（偶数个取中间两个的平均） */
function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? (s[mid] as number) : (((s[mid - 1] as number) + (s[mid] as number)) / 2)
}

const LABEL: Record<ArticleLevel, string> = { 0: '初级', 1: '中级', 2: '高级', 3: '专家' }
export function levelLabelOf(lv: ArticleLevel): string {
  return LABEL[lv]
}

/**
 * ⭐ 定我的档位。
 *
 * 做法刻意**简单、可解释**（别上模型：几十个用户、几句内容，模型只会过拟合）：
 *   ① 最近 RECENT_N 次参与的档位里取**众数**（并列时取最近的那个）
 *   ② 样本够（MIN_SAMPLE 次都在这一档）时再看**表现**微调 ±1：
 *      中位数 ≥ PROMOTE_AT → 上一档；≤ DEMOTE_AT → 下一档
 *
 * ⚠️ 没有参与记录（新用户）→ 初级。这正是"优先推荐新上线用户还没参与过的"那条的前提。
 */
export async function myLevelOf(userId: number, database: Database = db): Promise<MyLevel> {
  const recent = await recentLevels(userId, database)
  if (recent.length === 0) {
    return { level: 0, basis: '还没有参与记录 —— 从初级开始，读完会按你的表现调档' }
  }

  // ① 众数（并按"最近"打破并列：recent 已经是最近在前）
  const count = new Map<ArticleLevel, number>()
  for (const r of recent) count.set(r.level, (count.get(r.level) ?? 0) + 1)
  let level: ArticleLevel = recent[0]!.level
  let bestCount = 0
  for (const [lv, n] of count) {
    if (n > bestCount) {
      bestCount = n
      level = lv
    }
  }

  const sameLevel = recent.filter((r) => r.level === level)
  const mid = median(sameLevel.map((r) => r.best))
  let basis = '最近 ' + recent.length + ' 次里有 ' + bestCount + ' 次在' + LABEL[level] + '场'

  // ② 表现微调（样本够才做）
  if (sameLevel.length >= MIN_SAMPLE) {
    if (mid >= PROMOTE_AT && level < 3) {
      level = (level + 1) as ArticleLevel
      basis += '，' + LABEL[(level - 1) as ArticleLevel] + '场中位数 ' + mid.toFixed(1) + ' 分 —— 上一档试试'
    } else if (mid <= DEMOTE_AT && level > 0) {
      level = (level - 1) as ArticleLevel
      basis += '，' + LABEL[(level + 1) as ArticleLevel] + '场中位数只有 ' + mid.toFixed(1) + ' 分 —— 先回稳一档'
    } else {
      basis += '，中位数 ' + mid.toFixed(1) + ' 分'
    }
  }

  return { level, basis }
}

export interface TodayPick {
  articleId: string
  /** 实际用了哪一档（与 myLevel 不同 = 发生了兜底换档） */
  level: ArticleLevel
  /** 我原本的档位 */
  myLevel: ArticleLevel
  /** 档位是怎么来的 */
  levelBasis: string
  /** 为什么是这一句（人话，卡片直接显示） */
  reason: string
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
 * ⚠️ 内容没铺满时这条会被频繁走到 —— 所以它必须在 reason 里说出来。
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
 * ⭐ 选今天的这一句。
 *
 * @param date 'YYYY-MM-DD'（服务端的今天，见 shared/day.ts）—— 同一天任何人算出的取模都相同
 * @returns 句库一句都没有时 null（调用方按"部署问题"报 503）
 */
export async function recommendToday(
  userId: number,
  date: string,
  database: Database = db,
): Promise<TodayPick | null> {
  const me = await myLevelOf(userId, database)

  // ① 该档的候选；空了就就近换档
  let level = me.level
  let pool = await bandOf(level, database)
  let degraded = false
  if (pool.length === 0) {
    for (const alt of neighborLevels(me.level)) {
      const p = await bandOf(alt, database)
      if (p.length > 0) {
        pool = p
        level = alt
        degraded = true
        break
      }
    }
  }
  if (pool.length === 0) return null

  // ② 同档同句：天号取模 —— 同一档的用户当天一定是同一句
  let pickId = pool[((dayNumber(date) % pool.length) + pool.length) % pool.length] as string
  let why = ''

  /**
   * ③ 未读优先。
   * ⚠️ 只在"今天那句我已经参与过"时才换 —— 这样**没读过的人都还在同一句上**
   *    （新用户全都拿到同一句 = 竞技场是满的），只有读过的人被挪开。
   */
  const mine = await database
    .select({ articleId: participations.articleId, lastAt: participations.lastAt })
    .from(participations)
    .where(and(eq(participations.userId, userId), inArray(participations.articleId, pool)))
  const read = new Map(mine.map((r) => [r.articleId, r.lastAt]))

  if (read.has(pickId)) {
    const fresh = pool.filter((id) => !read.has(id))
    if (fresh.length > 0) {
      pickId = fresh[((dayNumber(date) % fresh.length) + fresh.length) % fresh.length] as string
      why = '这一档你还没读过这句'
    } else {
      // ④ 整档都读过了 → 挑**放得最久**的那句（不是随机，也不是从头再来）
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
      why = '这一档你都读过了 —— 挑了放得最久的那句'
    }
  }

  const reason =
    (why === '' ? '同一档的人今天读的是同一句' : why) +
    (degraded ? '（' + LABEL[me.level] + '场还没有句子，先给你' + LABEL[level] + '场）' : '')

  return {
    articleId: pickId,
    level,
    myLevel: me.level,
    levelBasis: me.basis,
    reason,
  }
}
