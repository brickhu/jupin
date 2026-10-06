/**
 * ⭐ **B41 探针页** —— 一次性回答两个问题：微信同声传译插件的**英文识别质量**与**延迟**。
 *
 * ⚠️ 这是一个**探针**，不是产品功能：B41 收尾后应当整页删掉（连同 app.json 里那一行）。
 *    它不碰任何接口、不写库、不发能量 —— 只调插件然后把原始结果摊在屏幕上。
 *
 * ⚠️⚠️ 为什么必须真机：插件只能在微信端上跑（`requirePlugin` 是引擎注入的），
 *    Node / vitest 里都没有。而这个页面的两个判据也只能在真机上得到真值：
 *
 *    · **质量**：默认句子特意选了 `…but not simpler.` —— B40 里讯飞 IAT 把它听成
 *      `similar` / `as simple` / `by the seminar`。**看插件会不会犯同样的错。**
 *    · **延迟**：看的数是 `finalizeMs`（用户点「说完了」→ 出文本），
 *      判据 **≤1s**。⚠️ 不要看 `totalMs` —— 那里面混着用户朗读的时间。
 *
 * ⚠️ 第一版没有超时、还静默吞掉了 `stop()` 的错 ⇒ 页面上永远停在"正在出结果"。
 *    现在：**每一个插件事件都摊在屏幕上**（事件流），并且有两条超时兜底。
 *    再卡住时，看事件流停在哪一步就知道是谁的问题。
 */

import { missingWordsOf, plainWordsOf } from '@jushuo/shared'

import {
  ASR_LANG,
  describeAsrEvent,
  ensureMicPermission,
  isAsrAvailable,
  resetRecognize,
  setAsrEventSink,
  startRecognize,
  stopRecognize,
  type AsrEvent,
} from '../../../lib/audio/asr'
import { navPadTop } from '../../../lib/nav'

/** ⚠️ 默认句刻意选 B40 里 ASR 出过错的那一句 —— 探针要能暴露问题，不是走过场 */
const DEFAULT_SENTENCE = 'Everything should be made as simple as possible, but not simpler.'

interface WordView {
  text: string
  /** 判据认定「没读到」 */
  missing: boolean
}

Page({
  data: {
    navTop: 0,
    sentence: DEFAULT_SENTENCE,
    lang: ASR_LANG,
    available: true,
    recording: false,
    /** 正在等结果（点了「说完了」之后） */
    waiting: false,
    /** 插件回了 onStart —— 真在录了 */
    liveStarted: false,
    /** 录音计时（秒）—— 让"到底在不在录"一眼可见 */
    recSec: 0,
    error: '',
    /** 识别文本 */
    text: '',
    /** ⭐ 关键延迟：用户说完 → 出文本 */
    finalizeMs: null as number | null,
    totalMs: null as number | null,
    recordMs: null as number | null,
    words: [] as WordView[],
    missingWords: [] as string[],
    /** 插件事件流（最近 12 条）—— 卡住时看它停在哪 */
    events: [] as string[],
  },

  /** 录音计时器 —— 放实例上，不放 data（data 要可序列化） */
  _tick: null as ReturnType<typeof setInterval> | null,

  onLoad() {
    setAsrEventSink((e) => this.pushEvent(e))
    this.setData({ navTop: navPadTop(), available: isAsrAvailable() })
  },

  onUnload() {
    setAsrEventSink(null)
    this.stopTick()
    resetRecognize()
  },

  pushEvent(e: AsrEvent) {
    const line = `${new Date(e.at).toLocaleTimeString()} ${e.kind} ${describeAsrEvent(e)}`
    const events = [line, ...this.data.events].slice(0, 12)
    // ⚠️ plugin-start 是"真的开始录了"的唯一凭据，用它点亮状态
    if (e.kind === 'plugin-start') this.setData({ liveStarted: true })
    this.setData({ events })
  },

  startTick() {
    this.stopTick()
    this.setData({ recSec: 0 })
    this._tick = setInterval(() => this.setData({ recSec: this.data.recSec + 1 }), 1000)
  },

  stopTick() {
    if (this._tick) {
      clearInterval(this._tick)
      this._tick = null
    }
  },

  onInput(e: { detail: { value: string } }) {
    this.setData({ sentence: e.detail.value })
  },

  /** 开始 / 说完 —— 一个按钮两个态（探针不追求好看，追求少一步操作） */
  async onToggle() {
    if (this.data.waiting) return

    if (!this.data.recording) {
      this.setData({
        recording: true,
        waiting: false,
        liveStarted: false,
        recSec: 0,
        error: '',
        text: '',
        finalizeMs: null,
        totalMs: null,
        recordMs: null,
        words: [],
        missingWords: [],
      })
      // ⚠️ 先要权限：插件失败时可能一条回调都不给，那样页面上只会看到一个转不完的圈
      try {
        await ensureMicPermission()
      } catch (e) {
        this.setData({ recording: false, error: e instanceof Error ? e.message : String(e) })
        return
      }
      this.startTick()
      startRecognize()
        .then((r) => {
          const ref = plainWordsOf(this.data.sentence)
          const hyp = r.text.trim() === '' ? [] : r.text.trim().split(/\s+/)
          // ⭐ 判据：只报「缺位」—— 替换（读错）不算，见 shared/word-align.ts 的说明
          const missIdx = missingWordsOf(this.data.sentence, hyp)
          const missSet = new Set(missIdx)
          this.setData({
            recording: false,
            waiting: false,
            text: r.text,
            finalizeMs: r.finalizeMs,
            totalMs: r.totalMs,
            recordMs: r.recordMs,
            words: ref.map((w, i) => ({ text: w, missing: missSet.has(i) })),
            missingWords: missIdx.map((i) => ref[i] ?? ''),
          })
        })
        .catch((e: Error) => {
          this.setData({ recording: false, waiting: false, error: e.message })
        })
        .finally(() => this.stopTick())
      return
    }

    // 说完了
    this.setData({ waiting: true })
    stopRecognize()
  },

  onReset() {
    resetRecognize()
    this.stopTick()
    this.setData({
      recording: false,
      waiting: false,
      liveStarted: false,
      recSec: 0,
      error: '',
      text: '',
      finalizeMs: null,
      totalMs: null,
      recordMs: null,
      words: [],
      missingWords: [],
    })
  },
})
