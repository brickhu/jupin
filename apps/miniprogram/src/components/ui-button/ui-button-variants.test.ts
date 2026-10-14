import { describe, expect, it } from 'vitest'

import {
  COLORS,
  LEGACY_COLOR,
  LEGACY_ROUNDNESS,
  LEGACY_VARIANT,
  ROUNDNESSES,
  SIZES,
  VARIANTS,
  buttonClasses,
  iconGapClass,
  pickValue,
} from './ui-button-variants'

const base = {
  variant: 'fill',
  color: 'primary',
  size: 'md',
  roundness: 'md',
  iconPosition: 'start',
  onlyIcon: false,
  disabled: false,
  loading: false,
  width: '',
}

/**
 * ⚠️⚠️ 这组用例是为一个**真机才发现的** bug 写的（2026-10）：
 *
 * 原来的解析是 `LEGACY_VARIANT[raw] ?? 'fill'` —— 把**所有**取值都拿去查旧表。
 * 于是"新值里不在旧表的那些"全落到默认：
 *   · `variant="glass"` → `fill`（玻璃态画成实心）
 *   · `color="primary"` → `surface`（底色 #F6F6F6 压在同色卡片上，看不见）
 * 症状是"某几个颜色怎么都不生效、其余正常"，构建 / tsc / lint 全不报。
 *
 * ⇒ 所以这里**逐个遍历合法新值**断言"原样返回"。将来加新颜色/新形态时，
 *   只要忘了更新 LEGACY 表，这组用例也不会误伤（因为新值本来就该原样通过）。
 */
describe('ui-button 取值解析 —— 合法新值必须原样通过', () => {
  it.each([...VARIANTS])('variant=%s 原样返回（不许被旧表吞掉）', (v) => {
    expect(pickValue(v, VARIANTS, LEGACY_VARIANT, 'fill')).toBe(v)
  })

  it.each([...COLORS])('color=%s 原样返回（不许被旧表吞掉）', (c) => {
    expect(pickValue(c, COLORS, LEGACY_COLOR, 'primary')).toBe(c)
  })

  it.each([...ROUNDNESSES])('roundness=%s 原样返回', (r) => {
    expect(pickValue(r, ROUNDNESSES, LEGACY_ROUNDNESS, 'md')).toBe(r)
  })

  it.each([...SIZES])('size=%s 原样返回', (s) => {
    expect(pickValue(s, SIZES, {}, 'md')).toBe(s)
  })

  it('旧值仍然翻译（兼容层没被删掉）', () => {
    expect(pickValue('link', VARIANTS, LEGACY_VARIANT, 'fill')).toBe('ghost')
    expect(pickValue('brand', COLORS, LEGACY_COLOR, 'primary')).toBe('primary')
    expect(pickValue('default', COLORS, LEGACY_COLOR, 'primary')).toBe('primary')
    expect(pickValue('ok', COLORS, LEGACY_COLOR, 'primary')).toBe('success')
    expect(pickValue('xs', ROUNDNESSES, LEGACY_ROUNDNESS, 'md')).toBe('sm')
    expect(pickValue('none', ROUNDNESSES, LEGACY_ROUNDNESS, 'md')).toBe('sm')
    expect(pickValue('ghost', ROUNDNESSES, LEGACY_ROUNDNESS, 'md')).toBe('sm')
  })

  it('不认识的值才落默认', () => {
    expect(pickValue('zzz', VARIANTS, LEGACY_VARIANT, 'fill')).toBe('fill')
    expect(pickValue('', COLORS, LEGACY_COLOR, 'primary')).toBe('primary')
    expect(pickValue(undefined, SIZES, {}, 'md')).toBe('md')
    expect(pickValue(null, ROUNDNESSES, LEGACY_ROUNDNESS, 'md')).toBe('md')
  })
})

describe('ui-button 类名拼装', () => {
  it('颜色挂齐两个类（c = 基色 / fg = 反色）—— 对外只有 --btn-bg 与 --btn-fg', () => {
    const cls = buttonClasses({ ...base, color: 'primary' })
    expect(cls).toContain('ub-c-primary')
    expect(cls).toContain('ub-fg-primary')
    // ⚠️ 不许再出现第三个颜色概念（曾经有过 ub-w-* / ub-ink-*，都废掉了）
    expect(cls).not.toContain('ub-ink-')
    expect(cls).not.toContain('ub-w-')
  })

  it('每个颜色都挂齐两个类', () => {
    for (const c of COLORS) {
      const cls = buttonClasses({ ...base, color: c })
      expect(cls, c).toContain(`ub-c-${c}`)
      expect(cls, c).toContain(`ub-fg-${c}`)
    }
  })

  it('只有 uno.config 的 safelist 里登记过的颜色类名 —— 名字对得上', () => {
    // 与 uno.config.mjs 的 safelist 保持一致的形状（改一处要改两处，所以钉在这里）
    const expected = COLORS.map((c) => `ub-c-${c}`)
    expect(expected).toEqual([
      'ub-c-primary', 'ub-c-accent',
      'ub-c-success', 'ub-c-warning', 'ub-c-error',
    ])
  })

  it('ub-square 与 ub-tall 互斥（同时挂会让正方形被 padding 撑歪）', () => {
    const normal = buttonClasses(base)
    const icon = buttonClasses({ ...base, onlyIcon: true })
    expect(normal).toContain('ub-tall')
    expect(normal).not.toContain('ub-square')
    expect(icon).toContain('ub-square')
    expect(icon).not.toContain('ub-tall')
  })

  it('⭐ 不传任何属性时 = fill + primary（默认按钮 = primary 系列）', () => {
    const cls = buttonClasses({
      variant: undefined, color: undefined, size: undefined, roundness: undefined,
      iconPosition: undefined, onlyIcon: false, disabled: false, loading: false, width: '',
    })
    expect(cls).toContain('ub-fill')
    expect(cls).toContain('ub-c-primary')
    expect(cls).toContain('ub-fg-primary')
    // 默认尺寸 md、默认圆角 md
    expect(cls).toContain('ub-s-md')
    expect(cls).toContain('ub-r-md')
  })

  it('⭐ surface 不再是合法按钮色 —— 传了会落到默认 primary', () => {
    // surface 是"面/背景色"，做按钮时压在同色卡片上看不见（用户 2026-10 定去掉）
    expect(COLORS).not.toContain('surface')
    expect(buttonClasses({ ...base, color: 'surface' })).toContain('ub-c-primary')
  })

  it('旧 color="default" 落到 primary（它对应的就是"默认按钮"）', () => {
    expect(buttonClasses({ ...base, color: 'default' })).toContain('ub-c-primary')
  })

  it('variant / size / roundness 都进了类名', () => {
    const cls = buttonClasses({ ...base, variant: 'glass', size: 'xl', roundness: 'full' })
    expect(cls).toContain('ub-glass')
    expect(cls).toContain('ub-s-xl')
    expect(cls).toContain('ub-r-full')
  })

  it('整体拼装：没有空串、没有多余空格', () => {
    const cls = buttonClasses(base)
    expect(cls).not.toMatch(/\s{2,}/)
    expect(cls.startsWith(' ')).toBe(false)
    expect(cls.endsWith(' ')).toBe(false)
    expect(cls.split(' ')).not.toContain('')
  })

  it('状态类只在需要时出现', () => {
    expect(buttonClasses(base)).not.toContain('ub-disabled')
    expect(buttonClasses({ ...base, disabled: true })).toContain('ub-disabled')
    expect(buttonClasses({ ...base, loading: true })).toContain('ub-loading')
    expect(buttonClasses({ ...base, width: 'full' })).toContain('ub-full')
  })
})

describe('ui-button 图标间距', () => {
  it('默认在左、end 在右、only-icon 不留边距', () => {
    expect(iconGapClass(false, 'start')).toBe('mr-xs')
    expect(iconGapClass(false, 'end')).toBe('ml-xs')
    expect(iconGapClass(true, 'start')).toBe('mr-0 ml-0')
    expect(iconGapClass(true, 'end')).toBe('mr-0 ml-0')
  })

  it('⚠️ 只用不需转义的类名（build 的 escapeWxmlClasses 不改写 TS 字符串）', () => {
    // 若这里出现 [ ] . 等需要转义的字符，写在 TS 里的类名会与产物选择器对不上 ⇒ 静默失效
    for (const arg of [true, false]) {
      for (const pos of ['start', 'end']) {
        expect(iconGapClass(arg, pos), '不许出现需要转义的字符').toMatch(/^[a-z0-9- ]+$/)
      }
    }
  })
})
