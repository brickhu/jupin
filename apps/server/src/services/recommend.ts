import { and, asc, eq, inArray } from 'drizzle-orm'
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

const LABEL: Record<ArticleLevel, string> = { 0: '初级', 1: '中级', 2: '高级', 3: '专家' }
export function levelLabelOf(lv: ArticleLevel): string {
  return LABEL[lv]
}

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
