import { describe, expect, it } from 'vitest'
import { FALLBACK_THEME, resolveTheme, themeFromHash } from './theme'

describe('resolveTheme —— 主题缺失时的兜底口径只有一处', () => {
  it('有 theme 就原样用（库里那一列优先，运营可以手改）', () => {
    const t = { image: null, background: '#123456', foreground: '#abcdef' }
    expect(resolveTheme(t)).toBe(t)
    // ⚠️ 即使给了 id 也不能盖掉显式的 theme
    expect(resolveTheme(t, 'e258e487277a99cd')).toBe(t)
  })

  it('theme 为空但有 id ⇒ 按 id 复算，与 themeFromHash 完全一致', () => {
    const id = 'e258e487277a99cd'
    const derived = themeFromHash(id)
    expect(resolveTheme(null, id)).toEqual(derived)
    expect(resolveTheme(undefined, id)).toEqual(derived)
    // ⚠️ 不再是品牌色 —— 这正是「后台一种颜色、端侧另一种」的老毛病
    expect(resolveTheme(null, id).background).not.toBe(FALLBACK_THEME.background)
  })

  it('连 id 都没有才退回品牌色（列表里的临时行）', () => {
    expect(resolveTheme(null)).toBe(FALLBACK_THEME)
    expect(resolveTheme(null, '')).toBe(FALLBACK_THEME)
    expect(resolveTheme(null, null)).toBe(FALLBACK_THEME)
  })

  it('同一 id 复算多次结果恒定（跨端、跨部署同一个颜色）', () => {
    expect(resolveTheme(null, 'abc')).toEqual(resolveTheme(null, 'abc'))
  })
})

describe('themeFromHash', () => {
  it('浅底 + 深字，且不依赖随机数', () => {
    const t = themeFromHash('e258e487277a99cd')
    expect(t.image).toBeNull()
    expect(t.background).toMatch(/^#[0-9a-f]{6}$/)
    expect(t.foreground).toMatch(/^#[0-9a-f]{6}$/)
    expect(t.background).not.toBe(t.foreground)
  })
})
