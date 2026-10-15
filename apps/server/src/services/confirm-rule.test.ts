import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { mergeWeakPoints, weakPointsOf } from './weak-points'

/**
 * ⭐⭐ 守的是**确认那一刻的规则**（prd §7.2，用户 2026-10-15 定）。
 *
 * 两张表的分工：`submissions` = 临时成绩单（只增不改、不参与竞技）；
 * `participations` = 竞技档案。确认 = "拿成绩单去更新档案"，规则四条：
 *   ① 分 **≥** 前高 ⇒ **采纳**（分数/明细/录音换成新的；⚠️ **等于也采纳**）
 *   ② 分 **<** 前高 ⇒ 这三样**保留**
 *   ③ **两条路都要**：挑战次数 +1 · 薄弱词累计（**合并不是覆盖**）· 总结重生成
 *   ④ 语音：被采纳 ⇒ 保留；**没采纳 ⇒ 删**
 */
describe('薄弱词汇：累计的规则（事实，不是 AI 说的）', () => {
  const ws = (word: string, score: number, dp?: string) => ({ word, score, dp }) as never

  it('⭐ 只收"没读好"的词（与逐词高亮同一根线）', () => {
    expect(weakPointsOf([ws('invent', 60), ws('the', 95)]).map((w) => w.word)).toEqual(['invent'])
  })

  it('⭐⭐ 两次都错同一个词 ⇒ 次数累加、lowest 取更低的', () => {
    const merged = mergeWeakPoints(weakPointsOf([ws('invent', 60)]), weakPointsOf([ws('invent', 40, 'mispronunciation')]))
    expect(merged).toHaveLength(1)
    const first = merged[0]!
    expect(first.count).toBe(2)
    expect(first.lowest).toBe(40)
    expect(first.dp).toBe('mispronunciation')
  })

  it('⭐⭐ 合并**不是覆盖** —— 老词一个字都不许丢', () => {
    const old = weakPointsOf([ws('thorough', 30)])
    const merged = mergeWeakPoints(old, weakPointsOf([ws('invent', 60)]))
    expect(merged.map((w) => w.word).sort()).toEqual(['invent', 'thorough'])
  })

  it('⭐ 排序稳定：次数多的在前（界面要"最该练的"排前面）', () => {
    const merged = mergeWeakPoints(
      [{ word: 'a', count: 1, lowest: 50 }],
      [{ word: 'b', count: 3, lowest: 70 }],
    )
    expect(merged[0]!.word).toBe('b')
  })

  it('⚠️ 脏数据不当成崩溃（wordScores 不是数组 ⇒ 空）', () => {
    expect(weakPointsOf(null)).toEqual([])
    expect(weakPointsOf(undefined)).toEqual([])
  })
})

/** 静态：确认流程必须走"唯一写入方 + 同口径的前高"。
 *  ⚠️ **先剥注释** —— 否则"解释这条规则的注释"会自己触发守门（我在这里栽过两次了）。 */
const CONFIRM = readFileSync(new URL('./confirm.ts', import.meta.url), 'utf-8')
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  .join('\n')

describe('确认流程的静态守门', () => {
  it('⭐⭐ 前高必须与"战绩"同一口径（getBestExcluding，不是自己写条件）', () => {
    expect(CONFIRM.includes('getBestExcluding'), '前高没走统一口径 ⇒ 会拿没算数的分当参照').toBe(true)
    expect(/\bisNotNull\(\s*submissions\.confirmedAt\s*\)/.test(CONFIRM), '自己抄了一份确认条件').toBe(false)
  })

  it('⭐⭐ 写档案只能走 services/participations.ts 的入口（唯一写入方）', () => {
    expect(CONFIRM.includes('applyConfirmation'), '没走唯一写入方').toBe(true)
    expect(CONFIRM.includes('update(participations)'), '确认流程直接写了 participations 表').toBe(false)
  })

  it('⭐⭐ AI 总结是异步的：不能 await 它，失败不许影响确认', () => {
    /** ⚠️ 找**调用行**而不是那个名字 —— `indexOf` 会先命中 import 行（吃了这个亏） */
    const at = CONFIRM.indexOf('void refreshParticipationSummary(')
    expect(at, '总结没被 `void` 调用 ⇒ 要么没调、要么被 await 了（模型慢就会拖住确认）').toBeGreaterThan(-1)
  })

  it('⭐ 采纳用 `≥`（等于也采纳，用户定）', () => {
    expect(CONFIRM.includes('score >= previousBest'), '采纳判据不是 ≥').toBe(true)
  })
})
