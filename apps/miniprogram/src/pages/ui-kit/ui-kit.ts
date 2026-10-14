/**
 * ⭐ **ui-button 展示页**（`pages/ui-kit`）—— 把统一按钮的四个维度全画出来，用来肉眼验收。
 *
 * ⚠️ 这是**开发用的展示页**，不是业务页：数据全在本地、不发任何请求、不写任何状态。
 *    它的价值是"改完按钮样式，一屏看全部组合"，省掉在业务页里翻十个场景的功夫。
 *
 * ⚠️ 页面上**没有任何按钮会真的做事** —— onTap 只 console.log 一下，
 *    免得"点了个假按钮没反应"被当成 bug。
 */

import { themeFromHash } from '@jushuo/shared'

import { navPadTop } from '../../lib/nav'

const VARIANTS = ['fill', 'outline', 'ghost', 'glass'] as const

/** 六个 color */
const COLORS = ['surface', 'primary', 'accent', 'success', 'warning', 'error'] as const

/** 四档尺寸 */
const SIZES = ['sm', 'md', 'lg', 'xl'] as const

/** 四档圆角 */
const ROUNDNESS = ['sm', 'md', 'lg', 'full'] as const

Page({
  data: {
    variants: VARIANTS,
    colors: COLORS,
    sizes: SIZES,
    roundness: ROUNDNESS,
    /** 导航栏总高（布局用，见 lib/nav.ts 的约定） */
    navTop: 0,
    /**
     * ⭐ 「外部覆盖」那一区用的**真实主题色** —— 直接用项目的 themeFromHash，
     *   与 arena-card / submission-card 同一套（浅底 + 深字，由 id 哈希决定）。
     * ⚠️ 这里**不许手写颜色**：演示用的颜色必须来自真实来源，否则看的人会以为
     *    那是设计系统里的一档（踩过：为了演示覆盖随手编了两个色）。
     */
    themeBg: '',
    themeFg: '',
  },

  onLoad() {
    // ⚠️ 展示页不做业务取数，但顶部要避开导航栏 —— 沿用项目统一的 navPadTop()
    const theme = themeFromHash('ui-kit-演示')
    this.setData({ navTop: navPadTop(), themeBg: theme.background, themeFg: theme.foreground })
  },

  /** 所有按钮的 press 都落这里：只打印，不做任何事 */
  onPress(e: WechatMiniprogram.CustomEvent) {
    const ds = (e.detail as { dataset?: Record<string, unknown> })?.dataset ?? {}
    console.log('[ui-kit] press', ds)
  },
})
