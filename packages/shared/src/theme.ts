import type { ArticleTheme } from './types/content'

/**
 * ⭐ 内容 hash → 视觉主题（**确定性**配色）。
 *
 * 目标：
 *  ① 同一 hash 永远同一颜色（跨环境、跨部署一致，端侧/服务端同一份实现）；
 *  ② 浅底 + 深字，天然高对比，不依赖人工校验；
 *  ③ 色相分布均匀，相邻内容不会撞成一片。
 *
 * 算法：
 *  1. FNV-1a 32 位哈希（纯算术、零依赖，Node 与小程序结果一致）；
 *  2. 色相 hue = hash % 360
 *  3. background = hsl(hue, 70%, 90%)   —— 很浅的底
 *  4. foreground = hsl(hue, 70%, 10%)   —— **明度取反**（100-90）= 反向色
 *  输出统一转成 #rrggbb：WXSS / 内联样式都最稳，肉眼也一眼能看懂。
 */

/** FNV-1a 32 位 —— 对字符串稳定、实现无依赖 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // Math.imul 保证按 32 位溢出（JS 的 * 会丢精度）
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** HSL → #rrggbb（h∈[0,360)，s/l∈[0,100]） */
function hslToHex(h: number, s: number, l: number): string {
  const sN = s / 100
  const lN = l / 100
  const c = (1 - Math.abs(2 * lN - 1)) * sN
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))

  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) {
    r = c
    g = x
  } else if (hp < 2) {
    r = x
    g = c
  } else if (hp < 3) {
    g = c
    b = x
  } else if (hp < 4) {
    g = x
    b = c
  } else if (hp < 5) {
    r = x
    b = c
  } else {
    r = c
    b = x
  }

  const m = lN - c / 2
  const toHex = (v: number): string => {
    const n = Math.round((v + m) * 255)
    const clamped = n < 0 ? 0 : n > 255 ? 255 : n
    return clamped.toString(16).padStart(2, '0')
  }
  return '#' + toHex(r) + toHex(g) + toHex(b)
}

/** 底色明度；前景 = 100 - 它（取反） */
const BG_LIGHTNESS = 90
const FG_LIGHTNESS = 100 - BG_LIGHTNESS
const SATURATION = 70

/**
 * ⭐ theme 缺失时的兜底 —— **品牌色**。
 *
 * ⚠️ 用户定的规则：卡片上**不再出现品牌色按钮**；品牌色只在 theme 丢失时兜底。
 *    所以兜底用品牌紫做底、白字做前景。
 */
export const FALLBACK_THEME: ArticleTheme = {
  image: null,
  background: '#4f46e5',
  foreground: '#ffffff',
}

/**
 * ⭐ theme 或兜底 —— 端侧组件统一走它，别各自 `theme ?? {...}` 抄一份。
 *
 * ⚠️⚠️ 给了 articleId 就**按 id 复算**，不要随手给品牌色：
 *    theme 本来就是 id 的纯函数（themeFromHash），库里那一列只是它的**物化副本**。
 *    副本缺失（NULL）时，一端给品牌紫、另一端按 id 算出蓝绿 ——
 *    同一句话在两个页面就是两个颜色，这正是「同一事实两个来源」的典型后果。
 *    后台详情页早就是 `row.theme ?? themeFromHash(row.id)`（tools/admin/server.ts），
 *    端侧以前只是 `theme ?? 品牌色`，两边因此长期不一致。
 *    ⇒ 有 id 就复算，结论与「后台发布的」逐字节一致；**连 id 都没有**才用品牌色。
 */
export function resolveTheme(
  theme: ArticleTheme | null | undefined,
  articleId?: string | null,
): ArticleTheme {
  if (theme) return theme
  if (articleId) return themeFromHash(articleId)
  return FALLBACK_THEME
}

/**
 * ⭐ 由内容 hash 算出一份 theme。
 * ⚠️ image 目前留 null（用户后续再定配图怎么来）。
 */
export function themeFromHash(hash: string): ArticleTheme {
  const hue = fnv1a(hash) % 360
  return {
    image: null,
    background: hslToHex(hue, SATURATION, BG_LIGHTNESS),
    foreground: hslToHex(hue, SATURATION, FG_LIGHTNESS),
  }
}
