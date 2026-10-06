import { MAX_MAKEUP_DAYS, makeupCostOf } from '@jushuo/shared'
import type { MakeupState } from '@jushuo/shared'

/**
 * ⭐ **连战提醒的分级** —— 打开小程序时该提醒到什么程度。规格：prd §7.8.1。
 *
 * ## 为什么分五级、而不是一句固定的话
 *
 * ⚠️ **紧迫程度是真的在变**：补签上限 3 天 ⇒ 断 1 天还有 2 天机会、断 3 天
 *    就是今天。全都说成同一句"你断档了"，用户区分不出"现在做"还是"回头再说"。
 *
 * | 打断强度 | 什么时候用 | 为什么 |
 * |---|---|---|
 * | 不出现   | 今天读过了 | 他已经在做了，别再吵 |
 * | 一行轻提示 | 今天还没读（**还没断**）| 这是**预防**，不是补救 —— 价值最高 |
 * | 一行 + 补签 | 断 1 天 | 还有时间，轻轻说一句 |
 * | 卡片     | 断 2 天 | 升级一次，但仍不打断 |
 * | **弹窗** | 断 3 天（**最后一天**）| ⚠️ 弹窗是最强的打断，**只配给真的最后机会** |
 * | 引导重启 | 断 ≥4 天 | ⚠️ **不报失败** —— 提"最长的还在" |
 *
 * ⚠️⚠️ **稀缺必须是真的**：上限 3 天是硬的，所以"还剩 N 天"不是倒计时话术。
 *    假的倒计时会损害信任，而这里**不需要造假**。
 * ⚠️ **说"还剩几天"，不说"你哪天断的"** —— 时间压力比日期有效。
 */

export type NudgeLevel =
  /** 不提醒（今天读过了 / 还没有连战可救） */
  | 'none'
  /** 今天还没读，但**还没断** —— 预防 */
  | 'today'
  /** 断 1 天 —— 轻提示 */
  | 'gap1'
  /** 断 2 天 —— 卡片 */
  | 'gap2'
  /** 断 3 天（最后一天）—— 弹窗 */
  | 'gap3'
  /** 断 ≥4 天 —— 引导重启（⚠️ 不是失败） */
  | 'restart'

export interface StreakNudge {
  level: NudgeLevel
  /** 主文案 */
  title: string
  /** 副文案 */
  note: string
  /** 按钮文案（'none' 与 'today' 时为空） */
  action: string
  /** 断档天数（'today' 与 'none' 时是 0） */
  gapDays: number
  /** 补签要花几点（只有 gap* 有意义） */
  cost: number
}

const NOTHING: StreakNudge = { level: 'none', title: '', note: '', action: '', gapDays: 0, cost: 0 }

/**
 * @param makeup    服务端下发的补签状态（端侧算不出来，见 services/streak.ts）
 * @param readToday 服务端判定的"今天读没读"（不信客户端时钟）
 * @param streakBest 历史最长连战 —— ⚠️ 只在"重来"那一档用，它**不受断档影响**
 */
export function streakNudgeOf(
  makeup: MakeupState | undefined,
  readToday: boolean,
  streakBest: number,
): StreakNudge {
  // 今天读过了 ⇒ 别再吵他。他已经在做这件事了。
  if (readToday) return NOTHING

  // 还没拿到服务端那份 ⇒ **什么都不说**（编一句是在替服务端下结论）
  if (!makeup) return NOTHING

  if (makeup.ok) {
    const gap = makeup.gapDays
    const cost = makeupCostOf(gap)
    /** ⚠️ 还剩几天能补：今天是最后一天时是 0 —— 这个数是**真的**（上限 3 天是硬的） */
    const room = MAX_MAKEUP_DAYS - gap

    if (gap === 1) {
      return {
        level: 'gap1',
        title: '昨天没读 · 断了 1 天',
        note: '还有 ' + room + ' 天可以补 —— 补签 ' + cost + ' 点就能接上',
        action: '去补签',
        gapDays: gap,
        cost,
      }
    }
    if (gap === 2) {
      return {
        level: 'gap2',
        title: '断了 2 天',
        note: '还有 ' + room + ' 天可以补（补签 ' + cost + ' 点）—— 再不来就补不了了',
        action: '去补签',
        gapDays: gap,
        cost,
      }
    }
    return {
      level: 'gap3',
      title: '断了 3 天 · **今天是最后一天**',
      note: '补签 ' + cost + ' 点就能接上 —— 明天起就只能重新开始了',
      action: '去补签',
      gapDays: gap,
      cost,
    }
  }

  // ⭐ 还没断档，只是今天没读（预防 —— 这一档的价值比补签高，因为不用补）
  if (makeup.reason === 'no-gap') {
    return {
      level: 'today',
      title: '今天还没读',
      note: streakBest > 0 ? '连战还连着，读一句就续上' : '读一句就开个头',
      action: '',
      gapDays: 0,
      cost: 0,
    }
  }

  // ⚠️⚠️ 断太久 ⇒ **不报失败**。说成"重新开始"，并把"最长的还在"摆出来：
  //    那一列不受断档影响，所以"重来"没那么痛（prd §7.8）。
  if (makeup.reason === 'too-long') {
    return {
      level: 'restart',
      title: '连战重来了',
      note:
        streakBest > 0
          ? '不过你最长的 ' + streakBest + ' 天还在 —— 从今天开始新的一根'
          : '从今天开始新的一根',
      action: '',
      gapDays: makeup.gapDays,
      cost: 0,
    }
  }

  // already-read-today / not-enough-energy 都不该走到这里（前者 readToday 已拦、后者只在补签时出现）
  return NOTHING
}
