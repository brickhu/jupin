import { COOKIE_PASS_LINE, formatScore } from '@jushuo/shared'
import type { ParticipationSubmissionsResponse } from '@jushuo/shared'

import { agoText } from './time'

/**
 * ⭐⭐ 朗读页下方「历史挑战」—— **我在这一句上读过几次、每次多少分**。
 *
 * 这一屏和「我的挑战」列表（pages/me/challenges）长的不是一回事，别混：
 *   · 那边回答「我**所有**的挑战记录」，一行还要显示句子本身（一句话换一个页面就要重看）；
 *   · 这边回答「**这一句**我读过几次」，句子是同一句、说了也白说，
 *     所以一行只留三个信息：**第几次 · 什么时候 · 多少分**。
 *
 * ⚠️⚠️ **列表里不含「当前这一次」**（SPEC 已定口径）。
 *    用户此刻正看着 s5 那个大号分数，下面再列一条一模一样的，
 *    他会以为"怎么多了一次"。判据是**提交 id**，不是分数或时间：
 *    同一句重复提交、幂等命中同一条时，只有 id 认得出"这两处是同一次"。
 *    ⚠️ 这条规则在**恢复出来的 s5**（上次出分没点重新挑战就退出了）上同样成立 ——
 *      两种 s5 在界面上长得一模一样，用户分不出是哪一种，所以不该有两种列表。
 *
 * ⚠️ 分数只走 shared 的 formatScore（一位小数，`—` 是"没有分"）——
 *    朗读页大号分数、结果屏、我的挑战列表用的是**同一个**格式化，
 *    这里自己 toFixed 的话，同一次提交在两屏里会差一个 0.1。
 */

/** 列表里的一行（显示形态与接口字段分开：WXML 里不做计算） */
export interface HistoryRow {
  submissionId: string
  /**
   * 这是这句上的第几次（从 1 开始）—— ⚠️ **服务端现算的，不是库里的列**
   * （`submissions.seq` 已删：存它就要养分配器 / 唯一索引 / 重编号脚本，而它只是个显示位置）。
   */
  seq: number
  /** '89.5' —— 成品文本，WXML 只负责摆；**没出分时是 '未出分'** */
  scoreText: string
  /**
   * ⚠️ 这一次**没出分**（服务端 `status='failed'`：检测跑到了、但没读出有效语音）。
   *    它照样占一个序号，所以要显示出来 —— 藏掉就会出现「第 4 次 → 第 6 次」的断档。
   */
  pending: boolean
  /** '刚刚' / '昨天 14:03' —— 北京时间、精确到分（见 lib/time.ts） */
  ago: string
  /** 是不是**目前**的最高分 —— 每行最多一个，用来标「最高」 */
  isBest: boolean
}

/** 一次历史列表的成品：行 + 表头要用的两个数 */
export interface HistoryRows {
  rows: HistoryRow[]
  /**
   * 这一句上**我一共挑战过几次**（含"未出分"的那些）——
   * ⚠️ 直接取服务端的 `attempts`，与卡片上那个数字**同一个来源**。
   */
  attempts: number
  /** 这些记录里的最高分（'89.5'）；一条都没有时是空串 */
  bestScoreText: string
  /** ⭐ **我**在这句上的最低分；一条有分的都没有时是空串 */
  /**
   * ⭐ **这一句我攻没攻克**（⭐ 用户 2026-10-09 要的：⭐ 去掉「最低」，换成已攻克/未攻克 ✓）
   *
   * ⚠️⚠️ 判据**不能想当然** ✗ —— 本仓那条规则是（⭐ shared/cookies.ts ✓）：
   *    `passLine = max(85, 我在这句的历史最好)` · `攻克 = score > passLine`（**严格大于** ✓）
   *    ⇒ ⚠️ 那是**每一把**的口径（"这一把有没有拿到饼干"✓）
   *
   * ⭐ 推到"**这一句**攻没攻克过"就简化成：⭐ **历史最高分 > 85** ✓✓
   *    ⚠️ 理由：任何一把只要 `score > 85`，它必然也 `> max(85, 该把之前的最好)` ✓
   *      （⭐ 因为"之前的最好" ≤ 全程最高 < score ✓）
   *    ⇒ ⭐ 所以只需要最高分和那根线 ✓ 不需要另算 passLine ✓
   *
   * ⚠️ 必须**严格大于**：`85` 本身不算攻克 ✓（⭐ 同 cookies.ts 的口径 ✓）
   * ⚠️ 一次都没出过分时是空串（⭐ 卡片显示 '—' ✓ 与另外三格一致 ✓）
   */
  /** ⭐ **我**在这句上的最低分；一条有分的都没有时是空串 */
  lowestScoreText: string
}

/**
 * 把接口响应变成列表要的行。
 *
 * @param res           `GET /api/user/participation/{articleId}/submissions` 的 data
 * @param excludeId     当前正看着的那一次提交（免掉它）；空串 = 没有要免的
 * @param now           只给单测用（相对时间要一个固定的"现在"）
 *
 * ⚠️ 最高分**在这批行里现算**，不直接用响应里的 `res.bestScore` ——
 *    那个数**包含**当前这一次（服务端算的是全部有分的记录），
 *    免掉当前这条之后，"最高"这件事可能就换人了。
 *    拿它去标「最高」会出现"一行都没标，而表头写着最高 89.5"。
 */
export function historyRowsOf(
  res: ParticipationSubmissionsResponse,
  excludeId: string,
  now: number = Date.now(),
): HistoryRows {
  const items = res.items.filter((i) => i.submissionId !== excludeId)
  /**
   * ⚠️ 只有**有分**的那些参与算最高分 / 最低分：
   *    `score` 为 null 的是「未出分」（检测跑到了但没读出有效语音）。
   *    ⚠️ 不能用 `0` 代替 null —— 0 分是合法成绩，两者混起来"最低分"就错了。
   */
  const scored = items.filter((i) => typeof i.score === 'number').map((i) => i.score as number)
  const best = scored.length === 0 ? null : Math.max(...scored)
  const worst = scored.length === 0 ? null : Math.min(...scored)
  return {
    rows: items.map((i) => ({
      submissionId: i.submissionId,
      seq: i.seq,
      scoreText: typeof i.score === 'number' ? formatScore(i.score) : '未出分',
      pending: typeof i.score !== 'number',
      ago: agoText(i.createdAt, now),
      // ⚠️ 并列最高时两行都标：这里要回答的是"哪些次是我的最好水平"，
      //    不是"哪一次是唯一的纪录"。
      isBest: best !== null && i.score === best,
    })),
    /**
     * ⚠️ 这是**列表那批**的条数（已免掉当前这一次）—— 与 `rows.length` 同一个口径。
     *    ⚠️ 别改成 `res.attempts`：那个是"我在这一句上的全部"（含当前这次），
     *      属于**摘要卡**口径。两张卡挨着放，口径一旦混就会互相打架。
     */
    attempts: items.length,
    bestScoreText: best === null ? '' : formatScore(best),
    /** ⭐ **我**在这句上的最低分（不是全场的，见 HistorySummary 的说明） */
    lowestScoreText: worst === null ? '' : formatScore(worst),
  }
}

/**
 * ⭐⭐ 朗读页那张「我的参与」摘要卡（用户 2026-09：做成 pages/me/participations 那样的卡片）。
 *
 * 四个数与「我的挑战」列表同一套：**挑战 / 最高 / 位列 / 最低**。
 *
 * ⚠️⚠️ 与 `historyRowsOf` 的口径差别（两张卡挨着放，最容易混的就是这里）：
 *    · **行**（历史挑战）免掉"当前这一次"，而**这张卡说的是"我在这一句上的全部"** ——
 *      所以它用响应里的 `attempts` / `bestScore`，**不**跟着免当前那一次。
 *      用户正看着 s5 的分数时，卡片上那个"最高"应该就是含这一把的当前水平。
 *    · 行里的「最高」是**标在某一行的角标**（哪几次是我的最好水平），两者不冲突。
 *
 * ⚠️ 名次 / 参与人数 / 最低分**只能来自服务端**（跨用户算的），别在端侧凑。
 * ⚠️ 「位列」写 `N / M`（同 participations 的 rankText）：只写「第 N」在 9 人的场
 *    和 900 人的场是两件事。
 */
export interface HistorySummary {
  /** '3 次'；一次都没有是 '0 次' */
  attemptsText: string
  /** 我的最好成绩 '89.5'；没出过分是 '—' */
  bestScoreText: string
  /** '2 / 18'；没名次（没出过分 / 服务端没给）是 '—' */
  rankText: string
  /** 全场最低分；没人参与是 '—' */
  /**
   * ⭐ **这一句我攻没攻克**（⭐ 用户 2026-10-09 要的：去掉「最低」，换成已攻克/未攻克 ✓）
   *
   * ⚠️⚠️ 判据**不能想当然** ✗ —— 本仓那条规则是（⭐ shared/cookies.ts ✓）：
   *    `passLine = max(85, 我在这句的历史最好)` · `攻克 = score > passLine`（**严格大于** ✓）
   *    ⇒ ⚠️ 那是**每一把**的口径（"这一把有没有拿到饼干"✓）
   *
   * ⭐ 推到「**这一句**攻没攻克过」就简化成：⭐ **历史最高分 > 85** ✓✓
   *    ⚠️ 理由：任何一把只要 `score > 85`，它必然也 `> max(85, 该把之前的最好)` ✓
   *      （⭐ 因为"该把之前的最好" ≤ 全程最高 < score ✓）
   *    ⇒ ⭐ 只需要最高分和那根线 ✓ 不必另算 passLine ✓
   *
   * ⚠️ 必须**严格大于**：`85` 本身不算攻克 ✓（⭐ 同 cookies.ts 的口径 ✓）
   * ⚠️ 一次都没出过分时是空串（⭐ 卡片显示 '—' ✓ 与另外三格一致 ✓）
   */
  conqueredText: string
}

/**
 * ⭐ **这一句攻没攻克** —— 判据只在这一个地方写（⭐ 见 HistorySummary.conqueredText ✓）
 *
 * ⚠️ `best` 可能是 null（⭐ 老数据 / 服务端没给 ✓）⇒ 当成"没出过分" ✓
 * ⚠️ 必须**严格大于**：`85` 本身不算攻克 ✓（⭐ 同 cookies.ts 的口径 ✓）
 */
export function conqueredTextOf(attempts: number, best: number | null): string {
  if (attempts <= 0 || best === null) return '—'
  return best > COOKIE_PASS_LINE ? '已攻克' : '未攻克'
}
export function historySummaryOf(res: ParticipationSubmissionsResponse): HistorySummary {
  return {
    attemptsText: res.attempts + ' 次',
    bestScoreText: formatScore(res.bestScore),
    rankText:
      // ⚠️ `> 0` 而不是"非 null"：服务端对"没参与过"的人给的是 rank=0
      //    （leaderboard 的约定），显示成「第 0 名」是句错话。
      typeof res.rank === 'number' && res.rank > 0
        ? res.rank + ' / ' + res.participantCount
        : '—',
    /**
     * ⭐ 这一句攻没攻克（⭐ 判据见 HistorySummary.conqueredText 的说明 ✓）
     * ⚠️ 用 `res.bestScore`（⭐ 含当前这一把 ✓ 与上面「最高」同一份数据 ✓），
     *    ⚠️ 不要再去 `historyRowsOf` 里绕一圈 —— 那是**列表那批**的口径（⭐ 免掉当前这次 ✓）
     * ⚠️ 一次都没出过分（attempts 为 0 / bestScore 为 0）给 '—' ✓
     *    （⭐ 与另外三格一致：⭐ 没数据时不硬说"未攻克"✓）
     */
    conqueredText: conqueredTextOf(res.attempts, res.bestScore),
  }
}
