import type { ArticleDetail } from '@jushuo/shared'

import { LAUNCH_BUDGET_MS, request } from '../api/client'

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

  /**
   * ⚠️⚠️ **必须给冷启动预算**（`LAUNCH_BUDGET_MS`，50 秒），不能吃默认的 12 秒。
   *
   *    线上是云托管，`MinReplicas = 0` —— 没人用时容器**缩到零**，
   *    下一个请求要等冷启动（本项目实测 **30 秒级**，见 B23）。
   *    而默认预算 12 秒会在冷启动完成之前就被掐断，
   *    客户端把它翻译成「服务正在启动中（云托管冷启动要十几秒），请再试一次」——
   *    用户看到的就是这句（用户 2026-09 报的「dev 环境 reading 页打不开」）。
   *
   *    ⚠️ 为什么是**这一条**要 50 秒而不是所有请求：
   *      它是「从首页点进朗读页」那一次 —— 与首屏同一类：用户刚做了一个动作，
   *      界面上什么都没有，只能等。其余请求（历史 / 战绩 / 轮询）失败时界面还有内容，
   *      12 秒掐断更划算（省流量、快速失败）。
   *    ⚠️ 服务端那条路**不鉴权、不查库**（读盘 + 拼 fileID），冷启动之后是毫秒级 ——
   *      所以这 50 秒花的是"容器起来"的时间，不是这条接口慢。
   */
  const content = await request<ArticleDetail>('/api/articles/' + id, { budgetMs: LAUNCH_BUDGET_MS })
  contentCache.set(id, content)
  return content
}

/** 编辑器 / 调试用：内容变了要能刷新 */
export function clearContentCache(): void {
  contentCache.clear()
}
