import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const WXML = readFileSync(new URL('./score-panel.wxml', import.meta.url), 'utf-8')
const WXSS = readFileSync(new URL('./score-panel.wxss', import.meta.url), 'utf-8')
const TS = readFileSync(new URL('./score-panel.ts', import.meta.url), 'utf-8')

/**
 * ⭐⭐ 守的是**出分面板的结构**（稿 `588:1791` score-update / `588:1814` score-nonupdate）。
 *
 * ⚠️⚠️ 最容易做错的一条：**五个分项在稿里是「五个色块」（上标签 12px / 下分数 14px）**，
 *    **不是进度条**。进度条是"另一个界面的语言"——而且它逼着用户去比长度，
 *    色块是"一眼扫过五个数"。
 *
 * ⚠️ 这是**静态**检查（读源码文本）。
 */
describe('出分面板的结构（Figma 588:1791 / 588:1814）', () => {
  it('⭐⭐ 五个分项是**色块**，不是进度条', () => {
    expect(WXML.includes('sp-part'), '找不到分项色块').toBe(true)
    // 反向：不许再出现"按百分比撑宽的进度条"
    expect(/width:\{\{item\.pct\}\}%/.test(WXML), '又出现了进度条 ⇒ 稿里是色块').toBe(false)
    expect(WXML.includes('barCls'), '还在用进度条的颜色类').toBe(false)
  })

  it('⭐ 两态共用同一套分项（更新/保留都画五个块）', () => {
    // 分项块只允许出现一次（不在 wx:if 的分支里各写一份）
    const n = (WXML.match(/class="sp-part"/g) ?? []).length
    expect(n, '分项块被写了两份 ⇒ 两态会漂').toBe(1)
  })

  it('⭐ 分数 20px/400 + success 色（稿 #20b99a = 我们的 success）', () => {
    const rule = /\.sp-score\s*\{([^}]*)\}/.exec(WXSS)?.[1] ?? ''
    expect(rule.includes('font-size: 40rpx'), '分数不是稿里的 20px').toBe(true)
    expect(rule.includes('var(--tk-success'), '分数不是 success 色').toBe(true)
    // ⚠️ 两态**都是绿的** —— 稿里"保留"那态不是橙色
    expect(WXSS.includes('text-warn') || TS.includes('text-warn'), '又给"保留"上了橙色（稿里两态都是绿的）').toBe(false)
  })

  it('⭐ 战绩胶囊就是「确认」这一步（稿里没有单独的确认按钮）', () => {
    const at = WXML.indexOf('sp-record')
    const tag = WXML.slice(WXML.lastIndexOf('<view', at), WXML.indexOf('>', at))
    expect(tag.includes('bindtap="onConfirm"'), '战绩胶囊没接确认 ⇒ 出分面板没有结算出口').toBe(true)
  })

  it('⭐ 句子逐词上色，且间距靠 margin（不是"词自带空格"）', () => {
    const m = /<text([^>]*)>\{\{item\.text\}\}<\/text>/.exec(WXML)?.[1] ?? ''
    expect(m, '找不到逐词那一行').not.toBe('')
    expect(/\b(mr-|px-|pr-)/.test(m), '逐词没有 margin ⇒ 真机上会连成一串').toBe(true)
  })

  it('⭐ 胶囊文案按稿逐字（更新用「 : A → B」· 保留用「，A → B」）', () => {
    expect(TS.includes("'更新战绩 : '"), '更新的文案不是稿里的形状').toBe(true)
    expect(TS.includes("'保留战绩，'"), '保留的文案不是稿里的形状').toBe(true)
  })
})
