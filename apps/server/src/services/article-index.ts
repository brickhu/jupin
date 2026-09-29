import type { ArticleLevel } from '@jushuo/shared'
import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import { eq } from 'drizzle-orm'

import { db } from '../db'
import { articles } from '../db/schema'
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
 * ⭐ **难度的派生索引** —— 从正文物化到 `articles.difficulty`。
 *
 * ⚠️⚠️ **真相永远是正文**（`articles.content`，见 db/schema.ts 顶部）。
 *    这里写的那个值是副本，存在的唯一理由是：
 *    「按档位筛选 / 排序」能走 SQL，而不用把每篇正文都读一遍
 *    （`recommend.ts` 里确实有这么一条 `where(eq(articles.difficulty, lv))`）。
 *
 *    所以规矩只有一条：**只由这里写，随时可全量重建**。
 *    内容改了（admin 里改难度判据分 / 换正文）就重跑 —— 导入与「新增句」会自动跑，
 *    存量或手动改过正文之后跑 CLI 的 reindex。
 *
 * ⚠️ 正文读不到时**把索引清成空**，而不是留着旧值：
 *    留旧值的后果是「筛出来一条，点进去正文已经不是那个难度了」——
 *    比筛不到更难排查。
 * ⚠️ 标签**没有**派生索引：原来有一张 `article_tags`，2026-09 删了
 *    （零查询方，见 db/schema.ts 里那段说明）。标签的真相只有正文里的 `tags`。
 */

export interface ArticleIndexResult {
  articleId: string
  /** 朗读难度（三个判据按权重合成的一个档位，见 shared/level.ts） */
  difficulty: ArticleLevel | null
  /**
   * ⚠️ 仍然报告标签，但**只作为"读到了什么"的回执**（CLI 打印用），不再落任何表。
   *    保留它是因为 reindex 的日志需要能看出"这篇的标签是什么"，
   *    而它已经是解析正文的副产品、不额外花代价。
   */
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
  content: { id?: unknown; difficulty?: unknown; tags?: unknown } | null,
): Omit<ArticleIndexResult, 'articleId'> {
  return {
    difficulty: normalizeLevel(content?.difficulty),
    tags: normalizeTags(content?.tags),
    // ⚠️ 正文整个读不到时**不算** mismatch —— 那是「没有正文」，不是「改过没换 id」
    idMismatch: !!content && content.id !== undefined && String(content.id) !== articleId,
  }
}

/** 把一条文章的正文属性写进索引（幂等） */
async function applyIndex(
  articleId: string,
  content: { id?: unknown; difficulty?: unknown; tags?: unknown } | null,
  database: Database = db,
): Promise<ArticleIndexResult> {
  const idx = indexOfContent(articleId, content)

  /**
   * ⚠️⚠️ 这里原来还会把标签物化进 `article_tags` 表 —— **2026-09 删掉那张表**。
   *
   *    它只有一个写入方（这个函数）和**零个查询方**：服务端从不读它，
   *    客户端与路由的标签都从正文取（`normalizeTags(content.tags)`），
   *    而它 `(article_id, tag)` 两列的形状还会**丢掉顺序**（顺序有意义：第一个最重要）——
   *    admin 详情页因此得专门写一段"优先用正文那份、索引只兜底"来绕开它。
   *    它当初是为"将来按标签筛选能走 SQL"准备的，而那个功能**从未实现**。
   *    ⇒ 一个没人查的派生表 = 每次内容变更都要重建，还多一份可能与正文不一致的副本。
   *    ⚠️ 对照：`articles.difficulty` 看着同类但**真被用**（recommend.ts 的 where/order by），
   *      所以难度这一半留着。判断标准是"有没有查询方"，不是"看起来像不像索引"。
   */
  await database.transaction(async (tx) => {
    await tx.update(articles).set({ difficulty: idx.difficulty }).where(eq(articles.id, articleId))
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
