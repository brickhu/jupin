import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WXML = readFileSync(new URL('./arena-card.wxml', import.meta.url), 'utf-8')
const WXSS = readFileSync(new URL('./arena-card.wxss', import.meta.url), 'utf-8')
const TS = readFileSync(new URL('./arena-card.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是**句子卡的排版**（结构与数值来自 Figma `539:860` 的 `sentence_card`）。
 *
 * ⚠️ 最要命的一条是**词与词之间的空格**：
 *    逐词渲染（为了点词发音）时，如果靠"让每个词自带一个尾随空格"（`w + ' '`）来排，
 *    **小程序渲染 `<text>` 会把结尾的空格吃掉** ⇒ 真机上是一串 `Everythingshouldbemadeas`，
 *    而模拟器/类型/测试**全都看不出来**（只能靠肉眼看设计图对比）。
 *    ⇒ 间距必须由 **margin/padding 类**给（与 `pages/challenge` 的逐词排法一致）。
 */
describe('句子卡的排版（Figma 539:860）', () => {
  /** 逐词那一行的属性（⚠️ 不能拿 indexOf('{{item}}') 定位 —— 它先命中 data-w="{{item}}"） */
  const wordTag = /<text([^>]*)>\{\{item\}\}<\/text>/.exec(WXML)?.[1] ?? ''

  it('⭐⭐ 逐词靠 margin 排，不靠"词自带空格"', () => {
    expect(wordTag, '找不到逐词的 text 行').not.toBe('')
    expect(
      /\b(mr-|px-|pr-)/.test(wordTag),
      '逐词那一行没有 margin/padding 类 ⇒ 词会连成一串（尾随空格会被渲染器吃掉）',
    ).toBe(true)
    // 反向：不许再往词尾拼空格
    expect(
      /w\s*\+\s*' '\s*\)|item\s*\+\s*' '/.test(TS),
      '又出现了"词尾拼空格"的排法 ⇒ 真机上词会连成一串',
    ).toBe(false)
  })

  it('⭐ 卡内四块用 gap 拉开（稿 VERTICAL gap=16 ⇒ 32rpx）', () => {
    const card = WXSS.slice(WXSS.indexOf('.ac-card'), WXSS.indexOf('.ac-lg'))
    expect(card.includes('display: flex')).toBe(true)
    expect(card.includes('gap: 32rpx'), '卡内没有 gap ⇒ 四块的间距靠各写各的 margin，必漂').toBe(true)
  })

  it('⭐ 句子 20px/400（稿），不是加粗的 22px', () => {
    expect(wordTag.includes('text-40rpx'), '句子字号不是 40rpx（稿 20px）').toBe(true)
    expect(wordTag.includes('font-semibold'), '句子被加粗了 —— 稿里是 400（常规）').toBe(false)
  })

  it('⭐ 译文 12px（24rpx）', () => {
    expect(WXML).toContain('text-24rpx leading-[1.5] block ac-faint')
  })
})
