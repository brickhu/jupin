import type { ArticleStats } from '@jushuo/shared'

import { fetchArticleStats, fetchFavoriteCounts } from './api/client'
import * as me from './store'

/**
 * ⭐⭐ **统计的唯一取数入口** —— `/api/stats/*`（**两个接口，一层封装**）。
 *
 * 用户 2026-09 定的结构：统计是**公开的聚合派生值**，与句子内容分开：
 *    · `GET /api/stats/participation?ids=a,b,c`  —— 人数 / 最高 / 最低
 *    · `GET /api/stats/favorite-count?ids=a,b,c` —— 每句被多少人收藏
 *    两条**形状一样**（`{items:[{articleId,…}]}`、按 ids 零值补齐）。
 *
 * ⚠️⚠️ **取数走这里、存数进 store、读数也走 store**（这一层不自己留副本）：
 *    页面读 `statsOf(articleId)`（或 `me.getArticleStats` / `me.getFavoriteCount`），
 *    拉到之后由 store **广播** → 订阅了的页面自己重画（见各页的 `me.subscribe`）。
 *    ⇒ 这就是"全局响应式"：一处拉到，所有读它的地方一起更新，谁也不用各存一份。
 *
 * ⚠️ 与 [lib/participation.ts](./participation.ts) 的分工（别混）：
 *    · 那边 = 「**我**在这一句上的参与」（按用户、鉴权、**三态**：没拉过 / 明确没参与 / 有记录）；
 *    · 这边 = 「这一句**全场**的聚合」（公开、没有三态，只有"拉到了"和"没拉到"）。
 *
 * ⚠️⚠️ **每次都重新拉**，不做"已拉过就短路"：统计是活数 ——
 *    短路住它就会出现"概要说 12 人、榜单里 15 行"。只对**同一批 id 的并发**去重。
 * ⚠️ 失败时**保留旧值**（不写 0）：把"没问到"写成"没人参与 / 没人收藏"是错的。
 */

/** 正在拉的 id（同一批并发合并；拉完就放掉，下次照常重拉）——两块各一个集合，互不牵连 */
const inflightParticipation = new Set<string>()
const inflightFavorite = new Set<string>()

/** 这一次批量取数，两块各自拿到了没有（调用方据此决定"显示数字"还是"显示错误"） */
export interface StatsFetchResult {
  participation: boolean
  favorite: boolean
}

/**
 * ⭐ 拉这几句的**全部统计**（参与 + 收藏），两块**并发**、各自独立成败。
 *
 * ⚠️ 一块失败**不影响**另一块：参与统计拿不到时收藏数照样该显示。
 */
export async function ensureStats(articleIds: string[]): Promise<StatsFetchResult> {
  const [participation, favorite] = await Promise.all([
    ensureArticleStats(articleIds),
    ensureFavoriteCounts(articleIds),
  ])
  return { participation, favorite }
}

/**
 * 参与统计（人数 / 最高 / 最低）→ `store.articleStats`。
 * @returns 是否**真的拿到了**（失败时**不写 store**，保留旧值）
 */
export async function ensureArticleStats(articleIds: string[]): Promise<boolean> {
  const ids = [...new Set(articleIds.filter((id) => !!id))].filter((id) => !inflightParticipation.has(id))
  if (ids.length === 0) return true

  ids.forEach((id) => inflightParticipation.add(id))
  try {
    const res = await fetchArticleStats(ids)
    me.applyArticleStats(res.items)
    return true
  } catch (err) {
    console.warn('[stats] 参与统计拉取失败（保留旧值）：' + (err as Error).message)
    return false
  } finally {
    ids.forEach((id) => inflightParticipation.delete(id))
  }
}

/**
 * 收藏总量 → `store.articleFavoriteCounts`。
 * @returns 是否**真的拿到了**（失败时不写：`0` 是"确实没人收藏"，不能拿它当兜底）
 */
export async function ensureFavoriteCounts(articleIds: string[]): Promise<boolean> {
  const ids = [...new Set(articleIds.filter((id) => !!id))].filter((id) => !inflightFavorite.has(id))
  if (ids.length === 0) return true

  ids.forEach((id) => inflightFavorite.add(id))
  try {
    const res = await fetchFavoriteCounts(ids)
    me.applyFavoriteCounts(res.items)
    return true
  } catch (err) {
    console.warn('[stats] 收藏统计拉取失败（保留旧值）：' + (err as Error).message)
    return false
  } finally {
    ids.forEach((id) => inflightFavorite.delete(id))
  }
}

/**
 * ⭐ **我刚收藏 / 取消收藏了这一句** —— 让收藏总量（那颗星右边的数字）**立刻跟着动**。
 *
 * ⚠️⚠️ 不这么做的话：数字要等下次进页面重新拉 `/api/stats/favorite-count` 才会变，
 *    用户刚点完星、数字却纹丝不动 —— 看起来就像收藏没生效。
 *
 * ⚠️ 分两种情况，**都不许猜**：
 *    · store 里**已经有这个数** ⇒ 按本次动作 ±1。这一次对服务端而言必然只差 1
 *      （收藏接口两头幂等，见 routes/favorites.ts），所以本地加减是准的；
 *    · store 里**没有这个数**（从没拉到过）⇒ **什么都不写**，改为拉一次让服务端回答。
 *      把"没拉到"顺手写成 0 或 1，就是本文件顶部那条规矩禁的事。
 *
 * ⚠️ 调用时机：**服务端确认之后**再调（与那颗星的乐观更新不同）——
 *    星是"我的意图"可以先翻，而收藏总量是全场聚合，得先知道服务端认没认。
 */
export function noteMyFavoriteToggle(articleId: string, favorited: boolean): void {
  if (!articleId) return
  const known = me.getFavoriteCount(articleId)
  if (known === null) {
    void ensureFavoriteCounts([articleId])
    return
  }
  // ⚠️ 不下穿 0：本地减到 0 就停住（真值以服务端下次拉的为准）
  me.applyFavoriteCounts([{ articleId, favoriteCount: Math.max(0, known + (favorited ? 1 : -1)) }])
}

/**
 * ⭐ **读统计的唯一入口** —— 两块一起给，页面不要在本地各存一份
 *    （两份迟早对不上，而 store 广播会帮你重画）。
 *
 * ⚠️ `null` = 还没拉到；`0` = 确实是 0 —— 两者必须分开。
 */
export function statsOf(articleId: string): {
  participation: ArticleStats | null
  favoriteCount: number | null
} {
  return {
    participation: me.getArticleStats(articleId),
    favoriteCount: me.getFavoriteCount(articleId),
  }
}
