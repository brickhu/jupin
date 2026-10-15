import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** 剥掉注释再判 —— 否则守门会被"解释这条规则的注释"自己触发 */
const SRC = readFileSync(new URL('./btn-record.wxml', import.meta.url), 'utf-8')
  .replace(/<!--[\s\S]*?-->/g, '')

/**
 * ⭐⭐ 守的是**五态各自有什么**（Figma 539:871 + prd §7.2）。
 *
 * ⚠️ 最容易错的一条：**`↺`（抹除录音）只在 `recoded` 态**。
 *    它抹除的对象是"**这一段还没提交的录音**" —— 所以只有 `recoded` 说得通；
 *    `checking`（已交上去在算）/ `scored`（已经出分）里要抹的已经是"提交过的东西"，
 *    与 ↺ 不是一件事。
 *    ⚠️ 设计稿在那两态里也画了 ↺（`checking` 是 0.2 不透明度）—— 那是稿子多画的，**不照抄**。
 *
 * ⚠️ 这是**静态**检查（读 WXML 文本）：它守的是"写法"，跑不出视觉回归。
 */
describe('btn-record 五态的构成', () => {
  it('⭐ ↺（抹除录音）只在 recoded 态出现', () => {
    const at = SRC.indexOf('material-symbols:undo')
    expect(at, '找不到 ↺').toBeGreaterThan(-1)
    /** 往回找最近的 wx:if —— 它必须是 recoded */
    const before = SRC.slice(0, at)
    const lastIf = before.lastIndexOf('wx:if="{{state === ')
    expect(lastIf, '↺ 外面没有 wx:if ⇒ 每一态都会画它').toBeGreaterThan(-1)
    const cond = before.slice(lastIf, lastIf + 60)
    expect(cond, '↺ 的判据不是 recoded ⇒ checking/scored 里也会出现"抹除录音"').toContain(
      "state === 'recoded'",
    )
  })

  it('⭐ ✓（提交检测）也只在 recoded 态', () => {
    const at = SRC.indexOf('material-symbols:check')
    expect(at).toBeGreaterThan(-1)
    const before = SRC.slice(0, at)
    const lastIf = before.lastIndexOf('wx:if="{{state === ')
    expect(before.slice(lastIf, lastIf + 60)).toContain("state === 'recoded'")
  })

  it('checking 态 = 试听 + 转圈（没有 ↺、没有分数）', () => {
    expect(SRC).toContain('material-symbols:progress-activity-sharp')
    // 转圈那一支挂在 checking 上
    const at = SRC.indexOf('ms-loading')
    const before = SRC.slice(0, at)
    expect(before.slice(before.lastIndexOf("wx:elif=\"{{state === 'checking'"))).toContain('wx:elif')
  })

  it('scored 态 = 试听 + 分数 ›（箭头是 arrow-forward-ios）', () => {
    expect(SRC).toContain('material-symbols:arrow-forward-ios')
  })
})
