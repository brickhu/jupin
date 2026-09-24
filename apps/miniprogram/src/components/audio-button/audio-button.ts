import { formatDuration } from '@jushuo/shared'

/**
 * ⭐ 全站唯一的**音频播放按钮**。
 *
 * 形状、状态、时长的写法只在这里定义一次：
 *
 *   size           sm（44rpx）| md（64rpx）| lg（88rpx）
 *   state          unplay（▶ play，**描边**）| loading（转圈的 spinner）| playing（■ stop，实心）
 *   showDuration   右侧跟不跟一个时长
 *   durationMs     时长（毫秒）→ 统一 `00:05`，由 shared 的 formatDuration 格式化
 *
 * ⚠️ ⭐ **未播放 = 描边，正在取音/播放 = 实心** —— 一屏里好几颗钮时，
 *    只有正在响的那一颗是实心，扫一眼就知道声音从哪儿来。
 *    描边那颗的**线色与图标色同色**（都用 fill）：主题卡上的 fill 是卡片的前景色，
 *    拿 ink（卡片底色）画图标会直接看不见。
 *
 * ⚠️ **配色由宿主给**（fill = 圆底/描边色 / ink = 实心时的图标色），不给就是品牌色。
 *    主题卡上要反色（圆底用卡片的前景色、图标用卡片的底色），宿主写
 *    `fill="{{fg}}" ink="{{bg}}"` —— 与改造前那句内联 style 是同一个意思。
 * ⚠️ 时长格式**只在这里统一**：各页不再自己拼 `0:03` / `3.0 秒`，
 *    否则同一屏里两种写法并存，看起来像在量不同的东西。
 * ⚠️ 圆钮用 catchtap：它几乎都嵌在「整块可点」的卡片里（点卡片=进详情），
 *    不拦住冒泡就会变成「点播放却进了详情页」。
 * ⚠️ loading 用旋转的弧，静止的弧看起来像「卡住了」而不是「在转」。
 *
 * 事件：play —— 宿主据此在 播 / 停 之间切换。
 */

/** state → 字形。⚠️ `playing` 是 **stop** 不是 pause：这里没有「暂停后续播」 */
const GLYPH: Record<string, string> = {
  unplay: 'icon-play',
  loading: 'icon-loading',
  playing: 'icon-stop',
}

Component({
  // ⚠️ apply-shared：.iconfont / .icon-* 定义在 app.wxss 里，
  //    isolated 的组件拿不到，字形会整个不显示（且不报错）
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** 'sm' | 'md' | 'lg' */
    size: { type: String, value: 'md' },
    /** 'unplay' | 'loading' | 'playing' */
    state: { type: String, value: 'unplay' },
    /** 右侧是否显示时长 */
    showDuration: { type: Boolean, value: false },
    /** 音频时长（毫秒）—— 0 / 算不出来 = 不显示（见 formatDuration） */
    durationMs: { type: Number, value: 0 },
    /** 圆底颜色 */
    fill: { type: String, value: '#4f46e5' },
    /** 图标颜色 */
    ink: { type: String, value: '#ffffff' },
    /** 置灰、并且点了不抛事件（例：这段录音不允许我听） */
    disabled: { type: Boolean, value: false },
  },

  data: {
    glyph: GLYPH.unplay as string,
    spinning: false,
    durationText: '',
    /**
     * ⚠️ 尺寸类**在 TS 里拼成整串**再交给 WXML，不写 `class="ab-{{size}}"`：
     *    那种写法会被构建期的类名检查抓到半截 `ab-`（模板里插值处会切成空格），
     *    而且真机上也不保证拼得对。整串传进去就没有这个中间态。
     */
    circleClass: 'ab-md',
    glyphClass: 'ab-glyph-md',
    durationClass: 'ab-duration-md',
    /** 未播放 = 描边（默认状态就是它，初始值先按描边给，避免首帧闪一下实心） */
    outline: true,
    circleStyle: 'border-color:#4f46e5',
    glyphStyle: 'color:#4f46e5',
  },

  observers: {
    'size, state, durationMs'() {
      this.sync()
    },
  },

  lifetimes: {
    attached() {
      this.sync()
    },
  },

  methods: {
    sync() {
      const state = this.data.state
      const size = this.data.size
      const outline = state === 'unplay'
      const fill = this.data.fill
      const ink = this.data.ink
      this.setData({
        glyph: GLYPH[state] ?? GLYPH.unplay,
        spinning: state === 'loading',
        durationText: formatDuration(this.data.durationMs),
        circleClass: 'ab-' + size,
        glyphClass: 'ab-glyph-' + size,
        durationClass: 'ab-duration-' + size,
        outline,
        // ⚠️ 样式整串在 TS 里拼，不写 style="background:{{...}}"：
        //    描边态要改的是「border-color + 透明底」两件事，模板里堆三元表达式没法看
        circleStyle: outline ? 'border-color:' + fill : 'background:' + fill,
        // ⚠️ 描边态的图标与线同色（见文件头：主题卡上 fill 才是看得见的那个颜色）
        glyphStyle: 'color:' + (outline ? fill : ink),
      })
    },

    onTap() {
      if (this.data.disabled) return
      this.triggerEvent('play')
    },
  },
})
