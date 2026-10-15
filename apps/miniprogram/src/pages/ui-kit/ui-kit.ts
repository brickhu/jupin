/**
 * ⭐ **组件库展示页**（`pages/ui-kit`）—— 把统一组件的各个维度全画出来，用来肉眼验收。
 *
 * ⚠️ 这是**开发用的展示页**，不是业务页：数据全在本地、不发任何请求、不写任何状态。
 *    它的价值是"改完组件样式，一屏看全部组合"，省掉在业务页里翻十个场景的功夫。
 *
 * ⚠️ 页面上**没有任何按钮会真的做事** —— onPress 只 console.log 一下，
 *    免得"点了个假按钮没反应"被当成 bug。
 *
 * 现有两节：`ui-button`（四维度矩阵）· `ui-dialog`（两条位置 × 三个槽位的五种形态）。
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

/** 演示弹窗的一次配置 —— 四个值原样喂给 <ui-dialog> 的四个属性 */
interface DialogCase {
  position: string
  title: string
  closable: boolean
  note: string
}

/**
 * ⭐ 弹窗的五种演示形态。
 *
 * ⚠️ 用 switch 而不是一张表：`noUncheckedIndexedAccess` 开着，按 key 取表会变成
 *    `DialogCase | undefined`，于是每个字段都要写一次断言 —— switch 让类型自己收窄。
 *    取不到 key（WXML 改了而这里没跟）就落第一个形态，**不 throw**：展示页不该因为
 *    一个 data-case 拼错就白屏。
 */
function dialogCase(key: string): DialogCase {
  switch (key) {
    case 'centerHead':
      return {
        position: 'center',
        title: '',
        closable: true,
        note: '没有 title ⇒ 这一版画的是 head 槽（配了 title 它就整个不渲染）',
      }
    case 'centerNoMask':
      return {
        position: 'center',
        title: '云端正在算这一句',
        closable: false,
        note: 'closable=false：点遮罩没有反应（等待期就是这样，prd §7.2）',
      }
    case 'bottom':
      return {
        position: 'bottom',
        title: '今天的挑战',
        closable: true,
        note: 'bottom：100vw 贴底、从下往上滑出（顶角圆、底角方）',
      }
    case 'bare':
      return {
        position: 'center',
        title: '',
        closable: true,
        note: '只有 main + foot，head 槽空着 —— 顺便看那一段间距',
      }
    default:
      return {
        position: 'center',
        title: '确认删除这条录音？',
        closable: true,
        note: 'position=center：宽度自适应外容器（两边 12px、最多 390px），上下居中 + 从中心向外放大',
      }
  }
}

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

    /**
     * ⭐ ui-dialog 演示用的四个属性 —— **全部由页面持有**（受控）。
     * ⚠️ 组件自己不关自己：点遮罩只抛 hide，关不关由这里说了算。
     */
    dlgShow: false,
    dlgPosition: 'center',
    dlgTitle: '',
    dlgClosable: true,
    /** 这一次演示"在演什么" —— 画在 main 槽里，免得看的人分不清点的是哪一种 */
    dlgNote: '',
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

  /** ⭐ 打开演示弹窗 —— 五个按钮共用这一个方法，形态由 data-case 决定 */
  onOpenDialog(e: WechatMiniprogram.BaseEvent) {
    const key = String((e.currentTarget.dataset as { case?: unknown }).case ?? '')
    const c = dialogCase(key)
    this.setData({
      dlgShow: true,
      dlgPosition: c.position,
      dlgTitle: c.title,
      dlgClosable: c.closable,
      dlgNote: c.note,
    })
  },

  /**
   * ⭐ 组件抛上来的 `hide`（唯一来源是点遮罩）。
   * ⚠️ 它只是**请求**关闭 —— 真正关窗是下面这一句（组件自己不关自己）。
   * ⚠️ 页面自己把 dlgShow 置 false 时**不会再回调 hide**（否则一次点击会触发两遍）。
   */
  onDialogHide() {
    console.log('[ui-kit] dialog hide（点遮罩）')
    this.setData({ dlgShow: false })
  },

  /** 弹窗里那两颗按钮 = 页面自己的动作，直接关 */
  onDialogClose() {
    this.setData({ dlgShow: false })
  },
})

