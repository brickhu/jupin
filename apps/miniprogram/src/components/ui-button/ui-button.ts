import type { ArticleTheme } from '@jushuo/shared'

/**
 * ⭐⭐ **统一按钮** —— 小程序端所有按钮的唯一实现。
 *
 * ⚠️⚠️ 为什么必须统一：以前每个页面各写一个 `view.rounded-full + bindtap`，
 *    结果同一件事（主 CTA）在五个页面长成五种样子：高度 76/88/100rpx 混用、
 *    禁用态有的降透明度有的不改、加载态有的转圈有的只是变灰。
 *    这里把「形态」和「语义」分开：
 *      · variant = 长什么样（fill / outline / ghost / link）
 *      · color   = 什么语义（brand / default / error / warning / success）
 *      · size    = 多大（sm / md / lg / xl）
 *    组合由组件算，调用方只说这两件事。
 *
 * ⚠️ **所有组合的类名都在 TS 里拼**（class="{{cls}}"），不在 WXML 里拼 ——
 *    WXML 里写 `class="ub-{{variant}}"` 会让构建期「类名必须能解析」那条检查
 *    看到半截 token（`ub-`）而报错。
 *
 * ⚠️ 图标用的是项目自带的 **iconfont**（Iconify/MDI 子集，见 app.wxss 与
 *    tools/iconfont/build.mjs）—— 所以 icon 传的是 **iconify 名**（mdi:play / mdi:star），
 *    组件取冒号后面的部分拼成 `icon-<name>` 类。
 *    ⚠️⚠️ 子集里**没有**的图标画不出来（只有 12 个：play / stop / home / share /
 *    bell / target / clipboard / fire / heart-outline / chevron-left / chevron-right / loading）
 *    —— 要新图标得先把它加进子集再重新生成。
 */

/** 图标字体里真实存在的名字 —— 传了别的会画出一个空框，这里挡一道并在控制台说清楚 */
const KNOWN_ICONS = new Set([
  'play', 'stop', 'home', 'share', 'bell', 'target', 'clipboard',
  'fire', 'heart-outline', 'heart', 'chevron-left', 'chevron-right', 'loading',
])

type Variant = 'fill' | 'outline' | 'ghost' | 'link'
type Size = 'sm' | 'md' | 'lg' | 'xl'
type BtnColor = 'brand' | 'default' | 'error' | 'warning' | 'success'

/** iconify 名 → iconfont 类名。'mdi:star' → 'icon-star'；已经是 'star' 也认 */
function iconClassOf(icon: string): string {
  const name = String(icon ?? '').trim()
  if (name === '') return ''
  const bare = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name
  if (!KNOWN_ICONS.has(bare)) {
    console.warn('[ui-button] 图标不在 iconfont 子集里：' + name + '（见 tools/iconfont/build.mjs）')
  }
  return 'icon-' + bare
}

Component({
  options: { virtualHost: true },
  properties: {
    /** fill | outline | ghost | link */
    variant: { type: String, value: 'fill' },
    /** sm | md | lg | xl */
    size: { type: String, value: 'md' },
    /** 加载中：转圈 + 不吃点击 */
    loading: { type: Boolean, value: false },
    /** 禁用：降透明度 + 不吃点击 */
    disabled: { type: Boolean, value: false },
    /** 只画图标（⚠️ 必须给 icon，否则是个空按钮） */
    onlyIcon: { type: Boolean, value: false },
    /** iconify 名，如 mdi:heart-outline */
    icon: { type: String, value: '' },
    /** brand | default | error | warning | success */
    color: { type: String, value: 'brand' },
    /** 'full' 或数字（px）—— 不传就是内容宽度 */
    width: { type: null, value: '' },
  },

  data: {
    cls: '',
    iconCls: '',
    /** style 属性：只有 width 是数字时才需要 */
    style: '',
  },

  observers: {
    'variant, size, color, disabled, onlyIcon, icon, width'() {
      this.sync()
    },
  },

  lifetimes: {
    attached() {
      this.sync()
    },
  },

  methods: {
    /** 把属性翻成类名 —— 所有组合都在这里出现，调用方不需要知道类名 */
    sync() {
      const d = this.data as Record<string, unknown>
      const variant = (d.variant as Variant) ?? 'fill'
      const size = (d.size as Size) ?? 'md'
      const color = (d.color as BtnColor) ?? 'brand'
      const onlyIcon = d.onlyIcon === true
      const width = d.width
      const cls = [
        'ub',
        'ub-' + variant,
        'ub-s-' + size,
        'ub-c-' + color,
        onlyIcon ? 'ub-only-icon' : '',
        d.disabled === true ? 'ub-disabled' : '',
        d.loading === true ? 'ub-loading' : '',
        width === 'full' ? 'ub-full' : '',
      ]
        .filter(Boolean)
        .join(' ')
      this.setData({
        cls,
        // ⚠️ loading 时图标换成转圈（icon 位置不变，按钮不跳）
        iconCls: d.loading === true ? 'icon-loading ub-spin' : iconClassOf(d.icon as string),
        style: typeof width === 'number' && width > 0 ? 'width:' + width + 'px' : '',
      })
    },

    onTap(e: WechatMiniprogram.TouchEvent) {
      // ⚠️ 禁用 / 加载中**吞掉**事件：界面看着不能点，就别让它真的能点
      if (this.data.disabled || this.data.loading) return
      // ⚠️ 把 dataset 一起透出去：调用方常用 data-xxx 认「是哪一个」（如列表里的第几项）
      this.triggerEvent('tap', { dataset: (e.currentTarget as { dataset?: unknown })?.dataset ?? {} })
    },
  },
})