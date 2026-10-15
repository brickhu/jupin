import { isNotNull } from 'drizzle-orm'

import { submissions } from '../db/schema'

/**
 * ⭐⭐ **「这一条提交算不算战绩」的唯一判据**（prd §7.2「确认 = 唯一真正的结算」）。
 *
 * 出分只是"算出了一个数"，**用户确认之后它才算数** —— 所以凡是"我在这句上的成绩 / 前高 /
 * 参与记录 / 榜单"都要过这一条；而"这一把的分数本身"（结果面板上那个数）**不过**它。
 *
 * ⚠️⚠️ **判据只此一处，谁也不许把这行条件抄到自己的 where 里**。
 *    抄一份的症状很隐蔽：**两处口径不同**，于是"明明超越了却显示没超越"、
 *    "战绩涨了但榜单没动"这类**数字对不上**的问题 ——
 *    不报错、类型不报错、测试也未必红。
 *    （真实发生过：`participations.scoredOf` 过滤了 confirmed，而 `getBestExcluding`
 *      没过滤 ⇒ 出分面板拿一个**没算数的分**当"前高"，于是永远显示「保留战绩」。）
 *
 * ⚠️ 目前两个调用方：`participations.ts` 的 `scoredOf`（参与记录/榜单）
 *    与 `leaderboard.ts` 的 `getBestExcluding`（面板上的"前高"）。
 *    由 `record-rule.test.ts` 盯着"别绕开它自己写条件"。
 */
export function countedAsRecord() {
  return isNotNull(submissions.confirmedAt)
}
