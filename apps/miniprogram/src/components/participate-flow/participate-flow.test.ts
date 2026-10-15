import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const RAW = readFileSync(new URL('./participate-flow.ts', import.meta.url), 'utf-8')

/**
 * ⚠️ **剥掉注释再判** —— 否则守门会被"解释这条规则的注释"自己触发
 *    （本文件的注释里就写着「原来这里写死 status: 'scored'」，第一版就是这么误报的）。
 */
const SRC = RAW.split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  .join('\n')

/**
 * ⭐⭐ 守的是**「没出分之前不许显示分数」**这条纪律（2026-10-15 真实 bug）。
 *
 * ## 出事的样子（用户原话）
 *
 *   「你能量扣除确认后，直接把历史最高分展示出来了 —— 应该是 loading 状态啊」
 *
 * 两层错叠在一起：
 *   ① `restore()` 把缓存里的 submissionId **写死成 `status: 'scored'`** ⇒
 *      点完能量确认、id 刚落库的那一刻，状态机就判成 `scored`；
 *   ② `displayScoreOf('scored', …)` 在"这一把的分还没到"时**退回战绩** ⇒
 *      于是显示出来的正是**历史最高分**。
 *
 * ⇒ 只要有一层错，"一个不属于这一次的分数"就会被显示得像真的一样。**两处都堵死**。
 *
 * ⚠️ 这是**静态**检查（读源码文本），与 wxss-guard / participation-scope 同一种风格：
 *    它守的是"写法"，而不是跑一遍时序（时序那部分由 lib/record-state.test.ts 守）。
 */
describe('参与流程 —— 没出分之前不许显示分数', () => {
  it('⭐ restore 不许把缓存的 submissionId 写死成 scored', () => {
    // 判据只看"本会话真的拿到结果了吗"（scratch.resultOf）
    expect(
      SRC.includes("status: knownResult === cache.submissionId ? 'scored' : 'scoring'"),
      'restore 没有按 resultOf 判 status ⇒ 提交后一刻会被判成 scored 并显示分数',
    ).toBe(true)

    // 反向：不许再出现写死的 status: 'scored'
    const hardCoded = /status:\s*'scored'/.test(SRC)
    expect(hardCoded, "restore 里又出现了写死的 status: 'scored' ⇒ 回归").toBe(false)
  })

  it('⭐ 提交成功之后必须把 resultOf 清空（这一把的结果是"未知"）', () => {
    const at = SRC.indexOf('const next: ParticipateCache')
    expect(at, '找不到保存缓存那一句').toBeGreaterThan(-1)
    const after = SRC.slice(at, at + 700)
    expect(
      after.includes("this.data.scratch.resultOf = ''"),
      "提交后没有清空 resultOf ⇒ restore 会以为已出分",
    ).toBe(true)
  })

  it('⚠️ 只有"用户刚提交"那一次才自动弹面板（进页面补问不弹）', () => {
    expect(
      SRC.includes('startPoll(true)'),
      '进页面补问没有走 silent ⇒ 每次进页面都会自动弹一次结果面板',
    ).toBe(true)
    expect(
      SRC.includes('!this.data.scratch.silent'),
      '轮询没有按 silent 决定弹不弹',
    ).toBe(true)
  })

  it('点了面板上的「确认」之后，四个标记都要清掉', () => {
    const at = SRC.indexOf('async onPanelConfirm()')
    expect(at).toBeGreaterThan(-1)
    const body = SRC.slice(at, at + 1400)
    for (const k of ['clearParticipate', "resultOf = ''", "popped = ''"]) {
      expect(body.includes(k), '确认之后没清：' + k).toBe(true)
    }
  })
})
