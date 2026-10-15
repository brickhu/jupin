import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WXML = readFileSync(new URL('./participation.wxml', import.meta.url), 'utf-8')
const TS = readFileSync(new URL('./participation.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是**竞技档案页要显示 AI 锐评**（用户 2026-10-15：
 *    「pages/participation 这个页面请你把大模型生成出来的 ai-comment 展示出来」）。
 *
 * ⚠️ 它展示的是**被采纳那份成绩单上老师的批语**（`ParticipationRecord.bestComment`
 *    = `best_submission_id` 那份的 `ai_comment`）—— 用户的模型是
 *    「批语写在成绩单上，**超越前高**才整份写进战绩档案」。
 * ⚠️ 与同页的「AI 教练的总结」是**两件事**（一句话的点评 vs 这段练习的画像），别合并。
 */
describe('竞技档案页的 AI 锐评', () => {
  it('⭐⭐ 有锐评才渲染，没有整块不出（空框看起来像坏了）', () => {
    expect(WXML.includes('wx:if="{{view.remark}}"'), '渲染判据不对 ⇒ 没锐评时会留空框').toBe(true)
    expect(WXML.includes('{{view.remark}}'), '锐评没画出来').toBe(true)
  })

  it('⭐⭐ 数据取自 bestComment（被采纳那份），不是 aiSummary', () => {
    expect(TS.includes('r.bestComment'), '没取 bestComment').toBe(true)
    expect(TS.includes('remark:'), '视图里没有 remark 字段').toBe(true)
  })

  it('⚠️ 与 AI 总结分成两块（别把两件事并成一块）', () => {
    expect(WXML.includes('AI 锐评')).toBe(true)
    expect(WXML.includes('AI 教练的总结'), '把总结删了？那是另一件事').toBe(true)
  })

  /**
   * ⭐ **海报标签**（≤6 字）—— 与锐评同一次调用产出的另一半（用户 2026-10-15）。
   */
  it('⭐⭐ 标签也要显示（且没有标签时不留空位）', () => {
    expect(WXML.includes('{{view.tag}}'), '标签没画出来').toBe(true)
    expect(WXML.includes('wx:if="{{view.tag}}"'), '没有标签时会留一个空胶囊').toBe(true)
    expect(TS.includes('r.bestTag'), '没从参与记录取 bestTag').toBe(true)
  })
})
