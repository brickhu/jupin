import { desc, eq } from 'drizzle-orm'
import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import type { ArticleCard } from '@jushuo/shared'

import { db as database } from '../db'
import { articles } from '../db/schema'
import { hasContent, loadArticleContent } from './content'
import { getArenaStatsBatch } from './leaderboard'
import { standardAudioOf } from './standard-audio-meta'

/**
 * ⭐ 首页「最新上线」那一段怎么挑 —— 纯函数，规则单独放这里（有单测）。
 *
 * ⚠️⚠️ 数据源是 **articles（句库）**，不是 schedules（排期）。
 *    db/schema.ts 里写得很清楚：排期「不是竞技单位，只是一个按日组织的展示层」，
 *    竞技数据的单位永远是**句子**（排名/人数/最高分全部按 article_id 查）。
 *    ⇒ 首页下半段要列的是「句库里**最新上线**的几句」，不是「过去哪几天排过」。
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
 * ⚠️ 两条规则，都能独立写错，而写错了只表现为「多了/少了一张卡」或「顺序怪」：
 *
 *  ① **剔除今日那一句**：今日那张卡就在它上面，再列一次等于同一个榜单看两遍。
 *     ⚠️ 池子小的时候必然发生。
 *  ② **按上线时间倒序**（同一时刻用 id 倒序兜底，保证顺序稳定）。
 *     ⚠️ 显式排序，不依赖调用方 SQL 的 order by：这个顺序是产品语义。
 */

/** 参与排序需要的三列 —— 调用方从 articles 取 */
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
 * ⭐⭐ **首页「最新上线」那一段的数据**（句库里按上线时间倒序的最新 N 句，含竞技统计）。
 *
 * ⚠️⚠️ **它是 `GET /api/articles?latest=N` 的实现**（2026-09 定）——
 *    首页下半段那一段由它给。⚠️ 「今天读哪一句」是**另一条接口**
 *    （`GET /api/articles/today?uid=`，见 routes/articles.ts 的 today 路由），
 *    别把两者合成一个包：一个对所有人一样、按上线时间；一个按 uid（或匿名）、24 小时窗口。
 *    ⚠️ 别为它再开一条路由（那正是之前那轮混乱的来源）。
 *
 * ⚠️ 只列 `isActive`；**正文读不到的句子直接丢掉**（给一张空卡片比不显示更糟）。
 * ⚠️ `excludeArticleId` 用来避开"今天推荐的那一句"，别让同一句在首屏出现两次。
 */
export async function latestArticleCards(
  limit: number,
  excludeArticleId: string | null = null,
): Promise<ArticleCard[]> {
  // 取多一点（3 倍）再过滤 —— 过滤掉的是"没有正文"的行
  const rows = await database
    .select({
      id: articles.id,
      // ⚠️ text 必须选出来：`hasContent()` 的判据就是它（"这句有没有正文"）
      text: articles.text,
      theme: articles.theme,
      standardAudio: articles.standardAudio,
      publishedAt: articles.publishedAt,
      createdAt: articles.createdAt,
    })
    .from(articles)
    .where(eq(articles.isActive, true))
    .orderBy(desc(articles.publishedAt), desc(articles.createdAt))
    .limit(limit * 3)

  const withContent = rows.filter((r) => hasContent(r))
  const picked = pickLatestArticles(
    withContent.map((r) => ({
      articleId: r.id,
      theme: r.theme,
      standardAudio: r.standardAudio,
      publishedAt: r.publishedAt,
      createdAt: r.createdAt,
    })),
    excludeArticleId,
    limit,
  )

  const articleIds = picked.map((r) => r.articleId)
  /** 竞技统计（参与人数 / 最高 / 最低）—— 卡片上那行「N 人参与」用它 */
  const stats = await getArenaStatsBatch(articleIds, 0)

  const out: ArticleCard[] = []
  for (const row of picked) {
    const src = withContent.find((r) => r.id === row.articleId)
    if (!src) continue
    const content = await loadArticleContent(row.articleId)
    const st = stats.get(row.articleId)
    out.push({
      articleId: row.articleId,
      text: content?.text ?? '',
      translation: content?.translation ?? '',
      // ⚠️ 内容可能比代码旧 ⇒ 一律过规范化，认不出就是 null / []，**不补默认档位**
      difficulty: normalizeLevel(content?.difficulty),
      tags: normalizeTags(content?.tags),
      participantCount: st?.participantCount ?? 0,
      topScore: st?.topScore ?? null,
      lowestScore: st?.lowestScore ?? null,
      audio: await standardAudioOf({ id: src.id, standardAudio: src.standardAudio }),
      theme: src.theme,
    })
  }
  return out
}
