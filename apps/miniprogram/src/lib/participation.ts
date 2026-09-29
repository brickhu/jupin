import type { ParticipationRecord } from '@jushuo/shared'

import { fetchParticipation } from './api/client'
import { isUnregistered } from './auth'
import * as me from './store'

/**
 * ⭐⭐ 「一句的参与状态」的**唯一取数入口** —— `GET /api/user/participation/{articleId}`。
 *
 * 用户 2026-09 定的口径（**所有**句子列表与详情都走这条）：
 *    句子数据（列表 / 详情）加载出来之后，再用这个接口逐句拉"我在这一句上的参与信息"，
 *    拉到就写进**全局 store**（见 store 的 applyParticipations）——
 *    页面只读 store，不自己存一份（两份必然对不上）。
 *    今日卡、最新上线列表、竞技场详情、收藏列表、参与场次都走这一条。
 *
 * ⚠️⚠️ 三种结局必须分清（见 store 的 MeState.participation）：
 *    · 拉到记录 / 服务端明确说没参与 → 写进 store（后者写 null = 结论）
 *    · 未加入句拼（403 NOT_REGISTERED）→ 那一句必然是"没参与过"，写 null
 *    · 问不到（超时 / 断网）→ **什么都不写**（键保持不存在 = 未知）
 *      ⇒ 把"没问到"写成 null，界面就会肯定地告诉用户"你还没参与过" —— 而那是错的。
 *
 * ⚠️ 两条去重：**已拉过的不再问**（`participationOf().loaded`）、
 *    **正在拉的不再问**（`inflight`）—— 列表与详情会同时问同一句。
 * ⚠️ 一屏最多同时打 `CONCURRENCY` 个：首页一次要问七八句，不设上限就是一次并发风暴。
 */

/** 同时进行的请求数上限 */
const CONCURRENCY = 4

/** 正在拉的句子 id —— 同 id 合并，别打两次 */
const inflight = new Set<string>()

/**
 * ⭐⭐ **批量取数**（列表用）：把这批句子的参与状态拉齐并写进 store。
 * ⚠️ 幂等、可反复调（每次 store 广播都可以调一次，见首页的 fillParticipation）：
 *    已拉过 / 正在拉 / 空 id 都会被过滤掉。
 */
export async function ensureParticipation(articleIds: string[]): Promise<void> {
  const ids = unique(articleIds).filter(
    (id) => !me.participationOf(id).loaded && !inflight.has(id),
  )
  if (ids.length === 0) return

  const state = me.getState()

  /**
   * ⚠️ 本机已知「还没加入句拼」（服务端答复过）⇒ 这些句子必然是"没参与过"，
   *    **一个请求都不发**（接口会回 403 —— 一次注定被拒的请求只会刷日志），
   *    批量落 null（一次 commit，见 applyParticipations）。
   */
  if (!state.userInfo) {
    if (state.session === 'ready') {
      me.applyParticipations(ids.map((articleId) => ({ articleId, record: null })))
    }
    // session 为 'pending'/'unknown'：保持未知 —— 别把"还不知道"写成"没参与"
    return
  }

  ids.forEach((id) => inflight.add(id))
  /** 拿到的结论（记录或 null）—— "没问到"的**不进这个数组** */
  const results: { articleId: string; record: ParticipationRecord | null }[] = []
  try {
    const queue = [...ids]
    const worker = async (): Promise<void> => {
      for (;;) {
        const id = queue.shift()
        if (id === undefined) return
        const record = await fetchOne(id)
        if (record !== undefined) results.push({ articleId: id, record })
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, ids.length) }, worker))
    // ⚠️ 一次 commit 写完整批：一屏 7 张卡不该触发 7 次重画
    if (results.length > 0) me.applyParticipations(results)
  } finally {
    ids.forEach((id) => inflight.delete(id))
  }
}

/**
 * 单句版 —— 详情页（竞技场 / 朗读页）用。
 * ⚠️ 它只是批量版的薄封装：同一套三态规则、同一个 inflight 去重。
 */
export function loadParticipation(articleId: string): Promise<void> {
  return ensureParticipation([articleId])
}

/**
 * 拉一句。
 * @returns 记录 / **null（明确没参与）** / **undefined（没问到 —— 绝不写进 store）**
 */
async function fetchOne(articleId: string): Promise<ParticipationRecord | null | undefined> {
  try {
    return await fetchParticipation(articleId)
  } catch (err) {
    // 账号在服务端已经没了（清库等）⇒ 等同于"这一句我没参与过"
    if (isUnregistered(err)) return null
    console.warn('[participation] 拉取失败（保持未知，下次再试）：' + (err as Error).message)
    return undefined
  }
}

/** 去重 + 丢掉空串（hash 缺省、参数没传时会走到这里） */
function unique(ids: string[]): string[] {
  return [...new Set(ids.filter((id) => !!id))]
}
