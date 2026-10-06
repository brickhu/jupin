import { ENERGY_PER_CHALLENGE } from '@jushuo/shared'
import type { MakeupState } from '@jushuo/shared'

/**
 * ⭐ **补签区要展示的那一档** —— 判断全在这里做，WXML 只负责画。
 *
 * ⚠️ 与 `lib/submit-hint.ts` 同一个套路：把"该说哪句话"从界面里抽出来，
 *    因为**说话的方式本身就是产品决策**，值得被测住（而不是散在 WXML 的 wx:if 里）。
 *
 * ## 四个原因要说四句完全不同的话
 *
 * | 状态 | 用户要做的事 | 所以话要这么说 |
 * |---|---|---|
 * | 能补 | 花能量补，**然后今天还得读一句** | 把**总账**摆出来，别只说补签要几点 |
 * | 今天已读 | 明天再来 | 说明"缺口要在读**之前**补" |
 * | 断太久 | 重新开始 | ⚠️ **不说失败** —— 提"最长记录还在" |
 * | 没断档 | 什么都不用做 | 整块不出现（天天来的人不需要看到这个功能） |
 */

export type MakeupKind = 'none' | 'ready' | 'read-today' | 'too-long'

export interface MakeupView {
  /** none = 整块不渲染 */
  kind: MakeupKind
  /** 主标题 */
  title: string
  /** 账目 / 说明那一行 */
  note: string
  /** 能量不够时的提示（空 = 没有这一行） */
  short: string
  /** 按钮文案 */
  button: string
  /** 按钮能不能按（不够就别让他点 —— 点了必然失败） */
  canPress: boolean
}

export const NO_MAKEUP: MakeupView = {
  kind: 'none',
  title: '',
  note: '',
  short: '',
  button: '',
  canPress: false,
}

/**
 * @param makeup 服务端下发的补签状态（⚠️ 端侧**算不出来**，见 services/streak.ts）
 * @param energy 当前能量余额（只在算"还差几点"时用）
 */
export function makeupViewOf(makeup: MakeupState | undefined, energy: number): MakeupView {
  // 还没拿到服务端那份（或本来就没断档）⇒ 整块不出现
  if (!makeup) return NO_MAKEUP

  if (makeup.ok) {
    /**
     * ⚠️ 缺口 = `cost − 余额`。端侧算这个是因为**余额就在手上**；
     *    而"能不能补"仍然只信服务端（缺口要看 lastReadDate，那个字段不下发）。
     */
    const short = makeup.cost - energy
    return {
      kind: 'ready',
      title: '连断了 ' + makeup.gapDays + ' 天',
      /**
       * ⚠️⚠️ 必须是**总账**：用户看到"补签 3 点"会以为花 3 点就够了，
       *    而当天他还得读一句（再 2 点）。只说补签的价钱 = 让界面骗人。
       */
      note:
        '补签 ' +
        makeup.cost +
        ' 点 ＋ 今天读一句 ' +
        ENERGY_PER_CHALLENGE +
        ' 点 ＝ ' +
        makeup.totalCost +
        ' 点（补完今天读一句就接上了）',
      short: short > 0 ? '还差 ' + short + ' 点能量 —— 吃饼干（40 块换 1 点）或者充值' : '',
      button: short > 0 ? '能量不够' : '补签',
      // ⚠️ 不够就不让点：点下去必然失败，那是白白让他受一次挫
      canPress: short <= 0,
    }
  }

  if (makeup.reason === 'already-read-today') {
    return {
      ...NO_MAKEUP,
      kind: 'read-today',
      title: '今天已经读过了',
      note: '补签要在读之前做，明天再来看看',
    }
  }

  if (makeup.reason === 'too-long') {
    /**
     * ⚠️⚠️ 断太久**绝不能报成失败** —— 那是在用户已经难过的时候再补一刀。
     *    说成"重新开始"，并把"最长记录还在"摆出来（那一列不受断档影响）。
     */
    return {
      ...NO_MAKEUP,
      kind: 'too-long',
      title: '断了 ' + makeup.gapDays + ' 天，接不上了',
      note: '超过 3 天只能重新开始 —— 不过你最长的连战记录不会丢',
    }
  }

  // no-gap（天天来的人）与 not-enough-energy（只在补签那一刻才可能出现）都归这里
  return NO_MAKEUP
}
