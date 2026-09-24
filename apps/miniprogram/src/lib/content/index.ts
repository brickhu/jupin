import type { ArticleDetail } from '@jushuo/shared'

import { request } from '../api/client'

/**
 * 内容拉取。
 *
 * ⭐ 句库在服务端是**两条路由**，对应两个概念，别混：
 *     ① `GET /api/articles`     —— **列表**（瘦）：id / 正文 / 译文 / 难度 / 标签 / 标准音
 *     ② `GET /api/articles/:id` —— **详情**（全量）：正文 + 词级数据（音标 / 释义 / 逐词音频）
 *   这一层只做 ②：阅读页要的是**全量**那一份。列表页要用 ① 时再往上加。
 *
 * ⚠️ 正文按设计要由 CDN 分发、客户端直接拉；现在由服务端代取只是因为
 *    CDN 还没建（服务端按 id 推导路径去读盘）。
 *    等 CDN 就位，这里可以直接换成拉 `<CDN>/content/articles/<id>.json`，调用方不用改。
 *
 * ⚠️ 两句都是**公开数据**（同一句给所有人一样），所以服务端那条路不鉴权；
 *    但客户端仍从我们的接口拿 —— 它不该知道（也不需要知道）仓库里的正文路径。
 */

/** 正文内存缓存 —— 同一篇文章一次会话只拉一次 */
const contentCache = new Map<string, ArticleDetail>()

export async function fetchArticleContent(id: string): Promise<ArticleDetail> {
  const hit = contentCache.get(id)
  if (hit) return hit

  const content = await request<ArticleDetail>('/api/articles/' + id)
  contentCache.set(id, content)
  return content
}

/** 编辑器 / 调试用：内容变了要能刷新 */
export function clearContentCache(): void {
  contentCache.clear()
}
