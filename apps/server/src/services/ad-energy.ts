import { and, desc, eq } from 'drizzle-orm'
import { AD_REWARD_ENERGY, type AdEnergyResponse } from '@jushuo/shared'

import { db, type Executor } from '../db'
import { energyLedger, users } from '../db/schema'
import { ENERGY_REASON, addEnergy } from './energy'

/**
 * ⭐⭐ **看激励视频补能量**（`POST /api/user/ad-energy`）—— 规格：prd §7.7。
 *    调研（接入条件 / 单位经济 / 官方红线原文）：docs/research/rewarded-ad-channel.md。
 *
 * ## 我们只做两件事：幂等 + 一个最小间隔
 *
 * ⚠️⚠️ **「用户真的看完了吗」这件事，服务端验不了**：
 *    微信的激励视频**服务端验证（SSV）**（`setServerSideVerificationData` + 回调验签）
 *    只在**小游戏**文档里有，小程序 API 参考里没有这个方法 ⇒ 现状只能信客户端的
 *    `onClose(res.isEnded === true)`。所以这一层的价值不是"防住"，而是"不白送得更糟"。
 *
 * ⚠️ **不做我们自己的日限**（2026-10 用户定）：能看几次由**微信广告系统**决定
 *    （官方口径「每个用户每天可观看激励式视频广告的次数**有限**」，数字未公布；
 *    次数用尽时客户端拿到 `onError` / 拉取失败，端侧照实提示）。
 *    服务端只留 `AD_REWARD_MIN_INTERVAL_MS` 这一个**最小间隔**：
 *    ⚠️ 它**不是产品日限** —— 一次广告最短 6 秒，所以正常用户永远撞不到它；
 *    它挡的是「绕过客户端直接打接口」的脚本把一秒刷成几十点。
 *    ⚠️ 真要防脚本，只有 SSV（等确认小程序侧可用）或日限两条路，见 plan.md B56。
 *
 * ## 三个"成功"要分清（端侧文案全靠它）
 *
 *   · 真发了            → `energyGained > 0`
 *   · **重放**（同一个 requestId 又来）→ `ok: true` + `energyGained: 0`
 *   · 太近              → `ok: false` + `reason: 'too-soon'`
 *
 * ⚠️ 重放**必须回 ok**：响应丢包后客户端重试、或用户连点两下，
 *    都不是错误 —— 把它报成错误只会让用户看到一句无用的"失败"，而点数其实已经到账。
 */

/**
 * 两次发放之间的最小间隔。
 *
 * ⚠️ 取值理由：激励视频最短档是 **6 秒**（官方只有 6–15s / 16–30s 两档时长），
 *    所以"看完一条 → 立刻再看下一条"之间的真实间隔必然 ≥ 6 秒 ⇒ 5 秒
 *    对正常用户**零感知**，对脚本是一道减速带。
 */
export const AD_REWARD_MIN_INTERVAL_MS = 5_000

/** 流水的 refType —— 与 `refId`（客户端 requestId）一起构成幂等键 */
export const AD_REWARD_REF_TYPE = 'ad'

/**
 * ⭐ **该不该因为"太近"而拒绝** —— 纯函数，方便单测（不连库）。
 *
 * ⚠️ 没有上一次记录（第一次看）时永远放行。
 * ⚠️ `createdAt` 解析不出来（null / 非法日期）时**放行**：
 *    宁可多发 1 点，也不要因为一条坏数据把功能永久锁死 —— 那是用户看得见、我们看不见的故障。
 */
export function adRewardTooSoon(
  lastGrantedAt: Date | null | undefined,
  now: number = Date.now(),
  intervalMs: number = AD_REWARD_MIN_INTERVAL_MS,
): boolean {
  if (!lastGrantedAt) return false
  const last = lastGrantedAt.getTime()
  if (!Number.isFinite(last)) return false

  const elapsed = now - last

  /**
   * ⚠️ `elapsed < 0` 是"上一次发放的时间在**未来**"（两台机器时钟差、或有人改了库）。
   *    这里**只容忍一个间隔以内**的抖动 —— 那确实可能是时钟差，不拦就会连发两次；
   *    差得更多就说明这条数据是坏的，**放行**：
   *    否则功能会被一条坏数据一直锁到那个未来时间为止（用户看得见、我们看不见的故障）。
   */
  if (elapsed < -intervalMs) return false

  return elapsed < intervalMs
}

/** 上一次发广告能量是什么时候（没有就 null） */
async function lastAdRewardAt(ex: Executor, userId: number): Promise<Date | null> {
  const [row] = await ex
    .select({ createdAt: energyLedger.createdAt })
    .from(energyLedger)
    .where(and(eq(energyLedger.userId, userId), eq(energyLedger.reason, ENERGY_REASON.adReward)))
    .orderBy(desc(energyLedger.id))
    .limit(1)
  return row?.createdAt ?? null
}

/** 这一笔 requestId 已经发过了吗（幂等判据，与 `addEnergy` 用的是同一个键） */
async function alreadyGranted(ex: Executor, userId: number, requestId: string): Promise<boolean> {
  const [row] = await ex
    .select({ id: energyLedger.id })
    .from(energyLedger)
    .where(
      and(
        eq(energyLedger.reason, ENERGY_REASON.adReward),
        eq(energyLedger.refType, AD_REWARD_REF_TYPE),
        eq(energyLedger.refId, requestId),
        eq(energyLedger.userId, userId),
      ),
    )
    .limit(1)
  return Boolean(row)
}

/**
 * ⭐⭐ **发一次广告能量**。
 *
 * ⚠️⚠️ 全程**一个事务**，而且只经 `energy.ts` 的 `addEnergy` ——
 *    `users.energy` 与 `energy_ledger` 的**唯一写入方**是 `services/energy.ts`，
 *    这条规矩有守卫测试盯着（`db/domain-write-guard.test.ts`）。
 *    在这里直接 `UPDATE users SET energy = …` 会当场把守卫测红，而且真的会漂移。
 *
 * ⚠️ 三个检查的顺序**不能换**：
 *    ① 先查**重放**（同一个 requestId）—— 否则刚发完的重试会被判成"太近"而变成失败；
 *    ② 再查**最小间隔**；
 *    ③ 最后才发。
 *
 * @param requestId 客户端**按一次动作**生成（见小程序 lib/request-id.ts）。⚠️ 不接受数量参数：
 *                  发多少点是我们的事（`AD_REWARD_ENERGY`），让端侧传等于让它定价。
 */
export async function grantAdEnergy(
  userId: number,
  requestId: string,
  now: number = Date.now(),
): Promise<AdEnergyResponse> {
  return db.transaction(async (tx) => {
    /** ⚠️ 行锁：与 `addEnergy` 内部那次锁同一个理由 —— 并发请求要串起来排队 */
    const [row] = await tx
      .select({ energy: users.energy })
      .from(users)
      .where(eq(users.id, userId))
      .for('update')
      .limit(1)

    /**
     * ⚠️ 理论上到不了这里：`/api/user/*` 的 authMiddleware 查不到人就 403 了。
     *    但把它显式处理掉，好过 `row!.energy` 这种写法 —— 那是把"不可能"当成保证。
     */
    if (!row) return { ok: false, energyGained: 0, energy: 0, reason: 'unavailable' as const }

    /** ① 重放（响应丢包的重试 / 连点两下）—— **回 ok，点数不动** */
    if (await alreadyGranted(tx, userId, requestId)) {
      return { ok: true, energyGained: 0, energy: row.energy }
    }

    /** ② 最小间隔（挡脚本，不是产品日限） */
    if (adRewardTooSoon(await lastAdRewardAt(tx, userId), now)) {
      return { ok: false, energyGained: 0, energy: row.energy, reason: 'too-soon' as const }
    }

    /** ③ 发 —— 幂等键就是 (reason, refType, refId=requestId, user) */
    const granted = await addEnergy(tx, {
      userId,
      amount: AD_REWARD_ENERGY,
      reason: ENERGY_REASON.adReward,
      refType: AD_REWARD_REF_TYPE,
      refId: requestId,
    })

    /**
     * ⚠️ `addEnergy` 回 false 只有两种可能：这一笔已经有流水（并发下被另一个请求抢先），
     *    或者用户行没了。前者是**成功**（点数已在），照 ① 的口径回 ok。
     */
    if (!granted) return { ok: true, energyGained: 0, energy: row.energy }

    /**
     * ⚠️ 余额直接算 `锁里读到的 + 本次发放`，**不要再去 `readEnergy`** ——
     *    那个函数会先跑一次「每日补足」（一次写），在别人的事务里再开写不合适；
     *    而 `addEnergy` 正是按 `energy + amount` 写的，这里算出来与库里一致。
     */
    return { ok: true, energyGained: AD_REWARD_ENERGY, energy: row.energy + AD_REWARD_ENERGY }
  })
}
