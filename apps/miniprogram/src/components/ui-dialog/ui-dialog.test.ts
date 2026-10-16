import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  ANIM_MS,
  POSITIONS,
  closesOnMaskTap,
  dialogClasses,
  headMode,
  normalizePosition,
} from './ui-dialog-variants'

const DIR = fileURLToPath(new URL('./', import.meta.url))
const read = (name: string) => readFileSync(DIR + name, 'utf-8')

/** 注释里的"反例"不算代码 —— 断言前先剥掉（同 wxss-lint 的做法） */
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ')
const stripHtml = (s: string) => s.replace(/<!--[\s\S]*?-->/g, ' ')
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const WXML = stripHtml(read('ui-dialog.wxml'))
const WXSS = stripCss(read('ui-dialog.wxss'))
const TS = stripTs(read('ui-dialog.ts'))
const JSON_SRC = JSON.parse(read('ui-dialog.json')) as Record<string, unknown>

/**
 * 取某条规则的声明体。
 * ⚠️ 选择器必须**精确匹配**（后面紧跟 `{`）—— 否则 `.ud-panel` 会命中 `.ud-panel.ud-on`
 *    那一条，于是"面板不许有 min-width"就查到了错的规则体（守门形同虚设）。
 */
const ruleOf = (selector: string) =>
  new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(WXSS)?.[1] ?? ''

/**
 * ⭐⭐ ui-dialog 的守门。
 *
 * ⚠️ 为什么值得单独写一组：这个组件里**绝大多数错都不报错**——只是画错或拦不住：
 *    · 少声明 `multipleSlots` ⇒ 后两个槽位的内容静默不见
 *    · 少了 `styleIsolation: apply-shared` ⇒ 面板透明无圆角（三个 token 类不生效）
 *    · 位置解析松掉 ⇒ 贴底的浮层被居中到屏幕中间
 *    · headMode 松掉 ⇒ 配了 title 却还画 head 槽（或反之）
 *    · `closable` 判反 ⇒ 等待期（能量已扣、云端在算）被一次误触关掉
 *    · ANIM_MS 与 WXSS 的 transition 不一致 ⇒ 收起动画"啪"地消失
 *    ⇒ 所以这里既测纯函数，也把 **WXML / WXSS / JSON / TS 四个文件互相钉住**。
 */

describe('ui-dialog 位置解析', () => {
  it.each([...POSITIONS])('合法位置 %s 原样通过', (p) => {
    expect(normalizePosition(p)).toBe(p)
  })

  it('没传 / 空串 / 拼错 / 大小写不合 ⇒ 落默认 center', () => {
    for (const bad of [undefined, null, '', '   ', 'Bottom', 'top', 'zzz', 0]) {
      expect(normalizePosition(bad), String(bad)).toBe('center')
    }
  })

  it('center 那一层自己当居中容器；bottom 不居中', () => {
    expect(dialogClasses('center').layer).toContain('ud-layer-center')
    expect(dialogClasses('center').panel).toContain('ud-panel-center')
    // ⚠️ 贴底那版若还留着居中，面板会被 flex 摆到屏幕中间 —— 看着就成了居中弹窗
    expect(dialogClasses('bottom').layer).not.toContain('ud-layer-center')
    expect(dialogClasses('bottom').panel).toContain('ud-panel-bottom')
  })

  it('⚠️ 拼出来的两个位置类名，WXSS 里必须真的有（错一个字母 = 静默失效）', () => {
    for (const p of POSITIONS) {
      for (const cls of dialogClasses(p).panel.split(' ')) {
        expect(WXSS, cls).toContain('.' + cls)
      }
      for (const cls of dialogClasses(p).layer.split(' ')) {
        expect(WXSS, cls).toContain('.' + cls)
      }
    }
  })
})

describe('ui-dialog 的 head 行 —— title 与 head 槽互斥', () => {
  it('title 非空才取 title；空格 / 回车等于没配', () => {
    expect(headMode('确认删除', false)).toBe('title')
    for (const empty of ['', '   ', '\n', undefined, null]) {
      expect(headMode(empty, false), JSON.stringify(empty)).toBe('slot')
    }
  })

  /**
   * ⭐ `bare` 一票否决：既不画 head、也不画 foot（B92 给录音流程那四个面板加的）。
   * ⚠️ 为什么要这个开关：空的 head/foot 仍然是一个 flex 子项 ⇒ 面板的 gap（32rpx）照加，
   *    屏幕上就是**白多出一段**（四个面板都是"只有一个 body"，全部命中）。
   */
  it('⭐ bare 一票否决（连 title 都不画）', () => {
    expect(headMode('确认删除', true)).toBe('none')
    expect(headMode('', true)).toBe('none')
  })

  /**
   * ⭐ head 那一行是**三支**：title / head 槽 / **不画**（`bare`）。
   * ⚠️ 第三支是 B92 加的：录音流程里那四个面板既没标题也不用 head 槽，
   *    而**空的 head 会白占一行、还多出一段 gap**（面板的 gap 是 32rpx，看得见）。
   */
  it('⭐ head 那一行：title 支不画槽、槽支画一次、第三支（bare）整个不画', () => {
    /** ① title 支里有 {{title}}、且**没有** head 槽 */
    const iTitle = WXML.indexOf("wx:if=\"{{headMode === 'title'}}\"")
    const iSlot = WXML.indexOf("wx:elif=\"{{headMode === 'slot'}}\"")
    const iMain = WXML.indexOf('class="ud-main"')
    expect(iTitle, 'title 支不见了').toBeGreaterThan(-1)
    expect(iSlot, 'head 槽支不见了（应该只由 headMode==="slot" 触发）').toBeGreaterThan(-1)
    expect(iTitle).toBeLessThan(iSlot)
    expect(WXML.slice(iTitle, iSlot)).toContain('{{title}}')
    expect(WXML.slice(iTitle, iSlot), 'title 支里也在画 head 槽 ⇒ 两条会同时出现').not.toMatch(/slot\s+name="head"/)
    expect(WXML.slice(iSlot, iMain), '槽支里没有 head 槽').toMatch(/slot\s+name="head"/)
    /**
     * ② `none`（bare）不是第三支渲染、而是**两支都不匹配 ⇒ 什么都不画** ——
     *    判据是 head 槽在整份模板里**只出现一次**（没有别处也在画它）。
     */
    expect((WXML.match(/slot\s+name="head"/g) ?? []).length, 'head 槽被画了不止一处').toBe(1)
  })

  it('⚠️ bare 时 foot 也不画（空的一行同样会白占一段 gap）', () => {
    expect(WXML.includes('wx:if="{{!bare}}"'), 'foot 那一行没跟着 bare 走').toBe(true)
  })

  it('三个槽位名齐（head / main / foot）', () => {
    for (const name of ['head', 'main', 'foot']) {
      expect(WXML, name).toMatch(new RegExp('slot\\s+name="' + name + '"'))
    }
  })
})

describe('ui-dialog 的 closable —— 只管"点遮罩能不能关"', () => {
  it('只有显式 true 才关；false / 没传 / 字符串一律不关', () => {
    expect(closesOnMaskTap(true)).toBe(true)
    for (const bad of [false, undefined, null, 'true', 1, 0]) {
      expect(closesOnMaskTap(bad), String(bad)).toBe(false)
    }
  })

  it('属性默认值是 true（不传 = 能关，这是默认行为）', () => {
    expect(TS).toMatch(/closable:\s*\{\s*type:\s*Boolean,\s*value:\s*true\s*\}/)
  })

  it('遮罩点击走 onMaskTap，且它先判 closable', () => {
    // ⚠️ 是 catchtap 不是 bindtap：模态那一层不该把点击再冒泡给页面（页面根节点常有自己的 tap）
    expect(WXML).toMatch(/catchtap="onMaskTap"/)
    expect(WXML).not.toMatch(/bindtap="onMaskTap"/)
    expect(TS).toMatch(/onMaskTap\(\)\s*\{[\s\S]*?closesOnMaskTap/)
  })

  it('⭐ hide 只从遮罩那一处抛（父组件自己关窗不回调，否则一次点击会触发两遍）', () => {
    const calls = TS.match(/triggerEvent\('hide'/g) ?? []
    expect(calls.length).toBe(1)
    expect(TS).toMatch(/onMaskTap\(\)\s*\{[\s\S]*?triggerEvent\('hide'/)
  })
})

describe('ui-dialog 平台必带的两个开关', () => {
  it('⭐⭐ multipleSlots —— 少了它，main / foot 的内容静默不见', () => {
    expect(TS).toMatch(/multipleSlots:\s*true/)
  })

  it('⭐⭐ styleIsolation: apply-shared —— 少了它，面板透明无圆角', () => {
    expect(JSON_SRC.component).toBe(true)
    expect(JSON_SRC.styleIsolation).toBe('apply-shared')
  })
})

describe('ui-dialog 的尺寸 / 间距 / 动画 —— 与需求逐条对齐', () => {
  it('基础样式三条写在 WXML 上：bg-page · text-page-on · rounded-lg', () => {
    for (const cls of ['bg-page', 'text-page-on', 'rounded-lg']) {
      expect(WXML, cls).toContain(cls)
    }
  })

  it('高度下限 240（稿 1px = 2rpx ⇒ 480rpx），且注释里留了出处', () => {
    expect(WXSS).toMatch(/min-height:\s*480rpx/)
    expect(read('ui-dialog.wxss')).toMatch(/240px/)
  })

  it('⭐ 槽位间距只有一个来源：--tk-space-md（需求里的 gap = space.md）', () => {
    expect(WXSS).toMatch(/gap:\s*var\(--tk-space-md/)
  })

  it('⭐⭐ center 宽度自适应外容器：两边各 12px（合计 24px）+ 上限 390px，且都用**字面 px**', () => {
    const rule = ruleOf('.ud-panel-center')
    expect(rule, '宽度要由外容器减去两边的 12px 得到').toMatch(/width:\s*calc\(100%\s*-\s*24px\)/)
    expect(rule).toMatch(/max-width:\s*390px/)
    expect(rule).toMatch(/transform:\s*scale\(0?\.\d+\)/)
    /**
     * ⚠️⚠️ 这两条必须是字面 px、不许折成 rpx（728rpx / 780rpx）：
     *    rpx 随屏宽整体放大，而「不超过 390px」是个**上限** ——
     *    折了之后手机上看不出问题，换一台更宽的机器就跟着变宽（"居中弹窗太宽"的根因）。
     */
    expect(rule, '宽度的上限与边距不许折 rpx（折了宽屏上兜不住）').not.toMatch(/rpx/)
  })

  it('⭐⭐ 面板不许有 min-width —— 自适应与"最小 364px"互斥', () => {
    /**
     * ⚠️ 375 宽的屏上 100%-24px 只有 351px；留着 min-width: 728rpx 会把它顶回 364px，
     *    两边 12px 的边距就被吃成 12rpx —— 正是"看着还是太宽"那个症状。
     *    bottom 那版同样不能有：320 宽的屏上它会被顶出屏幕。
     */
    expect(ruleOf('.ud-panel')).not.toMatch(/min-width/)
  })

  it('center 从中心向外放大', () => {
    expect(WXSS).toMatch(/ud-panel-center\.ud-on\s*\{[^}]*transform:\s*scale\(1\)/)
  })

  it('bottom = 100vw 贴底 + 从下往上滑出（顶角圆、底角方）', () => {
    const rule = /\.ud-panel\.ud-panel-bottom\s*\{([^}]*)\}/.exec(WXSS)?.[1] ?? ''
    for (const decl of ['left: 0', 'right: 0', 'bottom: 0', 'translateY(100%)']) {
      expect(rule, decl).toContain(decl)
    }
    // ⚠️ 只留上面两个圆角：贴底时下面两个圆角会把页面底色从角上漏出来
    expect(rule).toMatch(/border-radius:\s*var\(--tk-radius-lg[^;]*\)\s*var\(--tk-radius-lg[^;]*\)\s*0\s+0/)
    expect(WXSS).toMatch(/ud-panel-bottom\.ud-on\s*\{[^}]*transform:\s*translateY\(0\)/)
  })

  it('⭐ 动画时长与 ui-dialog-variants.ts 的 ANIM_MS 一致（收起是先播动画、再摘节点）', () => {
    const decls = [...WXSS.matchAll(/transition:\s*([^;]+);/g)].map((m) => m[1] as string)
    const durations = decls
      .flatMap((d) => [...d.matchAll(/([\d.]+)s/g)].map((m) => Number(m[1]) * 1000))
    expect(durations.length, 'WXSS 里一条 transition 都没有？').toBeGreaterThan(0)
    for (const ms of durations) expect(ms).toBe(ANIM_MS)
    expect(TS).toMatch(/ANIM_MS/)
  })

  it('⚠️ 遮罩那一层逐条写 top/right/bottom/left —— 不用 inset 简写（老 WebView 会丢整条声明）', () => {
    expect(WXSS).not.toMatch(/inset:/)
    const rule = /\.ud-mask\s*\{([^}]*)\}/.exec(WXSS)?.[1] ?? ''
    for (const decl of ['top: 0', 'right: 0', 'bottom: 0', 'left: 0']) {
      expect(rule, decl).toContain(decl)
    }
  })
})
