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
 *    ⇒ 间距必须由 **margin/padding 类**给（全仓库逐词都这么排，见 score-panel）。
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

  /**
   * ⭐⭐ 参与区胶囊：**三组贴两边（space-between）且左右各内缩 8**。
   *
   * ⚠️ 这两个数来自稿子的**两处**（外层 `button` 的 pad 左右 0 + 内层 `Frame 13/15` 的 pad 左右 8），
   *    只看外层就会写成 pad 0 ⇒ 两颗圆**顶到胶囊圆角上被切掉**（真机上就是这个样子）。
   */
  it('⭐ 参与区胶囊：space-between + 左右各内缩 8', () => {
    const pill = readFileSync(new URL('../btn-record/btn-record.wxss', import.meta.url), 'utf-8')
    /** ⚠️ 要取**最后一条** `.br-line` —— 第一条是 `.br-fill, .br-line` 的共享规则（那里是 center） */
    const all = [...pill.matchAll(/\.br-line\s*\{([^}]*)\}/g)]
    const rule = (all[all.length - 1]?.[1] as string) ?? ''
    expect(rule, '找不到 .br-line').not.toBe('')
    expect(rule.includes('justify-content: space-between'), '三组没有贴两边').toBe(true)
    expect(rule.includes('padding: 0 16rpx'), '左右没内缩 ⇒ 圆会被胶囊圆角切掉').toBe(true)
  })

  /**
   * ⭐⭐ 守的是**"边框浓度表达读过没有"**（用户 2026-10-15 定）：
   *   默认 **10%**、**参与过 ⇒ 100%**。
   *
   * ⚠️ 三个必须同时在的点（少一个就是"看起来改了、其实没生效"）：
   *   ① wxss 有默认 10% 的 `color-mix`（且**前面有一条降级声明** —— 不认 color-mix 的引擎靠它）；
   *   ② 有 `.ac-card.ac-joined { border-color: currentColor }`（100%）；
   *   ③ wxml 真的按 `entry.joined` 加上那个类 —— 否则 ② 永远不会命中。
   */
  it('⭐⭐ 边框：默认 10%、参与过 100%（三处缺一不可）', () => {
    const card = WXSS.slice(WXSS.indexOf('.ac-card'), WXSS.indexOf('.ac-lg'))
    expect(card.includes('color-mix(in srgb, currentColor 10%, transparent)'), '默认不是 10%').toBe(true)
    /**
     * ⚠️⚠️ 降级声明必须是**紧邻的上一条、同一个属性名**（`border-color`）——
     *    写成 `border` 简写不算：不认 color-mix 的引擎丢掉的是**那一条声明**，
     *    没有同属性降级时那句样式会**静默消失**（一圈边框全没）。
     *    `wxss-color-mix.test.ts` 也会拦（我第一版就是被它拦下的）。
     */
    expect(
      /border-color: rgba\(128, 128, 128, 0\.1\);\s*\n\s*border-color: color-mix/.test(WXSS),
      '降级声明不是"紧邻 + 同属性" ⇒ 老引擎上边框会整个消失',
    ).toBe(true)
    expect(/\n\.ac-card\.ac-joined \{\s*border-color: currentColor;/.test(WXSS), '参与过的满色边框没了').toBe(true)
    expect(WXML.includes("entry.joined ? 'ac-joined' : ''"), 'wxml 没按 joined 加类 ⇒ 满色边框永远不出现').toBe(true)
  })

  it('⚠️ `joined` 必须在 Entry 里声明（wxml 一直在用它，TS 原来不知道）', () => {
    expect(TS.includes('joined?: boolean'), 'Entry 没声明 joined ⇒ 宿主忘了传也不报错').toBe(true)
  })
})
