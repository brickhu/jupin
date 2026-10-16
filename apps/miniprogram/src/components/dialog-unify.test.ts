import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const DIR = new URL('./', import.meta.url)
const read = (p: string) => readFileSync(new URL(p, DIR), 'utf-8')

/**
 * ⭐⭐ 守的是**录音流程的四个浮层统一走 `ui-dialog`**（plan B92，用户 2026-10-16：
 *    「新封装了 ui-dialog 组件，你把录音的几个弹窗都统一用 ui-dialog 来封装」）。
 *
 * ⚠️⚠️ 为什么值得机器盯着：这四段（遮罩 + 居中 + 出入场动画 + 卡片外框）**各写了一份**，
 *    而它们的写法几乎一模一样 —— 修一处（比如动画时长、遮罩浓度、点遮罩是否关闭）
 *    忘三处，屏幕上就是"四个弹窗手感不一样"，而且**不报错**。
 *
 * ⚠️ 判据是"**外框不在自己家里**"：各自的 wxss 里不许再有 .xx-layer / .xx-mask / .xx-card，
 *    wxml 里必须出现 `<ui-dialog`。
 */
const PANELS = [
  { name: '能量面板', dir: 'energy-tips', prefix: 'et' },
  { name: '出分面板', dir: 'score-panel', prefix: 'sp' },
  { name: '录音面板', dir: 'recorder', prefix: 'rc' },
] as const

describe('录音流程的浮层统一走 ui-dialog', () => {
  for (const p of PANELS) {
    it(`⭐⭐ ${p.name}：外框交给 ui-dialog，自己不再写 layer/mask/card`, () => {
      const wxml = read(p.dir + '/' + p.dir + '.wxml')
      const wxss = read(p.dir + '/' + p.dir + '.wxss')
      expect(wxml.includes('<ui-dialog'), '没有用 ui-dialog 包外框').toBe(true)
      for (const cls of ['layer', 'mask', 'card']) {
        expect(wxss.includes('.' + p.prefix + '-' + cls), `又自己写了一份 .${p.prefix}-${cls}`).toBe(false)
      }
      /** ⚠️ 也不许自己写遮罩与出入场（那是 ui-dialog 的活） */
      expect(wxss.includes('rgba(0, 0, 0, 0.45)'), '自己又画了一遍遮罩').toBe(false)
      expect(wxss.includes('transition: opacity'), '自己又写了一遍出入场过渡').toBe(false)
    })
  }

  it('⭐⭐ 流程自己的「本地提示」浮层也走 ui-dialog', () => {
    const wxml = read('participate-flow/participate-flow.wxml')
    const wxss = read('participate-flow/participate-flow.wxss')
    expect(wxml.includes('<ui-dialog'), '提示浮层没走 ui-dialog').toBe(true)
    for (const cls of ['pf-layer', 'pf-mask', 'pf-card']) {
      expect(wxss.includes('.' + cls), '又自己写了一份 .' + cls).toBe(false)
    }
  })
})
