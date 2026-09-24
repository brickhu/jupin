import type { ArticleLevel } from '@jushuo/shared'
import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import { eq } from 'drizzle-orm'

import { db } from '../db'
import { articleTags, articles } from '../db/schema'
import { loadArticleContent } from './content'

/**
 * 库句柄 —— **可注入**，默认用服务进程自己那个单例。
 *
 * ⚠️ 为什么需要它：本地 admin 要在 local / dev / prod **三个环境**上做同一件事，
 *    而那个单例在进程启动时就绑死了一个 DATABASE_URL。
 *    与其把「物化索引」这套规则抄第二份，不如让调用方把库递进来。
 */
type Database = typeof db

/**
 * ⭐ 两个档位 / 标签的**派生索引** —— 从正文 JSON 物化到
 *    articles.pron_level + articles.vocab_level + article_tags。
 *
 * ⚠️⚠️ **真相永远是正文 JSON**（见 db/schema.ts 顶部与 spec.md 第九节）。
 *    这里写的三处都是副本，存在的唯一理由是：
 *    「按档位 / 标签筛选、排序」能走 SQL，而不用把每篇正文都读一遍。
 *
 *    所以规矩只有一条：**只由这里写，随时可全量重建**。
 *    内容改了（改 JSON / 换正文）就重跑 —— 导入与「新增句」会自动跑，
 *    存量或手动改过正文之后跑 CLI 的 reindex。
 *
 * ⚠️ 正文读不到（文件丢了 / CDN 挂了）时**把索引清成空**，而不是留着旧值：
 *    留旧值的后果是「筛出来一条，点进去正文已经不是那个难度了」——
 *    比筛不到更难排查。
 */

export interface ArticleIndexResult {
  articleId: string
  /** 发音难度（中文母语者读出来有多难念） */
  pronLevel: ArticleLevel | null
  /** 词汇难度（小学 / 高中 / 六级 / GRE 那套口径，含句式复杂度） */
  vocabLevel: ArticleLevel | null
  tags: string[]
  /**
   * 正文里的 `id` 与 articles.id 不一致 —— 内容被改过却没换 id。
   * ⚠️ 内容寻址的一致性检查：两者本该**永远相等**（还等于文件名）。
   *    这里只报告不抛：存量脏数据不该让一次 reindex 整体失败。
   */
  idMismatch: boolean
}

/**
 * 纯函数：正文 → 索引值。**不碰库**，所以能单测。
 *
 * @param content 正文（读不到就是 null）
 */
export function indexOfContent(
  articleId: string,
  content: { id?: unknown; pronLevel?: unknown; vocabLevel?: unknown; tags?: unknown } | null,
): Omit<ArticleIndexResult, 'articleId'> {
  return {
    // ⚠️ 两条轴各归各的，**不许**用其中一个兜另一个
    pronLevel: normalizeLevel(content?.pronLevel),
    vocabLevel: normalizeLevel(content?.vocabLevel),
    tags: normalizeTags(content?.tags),
    // ⚠️ 正文整个读不到时**不算** mismatch —— 那是「没有正文」，不是「改过没换 id」
    idMismatch: !!content && content.id !== undefined && String(content.id) !== articleId,
  }
}

/** 把一条文章的正文属性写进索引（幂等） */
async function applyIndex(
  articleId: string,
  content: { id?: unknown; pronLevel?: unknown; vocabLevel?: unknown; tags?: unknown } | null,
  database: Database = db,
): Promise<ArticleIndexResult> {
  const idx = indexOfContent(articleId, content)

  await database.transaction(async (tx) => {
    await tx
      .update(articles)
      .set({ pronLevel: idx.pronLevel, vocabLevel: idx.vocabLevel })
      .where(eq(articles.id, articleId))
    // ⚠️ 先删后插，不做 diff：tags 是**集合**语义，重跑不能累积，
    //    而「猜哪几个要删」正是漂移的来源
    await tx.delete(articleTags).where(eq(articleTags.articleId, articleId))
    if (idx.tags.length > 0) {
      await tx.insert(articleTags).values(idx.tags.map((tag) => ({ articleId, tag })))
    }
  })

  return { articleId, ...idx }
}

/**
 * 物化一条文章。
 * @returns 文章不存在时 null（调用方据此报「没有这条」）
 */
export async function syncArticleIndex(
  articleId: string,
  database: Database = db,
): Promise<ArticleIndexResult | null> {
  const [row] = await database
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1)
  if (!row) return null

  const content = await loadArticleContent(row.id)
  return applyIndex(articleId, content, database)
}

/**
 * 批量重建 —— CLI 的 `reindex` 与「灌完句库」用它。
 *
 * @param ids 只给这些 id（增量）；不传 = 全量
 */
export async function reindexArticles(ids?: string[], database: Database = db): Promise<ArticleIndexResult[]> {
  const targets = ids?.length
    ? ids.map((id) => ({ id }))
    : await database.select({ id: articles.id }).from(articles)

  const out: ArticleIndexResult[] = []
  for (const t of targets) {
    const res = await syncArticleIndex(t.id, database)
    if (res) {
      out.push(res)
      /**
       * ⚠️ 这一条以前是**算出来就扔掉**的：正文里的 id 与 articles.id 不一致
       *    （内容被改过却没换 id、或文件名与内部 id 被手工改岔），
       *    而内容寻址下它们本该**永远相等**（还等于文件名）。
       *    丢掉的后果是脏数据只能等下一次人工排查才发现 —— 至少留一行日志。
       */
      if (res.idMismatch) {
        console.warn('[index] ⚠️ 正文 id 与 articles.id 不一致：' + t.id + '（内容寻址被破坏）')
      }
    }
  }
  return out
}
