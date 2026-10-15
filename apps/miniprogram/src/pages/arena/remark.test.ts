import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WXML = readFileSync(new URL('./arena.wxml', import.meta.url), 'utf-8')
const TS = readFileSync(new URL('./arena.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是**AI 锐评要在竞技场页看得见**（prd §7.2b，用户 2026-10-15）。
 *
 * ⚠️⚠️ 这段文本在此之前**存了但谁也看不到**（显示它的 `pages/reading` 已删），
 *    所以"生成"和"展示"两件事必须一起守 —— 只做前者等于什么都没有。
 */
describe('竞技场页的 AI 锐评', () => {
  it('⭐⭐ 有锐评才渲染，没有整块不出（空框看起来像坏了）', () => {
    expect(WXML.includes('wx:if="{{remark}}"'), '渲染判据不对 ⇒ 没有锐评时会留一个空框').toBe(true)
    expect(WXML.includes('{{remark}}'), '锐评没画出来').toBe(true)
  })

  it('⭐⭐ 数据来自"这一句上我最好那一把"（= 参与记录的 bestComment）', () => {
    expect(TS.includes('record?.bestComment'), '没从参与记录取 bestComment').toBe(true)
    expect(TS.includes('remark:'), 'data 里没有 remark').toBe(true)
  })
})
