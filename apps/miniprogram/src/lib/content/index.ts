import type { Article, ArticleContent } from '@jushuo/shared'

import { request } from '../api/client'

/**
 * 内容拉取。
 *
 * ⚠️ 分两步是**刻意的**，别合并成一个接口：
 *     ① `/api/articles/:id`        —— 库里的**索引**（排期 / 竞技统计），小而常变
 *     ② `/api/articles/:id/content` —— 真正的**正文**（句子 / 译文 / 词级数据）
 *   正文按设计要由 CDN 分发、客户端直接拉；现在由服务端代取只是因为
 *   contentJson 还可能是相对路径（流水线与 CDN 都还没建）。
 *   等 CDN 就位，② 可以直接换成拉 `article.contentJson`，这一层不用改调用方。
 */

/** 正文内存缓存 —— 同一篇文章一次会话只拉一次 */
const contentCache = new Map<number, ArticleContent>()

export async function fetchArticle(id: number): Promise<Article> {
  return request<Article>(`/api/articles/${id}`)
}

export async function fetchArticleContent(id: number): Promise<ArticleContent> {
  const hit = contentCache.get(id)
  if (hit) return hit

  const content = await request<ArticleContent>(`/api/articles/${id}/content`)
  contentCache.set(id, content)
  return content
}

/** 编辑器 / 调试用：内容变了要能刷新 */
export function clearContentCache(): void {
  contentCache.clear()
}
