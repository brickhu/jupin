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
 * ⚠️ 麦克风权限：真机上第一次会弹授权；拒绝过之后不再弹（要引导去设置里开）。
 */

import { missingWordsOf, plainWordsOf } from '@jushuo/shared'

import { ASR_LANG, isAsrAvailable, startRecognize, stopRecognize } from '../../../lib/audio/asr'
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
    error: '',
    /** 识别文本 */
    text: '',
    /** ⭐ 关键延迟：用户说完 → 出文本 */
    finalizeMs: null as number | null,
    totalMs: null as number | null,
    recordMs: null as number | null,
    words: [] as WordView[],
    missingWords: [] as string[],
  },

  onLoad() {
    this.setData({ navTop: navPadTop(), available: isAsrAvailable() })
  },

  onInput(e: { detail: { value: string } }) {
    this.setData({ sentence: e.detail.value })
  },

  /** 开始 / 说完 —— 一个按钮两个态（探针不追求好看，追求少一步操作） */
  async onToggle() {
    if (this.data.waiting) return

    if (!this.data.recording) {
      this.setData({ recording: true, waiting: false, error: '', text: '', finalizeMs: null, totalMs: null, recordMs: null, words: [], missingWords: [] })
      try {
        const p = startRecognize()
        // ⚠️ 不 await 在这里 —— start 的 promise 要等 onStop 才 resolve，
        //    现在 await 会把按钮卡住，用户就点不了「说完了」
        p.then((r) => {
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
        }).catch((e: Error) => {
          this.setData({ recording: false, waiting: false, error: e.message })
        })
      } catch (e) {
        this.setData({ recording: false, error: e instanceof Error ? e.message : String(e) })
      }
      return
    }

    // 说完了
    this.setData({ waiting: true })
    stopRecognize()
  },

  onReset() {
    this.setData({
      recording: false,
      waiting: false,
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
