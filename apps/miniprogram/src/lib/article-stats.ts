import { fetchArticleStats } from './api/client'
import * as me from './store'

/**
 * ⭐⭐ **参与统计的唯一取数入口** —— `GET /api/participations/stats?ids=a,b,c`。
 *
 * 用户 2026-09 定的结构（L1 解耦）：人数 / 最高 / 最低是 `participations` 的
 * **聚合派生值**，不挂在句子卡片 / 详情上（那两个是内容，可以安全缓存）。
 * 列表要显示「N 人参与」时，拿**这一屏的 id 调一次**批量接口，再按 articleId 合并
 * （写进 store 的 `articleStats`，见 store 的 applyArticleStats）。
 *
 * ⚠️ 与 [lib/participation.ts](./participation.ts) 的分工：
 *    · 那边 = 「**我**在这一句上的参与」（按用户，鉴权接口，三态）；
 *    · 这边 = 「这一句**全场**的聚合」（公开接口，没有三态，没人参与就是 0/null）。
 *
 * ⚠️⚠️ **每次都重新拉**，不做"已拉过就短路"：统计是活数 ——
 *    短路住它就会出现"概要说 12 人、榜单里 15 行"。只对**同一批 id 的并发**去重。
 * ⚠️ 失败时**保留旧值**（不写 0）：把"没问到"写成"没人参与"是错的。
 */

/** 正在拉的 id（同一次并发合并；拉完就放掉，下次照常重拉） */
const inflight = new Set<string>()

/**
 * @returns 是否**真的拿到了**统计（调用方据此决定"显示数字"还是"显示错误"）。
 *   ⚠️ 失败时**不写 store**（保留旧值）——把"没问到"写成"没人参与"是错的。
 */
export async function ensureArticleStats(articleIds: string[]): Promise<boolean> {
  const ids = [...new Set(articleIds.filter((id) => !!id))].filter((id) => !inflight.has(id))
  if (ids.length === 0) return true

  ids.forEach((id) => inflight.add(id))
  try {
    const res = await fetchArticleStats(ids)
    me.applyArticleStats(res.items)
    return true
  } catch (err) {
    console.warn('[stats] 参与统计拉取失败（保留旧值）：' + (err as Error).message)
    return false
  } finally {
    ids.forEach((id) => inflight.delete(id))
  }
}
