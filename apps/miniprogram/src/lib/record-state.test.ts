import { describe, expect, it } from 'vitest'

import { displayScoreOf, recordStateOf, type RecordStateInput } from './record-state'

const base: RecordStateInput = {
  bestScore: null,
  hasPendingRecording: false,
  pending: null,
}

/**
 * ⚠️⚠️ 这组用例守的是 prd §7.2 那个**五态状态机**，尤其是两处最容易写错的地方：
 *
 *   ① `scored` 与 `retry` 的分界是 **`confirmed`，不是 `status === 'scored'`** ——
 *      拿 status 当判据的话，确认之后 status 仍然是 'scored'，
 *      界面会**永远停在 `scored`**，`retry` 再也回不去（用户看到的是"我确认了但它还在等我确认"）。
 *   ② **本地那段没提交的录音优先级最高** —— 否则用户刚录完却被显示成"已参与"，
 *      他会以为录音丢了。
 */
describe('参与状态机 —— 五态派生', () => {
  it('什么都没发生过 ⇒ try（没参与过）', () => {
    expect(recordStateOf(base)).toBe('try')
  })

  it('有战绩 ⇒ retry', () => {
    expect(recordStateOf({ ...base, bestScore: 92.5 })).toBe('retry')
  })

  it('⭐ 本地有未提交录音 ⇒ recoded（**优先级最高**，压过一切）', () => {
    expect(recordStateOf({ ...base, hasPendingRecording: true })).toBe('recoded')
    // 即使有战绩、即使那把提交还在打分，也必须是 recoded
    expect(
      recordStateOf({
        ...base,
        hasPendingRecording: true,
        bestScore: 92.5,
        pending: { submissionId: 'a', status: 'scoring', confirmed: false },
      }),
    ).toBe('recoded')
  })

  it('那把提交还在打分 ⇒ checking', () => {
    expect(
      recordStateOf({
        ...base,
        bestScore: 92.5,
        pending: { submissionId: 'a', status: 'scoring', confirmed: false },
      }),
    ).toBe('checking')
  })

  it('⭐ 出分但**没确认** ⇒ scored', () => {
    expect(
      recordStateOf({
        ...base,
        bestScore: 92.5,
        pending: { submissionId: 'a', status: 'scored', confirmed: false },
      }),
    ).toBe('scored')
  })

  it('⭐⭐ 出分且**已确认** ⇒ retry（这一条就是上面那个坑）', () => {
    expect(
      recordStateOf({
        ...base,
        bestScore: 95,
        pending: { submissionId: 'a', status: 'scored', confirmed: true },
      }),
    ).toBe('retry')
  })

  it('确认了但还没有战绩（边界）⇒ try，不是 scored', () => {
    // ⚠️ 理论上不该出现（确认就会写参与记录）；真出现了也不能卡在 scored
    expect(
      recordStateOf({
        ...base,
        pending: { submissionId: 'a', status: 'scored', confirmed: true },
      }),
    ).toBe('try')
  })

  it('那把提交失败了 ⇒ 落回 try / retry（失败不占状态位）', () => {
    const failed = { submissionId: 'a', status: 'failed' as const, confirmed: false }
    expect(recordStateOf({ ...base, pending: failed })).toBe('try')
    expect(recordStateOf({ ...base, bestScore: 92.5, pending: failed })).toBe('retry')
  })

  it('status=scored 但没带 pending（只有战绩）⇒ retry', () => {
    expect(recordStateOf({ ...base, bestScore: 88 })).toBe('retry')
  })
})

describe('参与区显示哪个分数', () => {
  it('⭐ scored 显示**这一把**的分（不是战绩）', () => {
    expect(displayScoreOf('scored', { bestScore: 92.5, pendingScore: 76.5 })).toBe(76.5)
  })

  it('⭐⭐ scored 但这一把的分还没到 ⇒ **null**（绝不拿战绩顶替）', () => {
    // ⚠️⚠️ 这条是 2026-10-15 修的真实 bug：原来返回 92.5（战绩），
    //    于是"检测还在跑"的那一刻界面上冒出一个**不属于这一把的分数**。
    expect(displayScoreOf('scored', { bestScore: 92.5, pendingScore: null })).toBeNull()
  })

  it('retry 显示**战绩**', () => {
    expect(displayScoreOf('retry', { bestScore: 92.5, pendingScore: 99 })).toBe(92.5)
  })

  it('其余三态不显示分数', () => {
    for (const s of ['try', 'recoded', 'checking'] as const) {
      expect(displayScoreOf(s, { bestScore: 92.5, pendingScore: 99 }), s).toBeNull()
    }
  })
})

describe('⭐ 提交之后那一刻（2026-10-15 修的真实 bug）', () => {
  /**
   * ⚠️⚠️ 用户原话：「你能量扣除确认后，直接把历史最高分展示出来了 —— 应该是 loading 状态」
   *
   * 这是一条**回归测试**：那一刻的事实是"只有 submissionId、result 还没有"，
   * 而它必须落成 `checking`（转圈），**不是** `scored`（分数 + ›）。
   * ⚠️ 当时还有第二层错叠着：`displayScoreOf('scored', …)` 在前一分未知时会**退回战绩**
   *    ⇒ 于是一个"不属于这一把的分数"被显示得像真的一样。两层现在都堵死了。
   */
  it('只有 submissionId、还没有结果 ⇒ checking（转圈），且**不显示任何分数**', () => {
    const input: RecordStateInput = {
      /** ⚠️ 故意给一个历史战绩：它就是当时被错显示的 92.5 */
      bestScore: 92.5,
      hasPendingRecording: false,
      pending: { submissionId: 'a', status: 'scoring', confirmed: false },
    }
    const state = recordStateOf(input)
    expect(state).toBe('checking')
    // 关键：这一态**必须**没有可显示的分数（有的话就会把 92.5 显出来）
    expect(displayScoreOf(state, { bestScore: 92.5, pendingScore: null })).toBeNull()
  })

  it('出分那一刻 ⇒ scored，且显示的是**这一把**的分（不是 92.5）', () => {
    const state = recordStateOf({
      bestScore: 92.5,
      hasPendingRecording: false,
      pending: { submissionId: 'a', status: 'scored', confirmed: false },
    })
    expect(state).toBe('scored')
    expect(displayScoreOf(state, { bestScore: 92.5, pendingScore: 76.5 })).toBe(76.5)
  })
})
