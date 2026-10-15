/**
 * ⭐⭐ **参与区（btn-record）** —— 一个句子上的「参与」控件，**五个状态**（prd §7.2）。
 *
 * 规格来源：**Figma `nCFxH5FXIQFiaPKKdtudqO` 的节点 `539:871`**（2026-10-15 逐层对过）。
 * ⚠️ 单位一律 **1px = 2rpx**（设计稿是 375pt 宽的画布，小程序 750rpx）。
 *
 * ## 设计稿的结构（照抄，别"优化"）
 *
 * | 态 | 结构 |
 * |---|---|
 * | `try` | **实心胶囊** 48 高 / r36 / pad12 / gap8：`ms-mic` 20 + 「点击录音，开始朗读」14/400 |
 * | `retry` | **一行**（没有胶囊）：左 = **5 根矩形**（2 宽，高 8/16/24/16/8，gap2）+ 分数 16/700；右 = **48×48 实心圆** + `ms-mic` 20 |
 * | `recoded` | **描边胶囊**（1px currentColor / r36 / pad8）：`ms-undo` ｜ `ms-play` + 00:33 ｜ **32×32 实心圆** + `ms-check` |
 * | `checking` | 同 `recoded`，但 **↺ 降到 0.2 不透明度**（禁用），右端换成 `ms-loading` 24 |
 * | `scored` | 同 `recoded`，但左圆 **24×24**，右端 = 分数 14/700 + `ms-arrow` 12 |
 *
 * ## ⚠️⚠️ 两处**设计稿自相矛盾**、我按可读性做的判断（要改就说）
 *
 * 1. **↺ 那颗圆在稿里是"深色圆 + 深色图标"**（fill `#2b142c`、vector `#2b132c`）——
 *    两者几乎同一个颜色 ⇒ **画出来是看不见的**。对比 ✓ 那颗是"深色圆 + **白**勾"（正常）。
 *    ⇒ 我按**图标自己的颜色**实现：**圆不填充、图标用前景色**。
 *    好处不只是看得见 —— 它还让"次要动作（↺）"与"主要动作（✓ 实心）"**一眼分得开**；
 *    若照抄成两个实心圆，用户根本分不清哪颗是重录、哪颗是提交。
 * 2. **分数色在稿里是 `#000000`**（黑）—— 那是"画在白底上"的颜色。
 *    我们的卡片是**主题色底**（可能很深），照抄黑字会看不见 ⇒ 一律走 `currentColor`。
 *
 * ⚠️ 状态**不由本组件计算**（来自端侧未提交录音 + 服务端参与记录/提交状态，只有页面拿得到，
 *    见 lib/record-state.ts）。本组件只把"用户按了哪个动作"报出去，流程由宿主编排
 *    （弹录音面板 / 漏读粗筛 / 能量面板 / 出分面板 —— 见 particip-flow 的说明）。
 *
 * ⚠️ 配色：**不写任何色值**，由宿主通过 `--btn-bg` / `--btn-fg` 声明
 *    （prd §7.2：卡内按钮 = `--btn-bg` 取卡片前景色、`--btn-fg` 取卡片背景色）。
 */
import { formatScore } from '@jushuo/shared'

Component({
  options: { virtualHost: true },

  properties: {
    /** try | retry | recoded | checking | scored（见 lib/record-state.ts） */
    state: { type: String, value: 'try' },
    /** 要显示的分数（`retry` = 战绩、`scored` = 这一把）；< 0 表示没有 */
    score: { type: Number, value: -1 },
    /** 我那一段录音的时长（毫秒）—— 试听那一格显示成 00:33 */
    durationMs: { type: Number, value: 0 },
  },

  data: {
    /**
     * ⭐ **画出来的那个分数文本**（1 位小数）。
     *
     * ⚠️⚠️ 不许在 wxml 里直接画 `{{score}}`：那个值来自"数字动画"的中间帧，
     *    浮点会原样显示（`79.43333333`）—— 用户 2026-10-15 当场看到的就是这个。
     *    ⇒ **显示这一层统一走 `formatScore`**（与全站同一个口径），
     *      不管上游给的是整数、浮点还是动画中间值，画出来永远是 1 位小数。
     * ⚠️ `score < 0` 是"没有分数"的哨兵（见 record-state.ts）⇒ 画空，**不是** -1.0。
     */
    scoreText: '',
    /** 00:33 */
    durationText: '00:00',
  },

  observers: {
    /** ⭐ 分数一变就重算显示文本（见 data.scoreText 的说明） */
    score() {
      const v = Number(this.data.score)
      this.setData({ scoreText: v < 0 || !Number.isFinite(v) ? '' : formatScore(v) })
    },

    durationMs(v: number) {
      const total = Math.max(0, Math.floor((v || 0) / 1000))
      const m = Math.floor(total / 60)
      const s = total % 60
      this.setData({ durationText: (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s })
    },
  },

  methods: {
    /** ⭐ `try` 整颗胶囊 / `retry` 那颗圆钮 —— 宿主据此**弹 recorder 全屏面板** */
    /**
     * ⭐ 点「波形 + 分数」—— **进这一句的竞技档案**（`pages/participation?id=`）。
     * ⚠️ 组件不自己跳页（它不知道 participationId，那是服务端派生的地址）——
     *    只把"用户点了战绩"这件事报上去，由宿主去拿 id 并导航（与 mic/redo/confirm 同一套）。
     */
    onOpenRecord() {
      this.triggerEvent('record')
    },

    onMic() {
      this.triggerEvent('mic')
    },
    /** `recoded` / `checking` / `scored` 的左端 ↺ —— 重录（⚠️ 会丢掉当前那段未提交的录音） */
    onRedo() {
      this.triggerEvent('redo')
    },
    /** `recoded` 的 ✓ —— 宿主编排「漏读粗筛 → energy-tips → 提交」 */
    onConfirm() {
      this.triggerEvent('confirm')
    },
    /** `scored` 右端的「分数 ›」—— 宿主**再开一次出分面板**（可反复，直到确认） */
    onPanel() {
      this.triggerEvent('panel')
    },
    /** 试听我那一段（三态共用的中间那格） */
    onPlay() {
      this.triggerEvent('play')
    },
  },
})
