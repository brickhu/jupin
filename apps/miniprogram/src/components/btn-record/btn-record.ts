import type { RecordState } from '../../lib/record-state'

/**
 * ⭐⭐ **参与区（btn-record）** —— 一个句子上的「参与」控件，**五个状态**（prd §7.2）。
 *
 * ⚠️⚠️ 为什么必须是一个组件：它要在**两个地方共用**（用户 2026-10 定）——
 *    · 首页今日挑战那张 `lg` 卡（原地参与）
 *    · **详情页**（`sm` 卡点进来之后，在同一句话上参与）
 *    各写一份的后果是这两处的状态、尺寸、文案会慢慢长歪，而它们说的是同一件事。
 *
 * ⚠️ **卡片与详情页都不认识录音/面板**：本组件只把"用户按了哪个动作"报出去
 *    （`mic` / `redo` / `confirm` / `panel`），**流程由宿主页面编排**
 *    （弹 recorder → 漏读粗筛 → energy-tips → 提交轮询 → 出分面板）。
 *    这样"同一套流程"只需要实现一次（两个宿主共用同一份编排）。
 *
 * ⚠️ 状态**不由本组件计算** —— 它来自"端侧那段没提交的录音" + "服务端参与记录/提交状态"
 *    两个不同的地方，只有页面拿得到（见 lib/record-state.ts 的说明）。
 *
 * ⚠️ 配色：**不写任何色值**，由宿主的卡片/页面通过 `--btn-bg` / `--btn-fg` 声明
 *    （prd §7.2：卡内按钮 = `--btn-bg` 取卡片前景色、`--btn-fg` 取卡片背景色）。
 */
Component({
  options: { virtualHost: true },

  properties: {
    /** try | retry | recoded | checking | scored（见 lib/record-state.ts） */
    state: { type: String, value: 'try' as RecordState },
    /** 要显示的分数（`retry` = 战绩、`scored` = 这一把）；< 0 表示没有 */
    score: { type: Number, value: -1 },
    /** 我那一段录音的时长（毫秒）—— 试听那一格显示成 00:33 */
    durationMs: { type: Number, value: 0 },
    /** 标准音信息（试听要用）—— 与 audio-button 的入参一致 */
    audio: { type: Object, value: null },
    /** 我这把录音是不是正在播 */
    playing: { type: Boolean, value: false },
    /** 正在取音（还没出声）—— 试听钮显示 loading */
    loading: { type: Boolean, value: false },
    /** 卡片/页面的前景色 —— 只用于给 audio-button 上色（它不吃 --btn-*） */
    fill: { type: String, value: '' },
    ink: { type: String, value: '' },
  },

  methods: {
    /**
     * ⭐ `try` 整颗胶囊 / `retry` 那颗圆钮 —— 宿主据此**弹 recorder 全屏面板**。
     */
    onMic() {
      this.triggerEvent('mic')
    },
    /** `recoded` 的 ↺ —— 重录（语义同 onMic，但分开报：宿主可能想分别统计/区分） */
    onRedo() {
      this.triggerEvent('redo')
    },
    /** `recoded` 的 ✓ —— 宿主走「漏读粗筛 → energy-tips → 提交」 */
    onConfirm() {
      this.triggerEvent('confirm')
    },
    /** `scored` 的分数/› —— 宿主**再开一次出分面板**（可反复，直到确认） */
    onPanel() {
      this.triggerEvent('panel')
    },
    /** 试听我那一段 —— 透传 audio-button 的 play */
    onPlay() {
      this.triggerEvent('play', { audio: this.data.audio })
    },
  },
})
