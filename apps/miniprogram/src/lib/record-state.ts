import type { SubmissionStatusResponse } from '@jushuo/shared'

/** 服务端给的那三种状态（**别在这里再抄一份字面量** —— 抄了就会和 shared 漂） */
type SubmitStatus = SubmissionStatusResponse['status']

/**
 * ⭐⭐ **一个句子上的「参与」状态机**（prd §7.2，用户 2026-10 定）。
 *
 * ```
 * try ──点麦──▶ recorder ──stop/自动──▶ recoded ──✓──▶ energy-tips ──确认──▶ checking ──出分──▶ scored
 *                                                                                              │
 *                                                                                （确认更新）    │
 *                                                                                     ▼        │
 *                                                                                   retry ◀────┘
 * ```
 *
 * ## ⚠️⚠️ 为什么这一层必须是**纯函数**
 *
 * 状态来自**两个不同的地方**，而它们的可靠性完全不同：
 *
 * | 态 | 来自 | 为什么 |
 * |---|---|---|
 * | `recoded` | **端侧本地** | 那段录音还没提交，服务端根本不知道它存在 |
 * | `checking` / `scored` | 端侧记的 submissionId + **服务端**轮询回来的 status/confirmed | "出分没有""确认没有"只有服务端知道 |
 * | `retry` / `try` | **服务端**参与记录 | 有没有战绩，只有服务端知道 |
 *
 * ⚠️ 而"出分那一刻用户可能**不在这个页面上**"（prd §7.2）⇒ 拼状态这件事
 *    不能只在内存里做一次，必须能**从这两处重新拼出来**。
 *    ⚠️ 所以这里不碰任何 store / 请求，只做"给定这些事实，现在是哪一态"。
 *
 * ## 优先级（顺序就是语义，别调）
 *
 * 1. **本地有未提交的录音** ⇒ `recoded`（用户手里那段东西最重要，先让他看见）
 * 2. **那把提交还在打分** ⇒ `checking`
 * 3. **那把提交出分了但没确认** ⇒ `scored`（⭐ 与"确认过"是两态，见下）
 * 4. **确认过 / 有战绩** ⇒ `retry`
 * 5. 否则 ⇒ `try`
 *
 * ⚠️ 第 3 条与第 4 条的分界就是 `confirmed` —— 服务端 `SubmissionStatusResponse.confirmed`。
 *    **不能拿"有没有分数"当判据**：出分之后分数就有了，而那时它**还不算数**。
 */
export type RecordState = 'try' | 'retry' | 'recoded' | 'checking' | 'scored'

/** 端侧记着的那把提交（`submissionId` 是本地存的，`status`/`confirmed` 是轮询回来的） */
export interface PendingSubmission {
  submissionId: string
  status: SubmitStatus
  /** 服务端说的"这一把确认了吗" —— ⚠️ 不是"有没有分数" */
  confirmed: boolean
}

export interface RecordStateInput {
  /**
   * 服务端参与记录里的最高分（`null` = **明确没参与过**）。
   * ⚠️ 不要用 `undefined` 表示"没参与" —— 那是"还没拉到"，两件事（见 lib/participation.ts）。
   */
  bestScore: number | null
  /** 端侧：这一段还没提交的录音在不在 */
  hasPendingRecording: boolean
  /** 端侧记着的那把提交（没有就是 null） */
  pending: PendingSubmission | null
}

export function recordStateOf(input: RecordStateInput): RecordState {
  // ① 手里那段没提交的录音优先 —— 用户刚录完，界面必须停在"可以提交"上
  if (input.hasPendingRecording) return 'recoded'

  const pending = input.pending
  if (pending) {
    // ② 还在打分
    if (pending.status === 'scoring') return 'checking'
    /**
     * ③ 出分了但**还没确认** ⇒ `scored`（显示分数 + `›`，点它开面板）
     * ⚠️ 判据是 `confirmed`，不是 `status === 'scored'` —— 后者在确认之后**仍然**成立，
     *    拿它当判据会让"确认过了"永远停在 `scored`，`retry` 再也回不去。
     */
    if (pending.status === 'scored' && !pending.confirmed) return 'scored'
    // ④ `failed` / 已确认 ⇒ 这一把不再是"待办"，往下走看战绩
  }

  return input.bestScore !== null ? 'retry' : 'try'
}

/**
 * 「参与区」该显示的那个分数（`retry` / `scored` 用）。
 *
 * ⚠️ 两个态的分数**来源不同，绝不能合并**：
 *   · `retry`  = 服务端参与记录的**战绩**（已确认的最高分）
 *   · `scored` = **这一把**的分数（还没写进战绩）
 *
 * ⚠️⚠️ **`scored` 时拿不到这一把的分就返回 `null`，不许退回战绩**（2026-10-15 修的真实 bug）。
 *
 *    原来这里写的是 `pendingScore ?? bestScore`，理由是"别显示空白" ——
 *    而它的实际后果是：点完能量确认、检测还在跑的那一刻，界面上**冒出一个分数，
 *    那个分数还是历史最高**。用户的原话是：
 *
 *      「你能量扣除确认后，直接把历史最高分展示出来了 —— 应该是 loading 状态啊」
 *
 *    根因是两层错叠在一起：① `scored` 被过早判出来（见 participate-flow 的 restore）；
 *    ② 这里又把战绩当成这一把的分**补了上去**。
 *    ⇒ 只要有一层错，"一个不属于这一次的分数"就会被显示得像真的一样。
 *    两处都要堵死：**宁可什么都不显示，也不显示一个错的分。**
 */
export function displayScoreOf(
  state: RecordState,
  p: { bestScore: number | null; pendingScore: number | null },
): number | null {
  /** ⭐ `scored` 只认这一把的分；没有就是 null（调用方渲染成"不显示分数"） */
  if (state === 'scored') return p.pendingScore
  if (state === 'retry') return p.bestScore
  return null
}
