import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { collectHandlers, missingHandlers } from '../wxml-handlers.mjs'

const SRC = fileURLToPath(new URL('.', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

/**
 * ⚠️⚠️ 这些用例存在的理由：绑一个不存在的方法**既不报错也不跳转** ——
 *    用户点了完全没反应。真实事故：user-sheet.wxml 写了 catchtap="onOpenEnergy"，
 *    而 .ts 里没有它（那次编辑只落到了 WXML 上），用户的原话是「能量文字点不动」。
 *
 * ⚠️ tsc 只看 .ts、类名检查只看 class 属性，所以这类错只有构建期和这里能拦住。
 */
describe('WXML 事件绑定 ↔ .ts 方法', () => {
  it('⭐ 全项目：每个绑定的方法在同名 .ts 里都有实现', () => {
    const bad: string[] = []
    for (const file of walk(SRC)) {
      if (!file.endsWith('.wxml')) continue
      const ts = file.replace(/\.wxml$/, '.ts')
      if (!existsSync(ts)) continue
      for (const name of missingHandlers(readFileSync(file, 'utf8'), readFileSync(ts, 'utf8'))) {
        bad.push(relative(SRC, file) + '  →  ' + name)
      }
    }
    expect(bad).toEqual([])
  })

  it('bind / catch / capture-bind / mut-bind 各种写法都收得到', () => {
    const wxml = [
      '<view bindtap="onA" catchtap="onB">',
      '  <text capture-bind:tap="onC" mut-bind:tap="onD">x</text>',
      '  <view catchtap="">阻止冒泡用的空绑定</view>',
      '  <view bindtap="{{dynamic}}">动态绑定查不了，跳过</view>',
    ].join('\n')
    expect(collectHandlers(wxml).sort()).toEqual(['onA', 'onB', 'onC', 'onD'])
  })

  it('缺方法要报', () => {
    const wxml = '<view catchtap="onMissing"></view>'
    const ts = 'Component({ methods: { onOther() {} } })'
    expect(missingHandlers(wxml, ts)).toEqual(['onMissing'])
  })

  it('⚠️ 注释里提到名字不算有实现（真踩过的陷阱）', () => {
    const wxml = '<view catchtap="onOpenEnergy"></view>'
    const ts = '// 这里写着 onOpenEnergy 但下面并没有实现\nconst x = 1'
    expect(missingHandlers(wxml, ts)).toEqual(['onOpenEnergy'])
  })

  it('async 方法要认得（漏了会误报一片）', () => {
    expect(missingHandlers('<view bindtap="onBuy"></view>', 'Page({ async onBuy() {} })')).toEqual([])
  })

  it('普通写法 / 冒号写法都认得', () => {
    expect(missingHandlers('<view bindtap="a"></view>', 'Page({ a() {} })')).toEqual([])
    expect(missingHandlers('<view bindtap="b"></view>', 'Page({ b: function () {} })')).toEqual([])
  })
})
