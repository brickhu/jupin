import {
  ANIM_MS,
  closesOnMaskTap,
  dialogClasses,
  headMode,
} from './ui-dialog-variants'

/**
 * ⚠️ 等一帧再翻 entered —— 元素和它的最终样式落在同一帧里，中间就没有任何一帧可以过渡
 *    （症状是"没有出入场动画"，同 user-sheet）。
 */
const NEXT_FRAME_MS = 20

/** 组件实例上的**私有字段**（不参与渲染）—— 为什么不用 this.xxx 见 nav-bar.ts 同一段说明 */
interface Internals {
  openTimer: ReturnType<typeof setTimeout> | null
  closeTimer: ReturnType<typeof setTimeout> | null
}

const priv = (ctx: unknown): Internals => {
  const p = ctx as Internals
  if (p.openTimer === undefined) p.openTimer = null
  if (p.closeTimer === undefined) p.closeTimer = null
  return p
}

/**
 * ⭐⭐ **统一弹窗** —— 小程序端所有浮层的唯一实现（对浮层的意义 = `ui-button` 对按钮的意义）。
 *
 * 对外只有四件事：
 *   · `show`     —— **父组件持有**的开关（受控：组件自己从不关自己）
 *   · `position` —— `center` **宽度自适应外容器**（两边各留 12px、最多 390px）、上下居中，
 *                   **从中间向外放大**出现
 *                   `bottom` 100vw、贴底，**从下往上滑出**
 *   · `title`    —— 空的就不画那一行；**与 head 槽互斥**（配了 title，head 槽不渲染）
 *   · `closable` —— 默认 true；**它只决定"点遮罩能不能关"**，不是"有没有关闭钮"
 * 三个槽位 `head` / `main` / `foot`，彼此间距 = `space.md`（32rpx）。
 * 关闭时抛 `hide`，父组件在回调里把 `show` 置回 false。
 *
 * ⚠️⚠️ `options.multipleSlots` **不能删**：不声明它，组件模板里**只认第一个 `<slot>`**，
 *    于是 main / foot 的内容会**静默不见**（不报错、不警告）。
 * ⚠️⚠️ `ui-dialog.json` 里的 `styleIsolation: apply-shared` **不能删**：面板的底色 / 字色 / 圆角
 *    走的是 `bg-page` · `text-page-on` · `rounded-lg` 三个 token 类，它们生成在 app.wxss（uno.wxss）里；
 *    隔离掉之后面板就是**透明无圆角**的一块（同 ui-button 那条踩过的坑）。
 *
 * ⚠️ 为什么是"父组件持有 show"而不是 `wx.showModal` 那种命令式：
 *    浮层要盖的页面状态（在录音 / 在提交）本来就在页面里；命令式会让"谁在管这个开关"变成两处。
 *    （同 user-sheet / energy-tips 的既有做法。）
 *
 * ⚠️ 收起后**节点会被摘掉**（mounted=false）⇒ 槽位里的输入内容、scroll-view 的位置，
 *    第二次打开都是全新的。要留住就自己在页面里存。
 *
 * ⚠️ 位置与动画的对应关系（改一处必须改另一处，都在 ui-dialog.wxss）：
 *    center → `scale(0.94) → 1`（默认 transform-origin 就是中心，"向外放大"就是这个）
 *    bottom → `translateY(100%) → 0`
 */
Component({
  options: {
    /**
     * ⚠️ head / main / foot 三个槽位必须靠它才同时生效 —— 见上面那段（不声明就是静默失效）。
     * 写在 options 里而不是 json：json 没有这个字段。
     */
    multipleSlots: true,
  },

  properties: {
    /** 受控开关 —— 组件关闭自己时只是抛 `hide`，改不改由父组件决定 */
    show: {
      type: Boolean,
      value: false,
      observer(v: boolean) {
        this.toggle(v === true)
      },
    },
    /** center（默认：宽度自适应外容器、两边 12px、最多 390px，居中 + 向外放大）| bottom（100vw 贴底、向上滑出） */
    position: { type: String, value: 'center' },
    /** 标题文字 —— 空就不画那一行；**配了它，head 槽就不渲染**（互斥） */
    title: { type: String, value: '' },
    /**
     * 点遮罩能不能关（默认 true）。
     * ⚠️ 它**只管遮罩**：等待期那种"能量已扣、云端正在算"的浮层传 false
     *    （prd §7.2：点遮罩无效、也不画 ×）—— 拦的是误触，不是"没给关闭方式"。
     */
    closable: { type: Boolean, value: true },
  },

  data: {
    /** 在不在渲染树里（收起动画放完才置 false）—— 与 entered 分开才有动画 */
    mounted: false,
    /** 有没有放到位 —— 决定 ud-on（遮罩与面板用的是同一个表达式） */
    entered: false,
    layerCls: 'ud-layer ud-layer-center',
    panelCls: 'ud-panel ud-panel-center',
    /**
     * **光板**：既不画 head 那一行、也不画 foot 那一行。
     * ⚠️ 用于"只有一个 body"的面板（录音流程里那四个都是）——
     *    空的 head/foot 会白占一行并多出一段 `gap`（见 ui-dialog-variants.ts 的 headMode）。
     */
    bare: { type: Boolean, value: false },
    /** 'title' | 'slot' | 'none' —— head 那一行画谁（判据在 ui-dialog-variants.ts） */
    headMode: 'slot',
  },

  observers: {
    // ⚠️ 观察者里**不许 return 一个值**：wx 把它的类型定成 `=> void`，
    //    写了会让整个 Component 字面量的 `this` 推断崩掉（满屏"possibly undefined"却指不到这里）。
    'position, title'() {
      this.syncView()
    },
  },

  lifetimes: {
    attached() {
      this.syncView()
      // ⚠️ 挂载时就带着 show=true（页面直接把它渲染出来）也要放出来：
      //    属性 observer 不保证在 attached 之前跑过。
      if (this.data.show === true) this.toggle(true)
    },
    detached() {
      // ⚠️ 定时器必须撤：组件已经销毁，回调里再 setData 会报错
      const p = priv(this)
      if (p.openTimer !== null) clearTimeout(p.openTimer)
      if (p.closeTimer !== null) clearTimeout(p.closeTimer)
      p.openTimer = null
      p.closeTimer = null
    },
  },

  methods: {
    /** 把属性翻成类名 —— 取值解析与拼装都在 ui-dialog-variants.ts 的纯函数里（那样才测得到） */
    syncView() {
      const d = this.data as Record<string, unknown>
      const cls = dialogClasses(d.position)
      this.setData({
        layerCls: cls.layer,
        panelCls: cls.panel,
        headMode: headMode(d.title, d.bare),
      })
    },

    /**
     * 开 / 收。
     * ⚠️ 顺序不能反：**先播收回动画，再把节点摘掉** —— 反过来会先"啪"地跳回原位再消失。
     */
    toggle(open: boolean) {
      const p = priv(this)
      // ⚠️ 先撤上一轮的定时器：连点两下时，旧的那个会把刚拉开的弹窗又收回去
      if (p.openTimer !== null) {
        clearTimeout(p.openTimer)
        p.openTimer = null
      }
      if (p.closeTimer !== null) {
        clearTimeout(p.closeTimer)
        p.closeTimer = null
      }

      if (open) {
        // 打开这一刻把位置类名算对（属性可能刚变过）
        this.syncView()
        this.setData({ mounted: true })
        p.openTimer = setTimeout(() => {
          p.openTimer = null
          if (this.data.mounted === true) this.setData({ entered: true })
        }, NEXT_FRAME_MS)
        return
      }

      this.setData({ entered: false })
      p.closeTimer = setTimeout(() => {
        p.closeTimer = null
        this.setData({ mounted: false })
      }, ANIM_MS)
    },

    /**
     * 点遮罩 —— `closable` 为 false 时**什么都不做**（等待期就是靠这一条拦误触）。
     *
     * ⚠️ 这里只**抛事件**、不自己关：开关在父组件手上（受控）。
     *    父组件把 show 置 false → observer → 收回动画。
     * ⚠️ 父组件**自己**把 show 置 false 时不再回调 `hide` —— 那是父组件自己的动作，
     *    回掉会让"在 hide 回调里关窗"变成一次点击触发两遍（同 user-sheet 的 close）。
     */
    onMaskTap() {
      if (!closesOnMaskTap(this.data.closable)) return
      this.triggerEvent('hide', { source: 'mask' })
    },

    /**
     * 挡住点击 / 滚动穿透用的空处理器，不要删。
     * ⚠️ 面板上也挂了 catchtouchmove（见 wxml 的说明）—— 那一条会连带挡住 main 里的滚动；
     *    main 以后真要有可滚动内容，就改成"没滚到边界时才拦"。
     */
    noop() {},
  },
})
