import { and, eq, inArray } from 'drizzle-orm'
import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import type { ArticleCard, ArticleLevel } from '@jushuo/shared'

import { db as database } from '../db'
import { articles } from '../db/schema'
import { hasContent, loadArticleContent } from './content'
import { getArenaStatsBatch } from './leaderboard'
import { standardAudioOf } from './standard-audio-meta'

/**
 * ⭐⭐ **句库查询** —— `GET /api/articles`（通用）与 `/api/articles/latest`（最新上线）共用的取数层。
 *
 * ⚠️⚠️ 数据源是 **articles（句库）**，不是 schedules（排期）。
 *    db/schema.ts 里写得很清楚：排期「不是竞技单位，只是一个按日组织的展示层」，
 *    竞技数据的单位永远是**句子**（排名/人数/最高分全部按 article_id 查）。
 *
 * ⚠️⚠️ 「上线时间」用 articles.published_at（由后台发布 / 部署灌库写入），
 *    它是「最近一次从草稿变成已发布」的那一刻，正是「最新上线」要的语义。
 *    **不用 createdAt**：草稿可以生成很久之后才发布，createdAt 答的是
 *    「这一句是什么时候被生成的」，不是「什么时候上的线」。
 *    **更不能用 id 倒序**：id 是内容 hash（sha256(text) 前 16 位），
 *    它**不编码新旧** —— 倒序只是一个稳定的顺序，不是「最新」。
 *
 * ⚠️ **published_at 可能为 NULL（老数据）**：迁移 0029 已经把当时在线的行
 *    用 created_at 补过，但「直接以在线状态插入、又没走发布流程」的行仍可能为空。
 *    这类行的兜底是 **createdAt**（它在库里是 NOT NULL 默认值，一定有）——
 *    兜底的理由是「库里的出现时间」是仅次于「上线时间」的、能表达新旧的字段；
 *    直接丢掉这些行会让新上线的句子永远不出现，比用近似时间更糟。
 *
 * ⚠️ 一律只列 `isActive`；**正文读不到的句子直接丢掉**（给一张空卡片比不显示更糟）。
 */

/** 句库查询一次最多给几条（路由侧的默认值见 routes/articles.ts） */
export const MAX_ARTICLE_LIMIT = 100

/** 排序：`date` = 上线时间倒序（默认）；`participants` = 参与人数倒序 */
export type ArticleSort = 'date' | 'participants'

export interface ArticleQuery {
  /** 只要带这些标签**任意一个**的句子（OR）；空数组 / 不传 = 不筛 */
  tags?: string[]
  /** 只要这些难度档之一；空数组 / 不传 = 不筛 */
  levels?: ArticleLevel[]
  /** 排序方式，默认 `date` */
  sort?: ArticleSort
  /** 最多几条（调用方已用 clampLimit 收窄） */
  limit: number
}

/* ---------- 查询参数解析（纯函数，有单测） ---------- */

/**
 * 逗号分隔的查询参数 → 去空、去重、保序。
 *
 * ⚠️ `undefined` 与空串都算「没给这个筛选」—— `?tags=` 不该被当成
 *    「找一个空标签」（那会一条都匹配不到，看起来像"句库空了"）。
 */
export function parseList(raw: string | undefined): string[] {
  if (raw === undefined) return []
  const out: string[] = []
  for (const part of raw.split(',')) {
    const v = part.trim()
    if (v === '' || out.includes(v)) continue
    out.push(v)
  }
  return out
}

/** 四个合法难度档 */
const ALL_LEVELS: ArticleLevel[] = [0, 1, 2, 3]

/**
 * 难度参数 → 合法档位列表。
 * ⚠️ 认不出的（`abc` / `9` / `-1` / `1.5`）**直接丢掉**，不报错也不筛错档 ——
 *    筛选参数写错时"筛不出来"比"筛出别的档"更容易排查。
 */
export function parseLevels(raw: string | undefined): ArticleLevel[] {
  const out: ArticleLevel[] = []
  for (const part of parseList(raw)) {
    const n = Number(part)
    if (!Number.isInteger(n)) continue
    const lv = n as ArticleLevel
    if (!ALL_LEVELS.includes(lv) || out.includes(lv)) continue
    out.push(lv)
  }
  return out
}

/**
 * 数量收窄：缺省 / 空 / 认不出 → `def`；否则 clamp 到 `[1, max]`。
 *
 * ⚠️ `?limit=abc` 必须兜到 `def`，不能让它变成 NaN 一路传下去 ——
 *    那会表现为「句库空空」，而真正的原因只是一个畸形参数（同旧 latest 的注释）。
 */
export function clampLimit(raw: string | undefined, def: number, max: number = MAX_ARTICLE_LIMIT): number {
  if (raw === undefined || raw.trim() === '') return def
  const n = Number(raw)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(1, Math.trunc(n)))
}

/* ---------- 筛选 / 排序（纯函数，有单测） ---------- */

/**
 * 标签筛选：**任一命中**（OR）。
 *
 * ⚠️ 口径写死在这里、并写进接口文档：多个标签是「或」不是「且」——
 *    对浏览型接口来说，「选了 A、B 两个标签」的期望是"两类都想看看"。
 *    （要"同时带 A 和 B"的话，语义会变成交集，池子小的时候几乎必然为空。）
 * ⚠️ 空 `tags` = 不筛（原样返回），不是"筛出空标签的"。
 */
export function filterByTags<T extends { tags: string[] | null }>(rows: T[], tags: string[]): T[] {
  if (tags.length === 0) return rows
  return rows.filter((r) => (r.tags ?? []).some((t) => tags.includes(t)))
}

/** 参与排序需要的列 —— 调用方从 articles 取 */
export interface LatestCandidate {
  articleId: string
  /** 最近一次上线时刻；可能为 null（老数据 / 未走发布流程的行） */
  publishedAt: Date | null
  /** 入库时刻，"上线时间"为 null 时的兜底 */
  createdAt: Date
}

/** 一条候选的「上线时间」—— published_at 优先，为空退回 created_at */
export function onlineAtOf(row: { publishedAt: Date | null; createdAt: Date }): number {
  return (row.publishedAt ?? row.createdAt).getTime()
}

/**
 * 按**参与人数**倒序。
 *
 * ⚠️ 人数相同时用**上线时间**、再 `id` 兜底 —— 排序必须**确定**，
 *    否则同一屏两次请求的顺序会随查询计划漂移（用户看到列表"自己在跳"）。
 */
export function sortByParticipants<T extends LatestCandidate>(
  rows: T[],
  counts: Map<string, number>,
): T[] {
  return [...rows].sort((a, b) => {
    const ca = counts.get(a.articleId) ?? 0
    const cb = counts.get(b.articleId) ?? 0
    if (ca !== cb) return cb - ca
    const diff = onlineAtOf(b) - onlineAtOf(a)
    if (diff !== 0) return diff
    return a.articleId < b.articleId ? 1 : a.articleId > b.articleId ? -1 : 0
  })
}

/**
 * 从**句库**里挑出最新上线的几句。
 *
 * @param rows           候选句子（顺序无所谓，内部会按上线时间倒序排）
 * @param todayArticleId 今日那一句的 id（null = 不剔除）
 * @param limit          最多几条
 */
export function pickLatestArticles<T extends LatestCandidate>(
  rows: T[],
  todayArticleId: string | null,
  limit: number,
): T[] {
  /** ② 按上线时间倒序；同一时刻用 id 倒序兜底（否则顺序会随查询计划漂移） */
  const sorted = [...rows].sort((a, b) => {
    const diff = onlineAtOf(b) - onlineAtOf(a)
    if (diff !== 0) return diff
    return a.articleId < b.articleId ? 1 : a.articleId > b.articleId ? -1 : 0
  })

  const out: T[] = []
  for (const r of sorted) {
    if (todayArticleId !== null && r.articleId === todayArticleId) continue // ①
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}

/**
 * ⭐⭐ **句库查询的唯一实现**（`GET /api/articles` 与 `/api/articles/latest` 都走它）。
 *
 * 流程：取候选（难度在 SQL 里筛） → 丢掉没正文的 → 标签在内存里筛（JSON 列，见下）
 *      → 排序（date / participants） → 截断 → 补正文与竞技统计。
 *
 * ⚠️ 标签为什么在**内存**里筛、难度却在 **SQL** 里筛：
 *    · `difficulty` 是普通的 int 列（派生物化），`inArray` 直接走索引；
 *    · `tags` 是 **JSON 列**（`articles.tags`，2026-09 删掉了 article_tags 关联表），
 *      用 SQL 得写 `JSON_CONTAINS` 这类方言函数；而句库规模很小（几十条），
 *      内存里筛更直观、也能被单测覆盖。将来句库大到需要分页再看要不要下沉。
 *
 * ⚠️ 参与人数排序必须**先拿到全部候选的人数**再截断（不能先截断再排）——
 *    否则「参与人数最多的一句」如果在截断窗口之外，就永远排不上来。
 */
export async function queryArticleCards(q: ArticleQuery): Promise<ArticleCard[]> {
  const { tags = [], levels = [], sort = 'date', limit } = q

  const rows = await database
    .select({
      id: articles.id,
      // ⚠️ text 必须选出来：`hasContent()` 的判据就是它（"这句有没有正文"）
      text: articles.text,
      theme: articles.theme,
      standardAudio: articles.standardAudio,
      // ⚠️ tags 也要选出来 —— 标签筛选在内存里做（理由见上面的说明）
      tags: articles.tags,
      publishedAt: articles.publishedAt,
      createdAt: articles.createdAt,
    })
    .from(articles)
    .where(
      levels.length > 0
        ? and(eq(articles.isActive, true), inArray(articles.difficulty, levels))
        : eq(articles.isActive, true),
    )

  const withContent = rows.filter((r) => hasContent(r))
  const matched = filterByTags(withContent, tags)
  const candidates = matched.map((r) => ({
    articleId: r.id,
    theme: r.theme,
    standardAudio: r.standardAudio,
    publishedAt: r.publishedAt,
    createdAt: r.createdAt,
  }))

  let picked: typeof candidates
  if (sort === 'participants') {
    /**
     * ⚠️ 这里仍然要统计 —— 但**只为了排序**（按参与人数倒序），不是往卡片上填字段。
     *    参与统计已经从 ArticleCard 上摘掉（用户 2026-09 定：L1 解耦），
     *    端侧要显示"N 人参与"时自己调 `GET /api/participations/stats?ids=`。
     * ⚠️ 先取全部候选的人数，排序后再截断 —— 见函数头注释
     */
    const stats = await getArenaStatsBatch(candidates.map((c) => c.articleId), 0)
    const counts = new Map([...stats].map(([id, st]) => [id, st.participantCount]))
    picked = sortByParticipants(candidates, counts).slice(0, limit)
  } else {
    picked = pickLatestArticles(candidates, null, limit)
  }

  const out: ArticleCard[] = []
  for (const row of picked) {
    const src = withContent.find((r) => r.id === row.articleId)
    if (!src) continue
    const content = await loadArticleContent(row.articleId)
    out.push({
      articleId: row.articleId,
      text: content?.text ?? '',
      translation: content?.translation ?? '',
      // ⚠️ 内容可能比代码旧 ⇒ 一律过规范化，认不出就是 null / []，**不补默认档位**
      difficulty: normalizeLevel(content?.difficulty),
      tags: normalizeTags(content?.tags),
      audio: await standardAudioOf({ id: src.id, standardAudio: src.standardAudio }),
      theme: src.theme,
    })
  }
  return out
}
