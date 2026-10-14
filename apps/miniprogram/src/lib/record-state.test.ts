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

  it('scored 但这一把的分还没传过来 ⇒ 退回战绩（不显示空白）', () => {
    expect(displayScoreOf('scored', { bestScore: 92.5, pendingScore: null })).toBe(92.5)
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
