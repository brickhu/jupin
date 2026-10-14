import { isIconName } from '../../lib/icon-names'
import type { ArticleTheme } from '@jushuo/shared'

/**
 * ⭐⭐ **统一按钮** —— 小程序端所有按钮的唯一实现。
 *
 * ⚠️⚠️ 为什么必须统一：以前每个页面各写一个 `view.rounded-full + bindtap`，
 *    结果同一件事（主 CTA）在五个页面长成五种样子：高度 76/88/100rpx 混用、
 *    禁用态有的降透明度有的不改、加载态有的转圈有的只是变灰。
 *    这里把「形态」和「语义」分开，四个维度（取值定义在 ui-button-variants.ts）：
 *      · variant   = 长什么样（fill / outline / ghost / glass）
 *      · color     = 什么语义（primary / accent / success / warning / error）
 *      · size      = 多大（sm / md / lg / xl）
 *      · roundness = 多圆（sm / md / lg / full）
 *    组合由组件算，调用方只说这四件事。
 *
 * ⚠️ 取值解析与类名拼装在 **ui-button-variants.ts**（纯函数、有单测）——
 *    那一段曾经内联在这里的 sync() 里，于是测不到，踩了"新值被旧表吞掉"的坑。
 *
 * ⚠️ **所有组合的类名都在 TS 里拼**（class="{{cls}}"），不在 WXML 里拼 ——
 *    WXML 里写 `class="ub-{{variant}}"` 会让构建期「类名必须能解析」那条检查
 *    看到半截 token（`ub-`）而报错。
 *
 * ⚠️ 用法：`<ui-button bind:press="onXxx">文字</ui-button>`
 *    ⚠️ 事件名是 **press**（不是 tap），理由见 onTap 里那段注释。
 *
 * ⚠️⚠️ `ui-button.json` 里的 **`"styleIsolation": "apply-shared"` 不能删** ——
 *    实测（2026-09）：不写它，按钮里的图标画出来是**空的**（文字正常）。
 *    仓库里另外两个用到 app.wxss 里图标的组件（arena-card / audio-button）也都写着它。
 *    别只按"看起来无关"就删掉，那是踩过一次的坑。
 *
 * ⚠️ 图标走项目自带的 **CSS mask 图标**（Iconify 数据 → icons.wxss，见 tools/iconfont/build.mjs）——
 *    所以 icon 传的是 **iconify 名**（mdi:play / clarity:favorite-line），由 <ui-icon> 渲染。
 *    ⚠️⚠️ 名单里**没有**的图标画不出来（名单见 `lib/icon-names.ts`，**自动生成**）
 *    —— 要新图标得先把它加进 `tools/iconfont/build.mjs` 的 ICONS 再重新生成。
 */

/**
 * 校验图标名，并把"名单里没有"这件事**当场说出来**。
 *
 * ⚠️ 名单**不在这里手写**：`lib/icon-names.ts` 由 `tools/iconfont/build.mjs` 生成 ——
 *    这里原来手抄过一份，结果两处都漂了（写过从来没进过名单的 `heart`、又漏了在用的 `check`）。
 * ⚠️ 写错一个不存在的名字**不会报错，只是画不出来** —— 所以这一句 warn 必须留着。
 */
function assertIconName(icon: string): string {
  const name = String(icon ?? '').trim()
  if (name && !isIconName(name)) {
    console.warn('[ui-button] 图标不在名单里：' + name + '（名单见 lib/icon-names.ts）')
  }
  return name
}

import { buttonClasses, iconGapClass } from './ui-button-variants'

Component({
  options: { virtualHost: true },
  properties: {
    /** fill(默认) | outline | ghost | glass */
    variant: { type: String, value: 'fill' },
    /**
     * ⭐ 默认 primary —— 「默认按钮 = primary 系列」（用户 2026-10 定）。
     * 所以 `<ui-button>文字</ui-button>` 不写任何属性就是「实心 primary 主按钮」。
     * primary(默认) | accent | success | warning | error
     */
    color: { type: String, value: 'primary' },
    /** sm | md(默认) | lg | xl */
    size: { type: String, value: 'md' },
    /** sm | md(默认) | lg | full */
    roundness: { type: String, value: 'md' },
    /** iconify 名，如 mdi:mic-outline */
    icon: { type: String, value: '' },
    /** 图标在文字之前（start，默认）还是之后（end） */
    iconPosition: { type: String, value: 'start' },
    /** 只画图标 —— ⚠️ 会强制正方形（宽=高），必须给 icon，否则是个空方块 */
    onlyIcon: { type: Boolean, value: false },
    /** 加载中：转圈 + 不吃点击 */
    loading: { type: Boolean, value: false },
    /** 禁用：降透明度 + 不吃点击 */
    disabled: { type: Boolean, value: false },
    /** 'full' 或数字（px）—— 不传就是内容宽度 */
    width: { type: null, value: '' },

  },

  data: {
    cls: '',
    /** 图标与文字的间距 —— 直接用标准原子类（mr-xs / ml-xs / mr-0） */
    gapClass: 'mr-xs',
    iconName: '',
    /** style 属性：只有 width 是数字时才需要 */
    style: '',
  },

  observers: {
    'variant, color, size, roundness, icon, iconPosition, onlyIcon, loading, disabled, width'() {
      this.sync()
    },
  },

  lifetimes: {
    attached() {
      this.sync()
    },
  },

  methods: {
    /**
     * 把属性翻成类名 —— 取值解析与拼装都在 ui-button-variants.ts 的纯函数里
     * （那样才测得到；这里只负责把 data 递过去 + 算图标名与行内 style）。
     */
    sync() {
      const d = this.data as Record<string, unknown>
      const onlyIcon = d.onlyIcon === true
      const width = d.width

      this.setData({
        cls: buttonClasses({
          variant: d.variant,
          color: d.color,
          size: d.size,
          roundness: d.roundness,
          iconPosition: d.iconPosition,
          onlyIcon,
          disabled: d.disabled === true,
          loading: d.loading === true,
          width,
        }),
        gapClass: iconGapClass(onlyIcon, d.iconPosition),
        // ⚠️ loading 时图标换成转圈（icon 位置不变，按钮不跳）
        iconName: d.loading === true ? 'mdi:loading' : assertIconName(d.icon as string),
        style: typeof width === 'number' && width > 0 ? 'width:' + width + 'px' : '',
      })
    },

    onTap(e: WechatMiniprogram.TouchEvent) {
      // ⚠️ 禁用 / 加载中**吞掉**事件：界面看着不能点，就别让它真的能点
      if (this.data.disabled || this.data.loading) return
      /**
       * ⚠️⚠️ 事件名是 **press，不是 tap** —— 这是踩过的坑：
       *    组件根节点一旦用 bindtap，原生 tap 会**继续冒泡**到调用方，
       *    而这里又 triggerEvent 一次 ⇒ 一次点击**触发两次**。
       *    收藏那种"切换"按钮上，两次 = 抵销（点了没反应、收藏后再点取消不掉）。
       *    两道保险：根节点用 catchtap（截住原生冒泡）+ 事件名不叫 tap。
       */
      // ⚠️ 把 dataset 一起透出去：调用方常用 data-xxx 认「是哪一个」（如列表里的第几项）
      this.triggerEvent('press', { dataset: (e.currentTarget as { dataset?: unknown })?.dataset ?? {} })
    },
  },
})