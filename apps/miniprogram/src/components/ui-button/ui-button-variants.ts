/**
 * ⭐ ui-button 的**纯逻辑** —— 属性取值解析 + 类名拼装。
 *
 * ⚠️ 为什么单独一个文件（而不是写在 ui-button.ts 里）：
 *    这一段原来内联在组件的 `sync()` 里，于是**测不到** —— 结果就踩了一个
 *    "新值被旧表吞掉"的坑（见下面 pickValue 的注释），表现是
 *    `glass` 画成实心、`primary/surface` 画成同一个颜色，而构建与 tsc 全不报。
 *    抽成纯函数之后，`ui-button-variants.test.ts` 能把它钉住。
 */

export type Variant = 'fill' | 'outline' | 'ghost' | 'glass'
export type BtnColor = 'primary' | 'accent' | 'success' | 'warning' | 'error'
export type Size = 'sm' | 'md' | 'lg' | 'xl'
export type Roundness = 'sm' | 'md' | 'lg' | 'full'
export type IconPosition = 'start' | 'end'

/** 合法的新取值 —— ⚠️ 加值必须同时加进 uno.config.mjs 的 safelist */
export const VARIANTS: readonly Variant[] = ['fill', 'outline', 'ghost', 'glass']
/**
 * ⚠️ 没有 surface：**surface 不适合做按钮**（用户 2026-10 定）——
 *    它是"面/背景色"（#F6F6F6），做成 fill 时压在同色卡片上看不见、
 *    做 outline/ghost 的字色时对比度只有 1.1:1。
 *    ⚠️ 但 theme 里的 surface **token 本身要留着**（卡片、底色都在用）。
 */
export const COLORS: readonly BtnColor[] = [
  'primary', 'accent', 'success', 'warning', 'error',
]
export const SIZES: readonly Size[] = ['sm', 'md', 'lg', 'xl']
export const ROUNDNESSES: readonly Roundness[] = ['sm', 'md', 'lg', 'full']

/**
 * 旧值 → 新值。**只放"旧写法里存在、新定义里没有"的那些**。
 * ⚠️ 不要把新值也放进来（`fill: 'fill'` 这种）—— 那会掩盖下面 pickValue 的顺序问题。
 */
export const LEGACY_VARIANT: Record<string, Variant> = {
  link: 'ghost', // link 已并入 ghost 的极简形
}
export const LEGACY_COLOR: Record<string, BtnColor> = {
  brand: 'primary',
  // ⚠️ 旧 default 是"深色中性实心"（#111）—— 它对应的就是"默认按钮"，
  //    而"默认按钮 = primary 系列"，所以映射到 primary
  default: 'primary',
  ok: 'success',
}
export const LEGACY_ROUNDNESS: Record<string, Roundness> = {
  none: 'sm',
  xs: 'sm',
  ghost: 'sm',
}

/**
 * ⚠️⚠️ 取值解析：**先当新值用**，只在它不认识时才查旧表翻译。
 *
 * 踩过的坑（真机截图抓到，构建 / tsc / lint 全不报）：
 * 原来写的是 `LEGACY_VARIANT[raw] ?? 'fill'` / `LEGACY_COLOR[raw] ?? 'surface'`
 * —— 把所有值都塞进**旧表**查。于是**新值里不在旧表的那些**（`glass`、`primary`、
 * `surface`）通通落到默认值：
 *   · `variant="glass"` → 变成 `fill`（玻璃态画成实心）
 *   · `color="primary"` → 变成 `surface`（底色 #F6F6F6 压在同色卡片上 ⇒ 看不见）
 * 症状是"某几个颜色/某个形态怎么都不生效、其余正常"，极难定位。
 *
 * ⇒ 顺序必须是：**合法新值 → 旧值翻译 → 默认值**。
 */
export function pickValue<T extends string>(
  raw: unknown,
  valid: readonly T[],
  legacy: Record<string, T>,
  fallback: T,
): T {
  const v = String(raw ?? '').trim()
  if ((valid as readonly string[]).includes(v)) return v as T
  return legacy[v] ?? fallback
}

export interface ButtonAttrs {
  variant: unknown
  color: unknown
  size: unknown
  roundness: unknown
  iconPosition: unknown
  onlyIcon: boolean
  disabled: boolean
  loading: boolean
  /** 'full' 或数字（px） */
  width: unknown
}

/**
 * 拼出根节点的类名。
 *
 * ⚠️ 颜色是**两个类**，缺一不可：
 *   `ub-c-*` → `--tk-color`（基色，即 --btn-bg 的默认）   `ub-fg-*` → `--tk-on`（反色，即 --btn-fg 的默认）
 */
export function buttonClasses(a: ButtonAttrs): string {
  const variant = pickValue<Variant>(a.variant, VARIANTS, LEGACY_VARIANT, 'fill')
  const color = pickValue<BtnColor>(a.color, COLORS, LEGACY_COLOR, 'primary')
  const size = pickValue<Size>(a.size, SIZES, {}, 'md')
  const roundness = pickValue<Roundness>(a.roundness, ROUNDNESSES, LEGACY_ROUNDNESS, 'md')
  const iconPosition: IconPosition = a.iconPosition === 'end' ? 'end' : 'start'

  return [
    'ub', // 承载可覆盖的颜色变量（--ub-color-*）
    'ub-base', // 布局（flex / 居中 / 边框 / line-height）
    a.onlyIcon ? 'ub-square' : 'ub-tall', // 正方形 vs 内容宽 —— 二选一，绝不并存
    'ub-' + variant,
    'ub-s-' + size,
    'ub-c-' + color,
    'ub-fg-' + color,
    'ub-r-' + roundness,
    a.disabled ? 'ub-disabled' : '',
    a.loading ? 'ub-loading' : '',
    a.width === 'full' ? 'ub-full' : '',
  ]
    .filter(Boolean)
    .join(' ')
}

/** 图标与文字的间距 —— 直接用标准原子类（⚠️ 必须挑不需转义的类名，见 sync 的注释） */
export function iconGapClass(onlyIcon: boolean, iconPosition: unknown): string {
  if (onlyIcon) return 'mr-0 ml-0'
  return iconPosition === 'end' ? 'ml-xs' : 'mr-xs'
}
