import { Hono } from 'hono'
import { desc, eq } from 'drizzle-orm'
import { normalizeLevel, normalizeTags, today } from '@jushuo/shared'
import type { ArticleLevel, ArticleTheme, ScheduleAudio, ScheduleEntry, ScheduleDetail } from '@jushuo/shared'
import { db } from '../db'
import { articles } from '../db/schema'
import { hasContent, loadArticleContent } from '../services/content'
import { scheduleAudioOf } from '../services/standard-audio-meta'
import { pickLatestArticles } from '../services/schedule-shape'
import { getArenaStatsBatch, getTopLeaderboard } from '../services/leaderboard'
import { MAX_BACKFILL_DAYS, resolveScheduleDate } from '../services/schedule-date'
import type { Variables } from '../middleware/auth'

export const schedulesRoutes = new Hono<{ Variables: Variables }>()

/** 首页"最新上线"那一段：默认给几句、最多给几句（客户端不传参数时用默认值） */
const DEFAULT_LATEST = 6
const MAX_LATEST = 50

/**
 * ⭐ **最新上线**（句库里按上线时间倒序的最新 N 句）—— 首页那一段列表。
 *
 * ⚠️⚠️ 这个路由以前还返回一个 `today`（"今天读哪一句"），那个概念**已删除**
 *    （2026-09 用户定：**删掉 schedules 表与接口，统一用 today 接口**）：
 *    · "今天读哪一句"= `/api/user/today`，**按 24 小时窗口、按用户难度档**推荐；
 *    · 排期表（`schedules`）连同"哪一天读哪一句是已决定的数据"这个前提一起删了 ——
 *      它带来的所有分支（预排两周 / 运营排期 / 按日期回看）都不再需要。
 *    ⚠️ 所以这个路由现在只回答一件事：**句库里最新上的几句是哪几句**。
 *      它的数据源一直是 `articles`（不是排期表），所以这次改动对它是"删掉一半"。
 *
 * ⚠️ 路径暂时保留 `/api/schedules`：客户端那条调用还指着它（下一步一起改）。
 *    改完客户端后这个路径也该换名（它已经不表示"排期"了）——
 *    记在 plan 里，别让它变成一个名字与内容不符的接口。
 */
schedulesRoutes.get('/', async (c) => {
  const date = today()

  const requested = Number(c.req.query('latest'))
  // ⚠️ NaN 也要兜住：?latest=abc 会让 Math.min 返回 NaN，随后一条都不返回，
  //    表现出来是「最新空空」，而真正的原因是一个畸形参数。
  const limit = Number.isFinite(requested)
    ? Math.min(MAX_LATEST, Math.max(1, Math.trunc(requested)))
    : DEFAULT_LATEST

  /**
   * ⭐ 最新上线：走**句库**（articles 表）。
   * ⚠️ 取数时就把「正文读不到的句子」剔掉：卡片要显示句子本身，
   *    没有正文的条目在界面上就是一个空盒子。
   */
  const rows = await db
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

  const latestRows = pickLatestArticles(
    withContent.map((r) => ({
      articleId: r.id,
      theme: r.theme,
      standardAudio: r.standardAudio,
      publishedAt: r.publishedAt,
      createdAt: r.createdAt,
    })),
    null,
    limit,
  )

  const articleIds = latestRows.map((r) => r.articleId)
  const stats = await getArenaStatsBatch(articleIds, 0)

  const byArticleId = new Map<
    string,
    { text: string; translation: string; difficulty: ArticleLevel | null; tags: string[] }
  >()
  await Promise.all(
    articleIds.map(async (articleId) => {
      const content = await loadArticleContent(articleId)
      byArticleId.set(articleId, {
        text: content?.text ?? '',
        translation: content?.translation ?? '',
        // ⚠️ 内容可能比代码旧 ⇒ 一律过规范化，认不出就是 null / []，**不补默认档位**
        difficulty: normalizeLevel(content?.difficulty),
        tags: normalizeTags(content?.tags),
      })
    }),
  )

  /**
   * ⭐ 标准音（含时长）按**句子**算一次。
   * ⚠️ 时长是读音频现算的（容器里没有 ffprobe），进程内缓存；
   *    算不出来是 null ⇒ 端侧只显示按钮、不显示时长。
   */
  const audioOf = new Map<string, ScheduleAudio | null>()
  await Promise.all(
    articleIds.map(async (id) => {
      const a = withContent.find((r) => r.id === id)
      if (!a) return
      audioOf.set(id, await scheduleAudioOf({ id: a.id, standardAudio: a.standardAudio }))
    }),
  )

  const commonOf = (articleId: string): Omit<ScheduleEntry, 'articleId'> | null => {
    const c = byArticleId.get(articleId)
    if (!c) return null
    const st = stats.get(articleId)
    return {
      text: c.text,
      translation: c.translation,
      difficulty: c.difficulty,
      tags: c.tags,
      participantCount: st?.participantCount ?? 0,
      topScore: st?.topScore ?? null,
      lowestScore: st?.lowestScore ?? null,
      audio: audioOf.get(articleId) ?? null,
      theme: withContent.find((r) => r.id === articleId)?.theme ?? null,
    }
  }

  const latest: ScheduleEntry[] = []
  for (const row of latestRows) {
    const c = commonOf(row.articleId)
    if (!c) continue
    latest.push({ articleId: row.articleId, ...c })
  }

  return c.json({ ok: true, data: { date, latest } })
})

/**
 * ⚠️⚠️ 这里**曾经有 `GET /api/schedules/:date`**（"回到那一天看那一场"），2026-09 删除。
 *
 *    它依赖 `schedules` 表（"哪一天读哪一句"是提前排好的数据），而那个概念整体删掉了：
 *    句子的归属统一由 `/api/user/today` 的 24 小时窗口决定。
 *    ⚠️ 它剩下的唯一用处是"从结果页跳到那一句的竞技场"—— 那个动作现在**按句子寻址**
 *      （`/api/arenas/:articleId`）：竞技场本来就是"这一句的榜"，
 *      日期只是它当初的展示容器（见 shared/types/api.ts 的 ArenaDetail 说明）。
 */
