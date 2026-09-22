import { and, count, eq, gte } from 'drizzle-orm'
import { TOP_RECORD_FLOOR, UNFREEZE_EVERY_DAYS, dayStartUtc, today as dayOf } from '@jushuo/shared'

import { db } from '../db'
import { rewardGrants, rewardRules, users } from '../db/schema'
import { addEnergy } from './energy'
import { grantUnfreezeCard } from './unfreeze'

/**
 * ⭐ 奖励系统 —— 规则可增删，但**下发只有一条路**（grantReward）。
 * 规格：docs/design/reward-system.md。
 *
 * ⚠️⚠️ 三条硬约束，改这个文件之前先读：
 *    ① **触发器是封闭枚举**（streak_milestone / sentence_top_exceed），
 *       不是自由表达式。加新触发点要发版，但不改求值器 ——
 *       自由表达式引擎没法测、也没法向用户解释。
 *    ② **改配置不追溯**：规则只对 starts_at 之后的事件生效（靠 reward_grants 落库）。
 *    ③ **幂等**：unique(rule_code, ref_type, ref_id, user_id) 是整套系统的安全底。
 *
 * ⚠️ 结算**只在一个地方发生**（services/settle.ts），轮询 / 幂等重放 / 任务接管
 *    都不结算 —— 否则同一次挑战会被发好几次。
 */

export const TRIGGER = {
  /** 本次读让 streakDays 跨过阈值 */
  streakMilestone: 'streak_milestone',
  /** 本次得分 严格大于 max(提交前的全场最高分, threshold) */
  sentenceTopExceed: 'sentence_top_exceed',
} as const

export type RewardKind = 'unfreeze' | 'energy'

/** 预设规则的 code —— 与 reward_rules.code 一一对应 */
export const RULE_CODE = {
  streakUnfreeze: 'streak_unfreeze_7',
  sentenceTopRecord: 'sentence_top_record',
} as const

export interface RewardRule {
  code: string
  trigger: string
  /** 解析后的结构化参数（threshold 等） */
  params: { threshold?: number }
  rewardKind: RewardKind
  rewardAmount: number
  enabled: boolean
  dailyCap: number | null
  lifetimeCap: number | null
}

export async function listRules(): Promise<RewardRule[]> {
  const rows = await db.select().from(rewardRules)
  return rows.map((r) => ({
    code: r.code,
    trigger: r.trigger,
    params: parseParams(r.params),
    rewardKind: r.rewardKind as RewardKind,
    rewardAmount: r.rewardAmount,
    enabled: r.enabled,
    dailyCap: r.dailyCap,
    lifetimeCap: r.lifetimeCap,
  }))
}

function parseParams(raw: string | null): { threshold?: number } {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { threshold?: number }
    return typeof parsed?.threshold === 'number' ? { threshold: parsed.threshold } : {}
  } catch {
    // ⚠️ 一条坏配置不该把整个结算带崩 —— 当成"没有参数"用默认值
    return {}
  }
}

/**
 * ⭐ 把两条预设规则写进库（**幂等**，只在缺的时候插）。
 *
 * ⚠️ 为什么要有它：规则表是唯一的配置源，空表 = 什么都不发 ——
 *    而"什么都不发"是**静默**的，没人会报错。启动时补一次，杜绝这种状态。
 * ⚠️ 只在**缺**的时候插：运营改过的阈值不会被启动覆盖（改配置不追溯）。
 */
export async function ensureDefaultRules(): Promise<void> {
  await db
    .insert(rewardRules)
    .ignore()
    .values([
      {
        code: RULE_CODE.streakUnfreeze,
        trigger: TRIGGER.streakMilestone,
        params: JSON.stringify({ threshold: UNFREEZE_EVERY_DAYS }),
        rewardKind: 'unfreeze',
        rewardAmount: 1,
      },
      {
        code: RULE_CODE.sentenceTopRecord,
        trigger: TRIGGER.sentenceTopExceed,
        params: JSON.stringify({ threshold: TOP_RECORD_FLOOR }),
        rewardKind: 'energy',
        rewardAmount: 1,
      },
    ])
}

/* ------------------------------------------------------------------ */
/* 求值                                                                */
/* ------------------------------------------------------------------ */

export interface RewardContext {
  userId: number
  submissionId: string
  score: number
  /** 本次读之前 / 之后的连续天数 */
  streakBefore: number
  streakAfter: number
  /** 提交前的**全场最高分**（榜单最高分，排除本次提交） */
  sentenceTop: number
  /** 本条提交之前存的「上次发卡时的 streakDays」 */
  unfreezeMarker: number
  now?: Date
}

export interface GrantedReward {
  ruleCode: string
  kind: RewardKind
  amount: number
}

/**
 * ⭐ 求值 + 发放。返回**这一条提交实际发出的奖励**（结果页要展示）。
 *
 * ⚠️ 这里会**改 users.unfreezeMarkerStreak**（规则 A 的记账位）——
 *    只在真的发出去了才推进，否则下一次还得重来。
 */
export async function evaluateRewards(ctx: RewardContext): Promise<GrantedReward[]> {
  const rules = (await listRules()).filter((r) => r.enabled)
  const out: GrantedReward[] = []
  const now = ctx.now ?? new Date()

  for (const rule of rules) {
    const threshold = rule.params.threshold
    if (typeof threshold !== 'number') continue

    let matched = false

    if (rule.trigger === TRIGGER.streakMilestone) {
      /**
       * ⚠️ 判据是「**自从上一次发卡以来**连续了 >= threshold 天」，
       *    不是「streakDays 跨过阈值」—— 后者只能触发一次，
       *    而这条规则要的是**每满 7 天各发一张**（与旧行为一致，老用户不会少卡）。
       * ⚠️ 断档时 marker 归 0（streakDays 变小了 = 重新开始数）。
       */
      const marker = ctx.streakAfter < ctx.unfreezeMarker ? 0 : ctx.unfreezeMarker
      matched = ctx.streakAfter - marker >= threshold
      if (matched) {
        const granted = await grantReward({
          userId: ctx.userId,
          ruleCode: rule.code,
          kind: rule.rewardKind,
          amount: rule.rewardAmount,
          refType: 'submission',
          refId: ctx.submissionId,
          now,
        })
        if (granted) {
          await db
            .update(users)
            .set({ unfreezeMarkerStreak: ctx.streakAfter })
            .where(eq(users.id, ctx.userId))
          out.push({ ruleCode: rule.code, kind: rule.rewardKind, amount: rule.rewardAmount })
        }
      }
      continue
    }

    if (rule.trigger === TRIGGER.sentenceTopExceed) {
      /**
       * ⭐ 奖励**真正的破纪录者**：本次得分必须**严格大于**
       *    max(提交前的全场最高分, 75)。
       *
       * ⚠️ 严格大于 ⇒ **追平不算**（全场最高 96 时，再读一个 96 不发，97 才发）。
       * ⚠️ 基准是**全场最高分**，不是"我在这句的历史最高分" —— 这两件事在
       *    自我超越里也是分开的，别顺手统一（见 growth-and-energy.md 第 10 节）。
       * ⚠️ 首读（全场还没人）时 sentenceTop = 0 ⇒ 基准就是 75 ⇒ 76 分以上才发。
       */
      matched = ctx.score > Math.max(ctx.sentenceTop, threshold)
      if (matched) {
        const granted = await grantReward({
          userId: ctx.userId,
          ruleCode: rule.code,
          kind: rule.rewardKind,
          amount: rule.rewardAmount,
          refType: 'submission',
          refId: ctx.submissionId,
          now,
        })
        if (granted) {
          out.push({ ruleCode: rule.code, kind: rule.rewardKind, amount: rule.rewardAmount })
        }
      }
      continue
    }

    // 未知触发器：说明代码和库里的配置对不上（比如回滚了代码但没停规则）。
    // ⚠️ 不静默跳过 —— 静默跳过会让"配置看着是开的、其实从来没生效"。
    console.warn('[rewards] 未知触发器，已跳过：' + rule.code + ' / ' + rule.trigger)
  }

  return out
}

/* ------------------------------------------------------------------ */
/* 下发（唯一入口）                                                     */
/* ------------------------------------------------------------------ */

/**
 * ⭐⭐ **下发奖励的唯一入口** —— 加规则不用动这里。
 *
 * ~~~
 * ① 幂等命中？          → 退出
 * ② 配额（日 / 终身）超了？ → 退出
 * ③ 写发放流水（唯一键兜底并发）
 * ④ 按 kind 落地：unfreeze → 插一张卡；energy → 加余额 + 流水
 * ~~~
 *
 * ⚠️ ③④ 必须在**同一个事务**里：只写了发放记录、东西没给出去，
 *    用户会永远拿不到（幂等键把它挡住了）。
 * ⚠️ 新增一种奖励**种类**（比如以后发"皮肤"）= 只在 ④ 加一个分支。
 */
export async function grantReward(input: {
  userId: number
  ruleCode: string
  kind: RewardKind
  amount: number
  refType: string
  refId: string
  now?: Date
}): Promise<boolean> {
  const now = input.now ?? new Date()

  return db.transaction(async (tx) => {
    // ① 幂等
    const [dup] = await tx
      .select({ id: rewardGrants.id })
      .from(rewardGrants)
      .where(
        and(
          eq(rewardGrants.ruleCode, input.ruleCode),
          eq(rewardGrants.refType, input.refType),
          eq(rewardGrants.refId, input.refId),
          eq(rewardGrants.userId, input.userId),
        ),
      )
      .limit(1)
    if (dup) return false

    // ② 配额 —— 防正反馈失控（奖励发能量 ⇒ 多读 ⇒ 更多提交 ⇒ 更多奖励）
    const [rule] = await tx.select().from(rewardRules).where(eq(rewardRules.code, input.ruleCode)).limit(1)
    if (rule) {
      if (rule.dailyCap !== null) {
        const [row] = await tx
          .select({ n: count() })
          .from(rewardGrants)
          .where(
            and(
              eq(rewardGrants.userId, input.userId),
              eq(rewardGrants.ruleCode, input.ruleCode),
              gte(rewardGrants.createdAt, dayStartUtc(dayOf(now))),
            ),
          )
        if (Number(row?.n ?? 0) >= rule.dailyCap) return false
      }
      if (rule.lifetimeCap !== null) {
        const [row] = await tx
          .select({ n: count() })
          .from(rewardGrants)
          .where(
            and(eq(rewardGrants.userId, input.userId), eq(rewardGrants.ruleCode, input.ruleCode)),
          )
        if (Number(row?.n ?? 0) >= rule.lifetimeCap) return false
      }
    }

    // ③ 发放流水（reward_kind / reward_amount 存**快照**：规则后来改了，历史不变）
    await tx.insert(rewardGrants).values({
      userId: input.userId,
      ruleCode: input.ruleCode,
      refType: input.refType,
      refId: input.refId,
      rewardKind: input.kind,
      rewardAmount: input.amount,
    })

    // ④ 落地
    if (input.kind === 'energy') {
      // ⚠️ reason 用规则 code，流水能追溯到规则
      await addEnergy(tx, {
        userId: input.userId,
        amount: input.amount,
        reason: input.ruleCode,
        refType: input.refType,
        refId: input.refId,
      })
    } else {
      await grantUnfreezeCard({ userId: input.userId, ruleCode: input.ruleCode, now }, tx)
    }

    return true
  })
}
