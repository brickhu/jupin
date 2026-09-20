import { describe, it, expect } from 'vitest'
import { createGenerator } from 'unocss'
import unoConfig, {
  assertWxssSafe,
  downgradeColorSyntax,
  escapeWxml,
  makeEscapeMap,
} from './uno.config.mjs'

describe('assertWxssSafe', () => {
  it('干净产物直接通过', () => {
    expect(() => assertWxssSafe('.p-4{padding:32rpx;color:rgba(1, 2, 3, 0.5)}')).not.toThrow()
  })
  it('拦住未降级的颜色语法', () => {
    expect(() => assertWxssSafe('.x{color:rgb(79 70 229 / 0.1)}')).toThrow(/Color 4/)
  })
  it('拦住反斜杠转义选择器', () => {
    expect(() => assertWxssSafe('.hover\\:bg-red:hover{}')).toThrow(/转义/)
  })
  it('拦住 :not(#\\#) 特异性 hack（StyleX 那类产物）', () => {
    expect(() => assertWxssSafe('.x:not(#\\#){color:red}')).toThrow(/特异性/)
  })
})

describe('downgradeColorSyntax', () => {
  it('把空格分隔 + 斜杠 alpha 降级成 rgba', () => {
    expect(downgradeColorSyntax('a{color:rgb(79 70 229 / 0.1)}'))
      .toBe('a{color:rgba(79, 70, 229, 0.1)}')
  })

  it('alpha 是 var() 时括号不能丢', () => {
    expect(downgradeColorSyntax('a{color:rgb(255 255 255 / var(--un-bg-opacity))}'))
      .toBe('a{color:rgba(255, 255, 255, var(--un-bg-opacity))}')
  })

  it('无 alpha 的三元组也补上逗号', () => {
    expect(downgradeColorSyntax('rgb(1 2 3)')).toBe('rgb(1, 2, 3)')
  })

  it('对传统 rgba(1, 2, 3, 0.5) 是 no-op（可反复调用）', () => {
    const legacy = '.x{color:rgba(1, 2, 3, 0.5);border-color:rgba(147, 197, 253, 0.5)}'
    expect(downgradeColorSyntax(legacy)).toBe(legacy)
    expect(downgradeColorSyntax(downgradeColorSyntax(legacy))).toBe(legacy)
  })

  it('不动无关的 rgb 字样', () => {
    expect(downgradeColorSyntax('.bg-rgb-text{}')).toBe('.bg-rgb-text{}')
  })
})

describe('生成的 WXSS 满足小程序约束', () => {
  const gen = async (source) => {
    const uno = await createGenerator(unoConfig)
    const { css, matched } = await uno.generate(source, { preflights: true })
    return { raw: css, css: downgradeColorSyntax(css), matched }
  }

  it('产物里没有 CSS Color 4 颜色语法（老 WebView 会整条丢弃）', async () => {
    const { raw, css } = await gen('<view class="bg-brand_10 text-white_80 border-black_20">')
    expect(/rgb\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\//.test(raw)).toBe(true) // 前提：UnoCSS 确实这么输出
    expect(/rgb\(\s*[\d.]+\s+[\d.]+\s+[\d.]+\s*\//.test(css)).toBe(false)
    expect(/color-mix|oklch/.test(css)).toBe(false)
  })

  it('变体用 __ 分隔，产出的是 WXSS 支持的普通伪类选择器', async () => {
    const { css } = await gen('<view class="active__opacity-50 hover__bg-gray-100">')
    expect(css).toContain('.active__opacity-50:active')
    expect(css).toContain('.hover__bg-gray-100:hover')
  })

  it('任意值里的 [] 被转义掉，不留反斜杠（WXSS 不支持转义选择器）', async () => {
    const { css } = await gen('<view class="w-[420rpx] mt-[-8rpx]">')
    expect(css).toContain('width:420rpx')
    expect(css).toContain('margin-top:-8rpx')
    expect(css).not.toMatch(/\\[[\]]/) // 没有 \[ 或 \]
  })

  it('间距刻度是 rpx 且 1 单位 = 8rpx（与现有手写 WXSS 同刻度）', async () => {
    const { css } = await gen('<view class="p-4 gap-2 mt-3 rounded-3">')
    expect(css).toContain('padding:32rpx')
    expect(css).toContain('gap:16rpx')
    expect(css).toContain('margin-top:24rpx')
    expect(css).toContain('border-radius:24rpx')
  })

  it('没用到的类不产出（按需生成）', async () => {
    const { matched } = await gen('<view class="flex">')
    expect(matched.has('flex')).toBe(true)
    expect(matched.has('grid')).toBe(false)
    expect([...matched].every((t) => !t.startsWith('p-'))).toBe(true)
  })
})

describe('类名转义链路 —— WXML 与 WXSS 必须对得上', () => {
  /**
   * ⭐ 这是本集成最容易静默失效的地方：
   *   预设把 CSS 选择器改写成 .pb-_lfl_60rpx_lfr_，但源码那一半要靠
   *   unplugin-transform-class 插件改写 —— 我们是自己调 Node API，没有那个插件。
   *   少了这半边，WXML 里写 class="pb-[60rpx]" 就永远匹配不上，且**不报任何错**。
   */

  it('任意值/小数/方括号被改写，且改写后的名字真的能在 CSS 里找到', async () => {
    const wxml = '<view class="pb-[60rpx] p-2.5 leading-[1.6] mt-[-8rpx] flex"></view>'
    const uno = await createGenerator(unoConfig)
    const { css, matched } = await uno.generate(wxml, { preflights: false })
    const { code, hits } = escapeWxml(wxml, makeEscapeMap(matched))

    expect(hits).toBe(4) // 只有前四个需要转义，flex 不需要
    expect(code).toContain('pb-_lfl_60rpx_lfr_')
    expect(code).toContain('p-2_dl_5')
    expect(code).toContain('leading-_lfl_1_dl_6_lfr_')

    // ⭐ 核心不变量：WXML 里出现的每个类名，CSS 里都有对应选择器
    for (const cls of [...code.matchAll(/class="([^"]*)"/g)].flatMap((m) => m[1].split(/\s+/))) {
      expect(css).toContain('.' + cls)
    }
  })

  it('插值表达式本身的 . : ( ) 一个都不能碰（碰了模板就废）', () => {
    const wxml = `<view class="flex {{health.pending ? '' : (health.ok ? 'a' : 'b')}}"></view>`
    const { code, hits } = escapeWxml(wxml, new Map([['flex', 'FLEX']]))
    expect(hits).toBe(1)
    // health.pending 里的点、三元里的 ? : ( ) 全部原样
    expect(code).toBe(`<view class="FLEX {{health.pending ? '' : (health.ok ? 'a' : 'b')}}"></view>`)
  })

  it('但插值里引号中的条件类名要一起改写（否则同样匹配不上）', () => {
    const wxml = `<view class="{{running ? 'bg-[#bbb]' : 'bg-[#111]'}}"></view>`
    const uno = unoConfig
    const { code, hits } = escapeWxml(
      wxml,
      new Map([
        ['bg-[#bbb]', 'bg-_lfl__wn_bbb_lfr_'],
        ['bg-[#111]', 'bg-_lfl__wn_111_lfr_'],
      ]),
    )
    expect(hits).toBe(2)
    expect(code).toBe(`<view class="{{running ? 'bg-_lfl__wn_bbb_lfr_' : 'bg-_lfl__wn_111_lfr_'}}"></view>`)
    expect(uno).toBeTruthy()
  })

  it('条件类名改写后仍能在 CSS 里找到', async () => {
    const wxml = `<view class="{{ok ? 'bg-[#111]' : 'bg-[#bbb]'}}"></view>`
    const uno = await createGenerator(unoConfig)
    const { css, matched } = await uno.generate(wxml, { preflights: false })
    const { code } = escapeWxml(wxml, makeEscapeMap(matched))
    for (const lit of code.matchAll(/'([^']*)'/g)) {
      if (lit[1]) expect(css).toContain('.' + lit[1])
    }
  })

  it('只在整 token 精确命中时替换，不做子串替换', () => {
    const { code } = escapeWxml('<view class="flex flex-col"></view>', new Map([['flex', 'X']]))
    expect(code).toBe('<view class="X flex-col"></view>')
  })

  it('比较运算的右操作数不算类名（否则守卫会误报）', async () => {
    const wxml = `<view class="flex {{phase === 'submitting' ? 'opacity-50' : ''}}"></view>`
    const uno = await createGenerator(unoConfig)
    const { matched } = await uno.generate(wxml, { preflights: false })
    // 'submitting' 是判断条件，不该出现在「WXML 使用的类名」里
    expect(matched.has('submitting')).toBe(false)
    expect(matched.has('opacity-50')).toBe(true)
    expect(matched.has('flex')).toBe(true)
  })

  it('语义类名不在映射里 → 原样保留', () => {
    const { code, hits } = escapeWxml('<view class="card hero"></view>', makeEscapeMap(['flex']))
    expect(code).toBe('<view class="card hero"></view>')
    expect(hits).toBe(0)
  })

  it('不需要转义的类名不进映射（避免无谓改写）', () => {
    const map = makeEscapeMap(['flex', 'p-4', 'text-30rpx', 'bg-brand_10', 'active__opacity-50'])
    expect(map.size).toBe(0)
  })
})

describe('Skyline 子集约束（见 docs/research/skyline-evaluation.md）', () => {
  it('拦住 Skyline 不支持的三种选择器', () => {
    expect(() => assertWxssSafe('*{box-sizing:border-box}')).toThrow(/通配/)
    expect(() => assertWxssSafe('.btn[disabled]{opacity:.5}')).toThrow(/属性选择器/)
    expect(() => assertWxssSafe('.x:hover{color:red}')).toThrow(/:hover/)
  })

  it('不误伤 calc() 里的乘号', () => {
    expect(() => assertWxssSafe('.w{width:calc(100% - 2 * 3px)}')).not.toThrow()
  })
})
