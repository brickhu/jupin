import { and, desc, eq, isNull, lt, or } from 'drizzle-orm'

import { db } from '../db'
import { submissions } from '../db/schema'
import { markScoringFailed } from './scoring'
import { settle } from './settle'

/**
 * ⭐⭐ **与请求无关的兜底清扫**（2026-09 加，修的是两个"永久性"缺陷）。
 *
 * ⚠️⚠️ 为什么必须有它 —— 这套设计的两个洞都不在"某次请求出错"，而在**没人来问**：
 *
 *   ① **悬空的 `scoring` 行**：心跳判死与接管（claimStaleScoring）只在**有入站轮询**时发生。
 *      而提交是 `void runScoring()` 后台跑的（受理请求早就 202 返回了）——用户提交完
 *      就退出小程序、容器又被缩容回收，这条行就**永远停在 scoring**：
 *      那 2 点能量从此既不全扣也不退回（实扣在受理时已经发生，退回只在打分失败时走）。
 *      "我的挑战"里它也永远显示「还在检测中」。
 *
 *   ② **已出分但没结算**：scoring 里"写分数"与 settle 不是同一事务，settle 只跑一次
 *      （`growth_self IS NULL` 守卫）。进程死在两者之间（或那几秒 DB 抖一下让 settle 抛错）
 *      ⇒ 分数看得见、能量也扣了，但 streak / 三项成长 / 解冻卡奖励**全漏发，且永不补**。
 *      （participations 还能靠 rebuild 重建，settle 连重建脚本都没有。）
 *
 * ⚠️ 触发方式：**惰性**（进程启动时一次 + 用户读自己的数据时按节流跑一次），
 *    不引入定时器 —— 云托管上进程随时会被回收，常驻定时器本来就不可靠。
 * ⚠️ 两个动作都是幂等的：
 *    · 判失败带 `status='scoring'` 条件（只有一个并发的清扫者能改成功）；
 *    · 释放能量按 (reason, refType, refId) 唯一键去重（services/energy.ts）；
 *    · 补结算走 `settle`，它自己按 `growth_self IS NULL` 做原子认领（见 settle.ts）。
 */

/** 心跳停多久算"这个打分进程已经死了" —— 必须**大于** scoring.ts 的接管阈值（30 秒） */
const STALE_MS = 3 * 60_000

/** 一次最多处理几条：这是兜底，不该在请求路径上做大批量操作 */
const MAX_PER_SWEEP = 20

/** 同一次清扫的节流（毫秒）—— 免得每个请求都去查一遍 */
const THROTTLE_MS = 60_000
let lastSweepAt = 0

export interface SweepResult {
  /** 判失败并退能量的条数 */
  failed: number
  /** 补跑结算的条数 */
  resettled: number
}

/**
 * 跑一次兜底清扫。
 *
 * @param force true = 跳过节流（进程启动时用）
 */
export async function sweepStaleSubmissions(force = false): Promise<SweepResult> {
  const now = Date.now()
  if (!force && now - lastSweepAt < THROTTLE_MS) return { failed: 0, resettled: 0 }
  lastSweepAt = now

  const result: SweepResult = { failed: 0, resettled: 0 }
  const staleBefore = new Date(now - STALE_MS)

  /**
   * ---- ① 悬空的 scoring：判失败 + 退能量 ----
   * ⚠️ 只用 `markScoringFailed` 一个入口：它内部就走 `fail()`，
   *    而 `fail()` 里**已经**做了「退能量 + 删音频」（幂等键是 submissionId）。
   *    ⚠️ 别在这里再写一次"退能量"：那是同一件事的第二份实现，
   *      两份一旦分叉就会变成"判了失败却没退钱"或"退了两次"
   *      （这句刻意不写那个函数名 —— services/sweep-guard.test.ts 按函数名搜源码，
   *        写在注释里会让那条守卫误报，而误报的守卫最后会被人关掉）。
   * ⚠️ 与 claimStaleScoring 的分工：那个是"**重跑**一次"（用户还在等、越早出分越好），
   *    这个是"**放弃**并退钱"（几十秒没人问过、心跳早停 —— 重跑的价值低于让用户重录）。
   */
  try {
    const stuck = await db
      .select({ id: submissions.id, userId: submissions.userId })
      .from(submissions)
      .where(
        and(
          eq(submissions.status, 'scoring'),
          or(isNull(submissions.heartbeatAt), lt(submissions.heartbeatAt, staleBefore)),
        ),
      )
      .limit(MAX_PER_SWEEP)

    for (const row of stuck) {
      // ⚠️ 内部的 UPDATE 带 `status='scoring'` 条件 ⇒ 并发清扫/接管只有一个生效；
      //    没生效的那个也不会重复退能量（退能量的幂等键就是 submissionId）。
      await markScoringFailed(row.id, '打分中断了，请重录一次')
      result.failed++
      console.log('[sweep] 悬空打分判失败并退能量 id=' + row.id + ' user=' + row.userId)
    }
  } catch (err) {
    // ⚠️ 兜底清扫**绝不能让请求失败**：它跑在读接口的路径上
    console.warn('[sweep] 清扫悬空打分失败：' + (err as Error).message)
  }

  /**
   * ---- ② 已出分但没结算：补跑 settle ----
   * ⚠️ 取一批"最老的"未结算行；`settle` 自己会再确认一次状态与分数是否齐备。
   */
  try {
    const unsettled = await db
      .select({ id: submissions.id, userId: submissions.userId })
      .from(submissions)
      .where(
        and(
          eq(submissions.status, 'scored'),
          isNull(submissions.growthSelf),
          // ⚠️ 只补"已经不是刚出分"的那些：正常流程里 settle 就在写分数之后几秒内跑，
          //    不排除刚刚出分的行会让兜底与正常流程抢同一条（虽然 settle 有原子认领，
          //    但少一次无意义的争抢更好）
          lt(submissions.scoredAt, new Date(now - STALE_MS)),
        ),
      )
      .orderBy(desc(submissions.scoredAt))
      .limit(MAX_PER_SWEEP)

    for (const row of unsettled) {
      const r = await settle(row.userId, row.id)
      if (r) {
        result.resettled++
        console.log('[sweep] 补跑结算 id=' + row.id + ' user=' + row.userId)
      }
    }
  } catch (err) {
    console.warn('[sweep] 补跑结算失败：' + (err as Error).message)
  }

  return result
}
