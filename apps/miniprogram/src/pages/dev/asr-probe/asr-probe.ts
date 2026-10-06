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

import { missingWordsOf, plainWordsOf, sniffAudioContainer } from '@jushuo/shared'

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
    /** ⭐ 运行环境：devtools = 微信开发者工具 —— **插件在那里录不了音**（裸录音器却可以） */
    platform: '',
    isDevtools: false,
    /** ⭐ 裸录音器自检结果 —— 绕开插件，直接看麦克风出不出帧 */
    micCheck: '',
    /**
     * ⭐⭐ **插件录音时，我们的帧回调还会不会来？**（决定"用插件录音还能不能保住实时波形"）
     *
     * 依据：`lib/audio/recorder.ts` 是把 `onFrameRecorded` 挂在**全局单例录音器**上的。
     *      如果插件 `start()` 内部用的就是那个单例，插件录音时**我们的回调会照样收到帧**。
     * ⚠️ 但帧回调只对 `format: 'PCM' | 'mp3'` 触发 —— 插件用什么格式我们控制不了，
     *    所以**收不到帧有两种可能**（换了录音器 / 格式不支持帧），
     *    对产品而言结论一样：**用插件录音就没有波形**。
     */
    frameCount: 0,
    frameBytes: 0,
    /** 第一帧的容器类型（用仓库自己的 sniffAudioContainer 判，不另写一份） */
    frameContainer: '',
    /** 第一帧到达的时刻（相对 startRecognize），null = 一帧都没来 */
    frameAtMs: null as number | null,
  },

  /** 裸录音器（与插件用的是同一个全局单例，只是这里我们直接驱动它） */
  _mic: null as WechatMiniprogram.RecorderManager | null,

  /** 帧计数器 —— 放实例上，避免每帧都 setData（帧回调很密） */
  _frameN: 0,
  _frameBytes: 0,
  /** 这一轮 startRecognize 的时刻 —— 用来算"第一帧什么时候来" */
  _recStartedAt: 0,

  /** 录音计时器 —— 放实例上，不放 data（data 要可序列化） */
  _tick: null as ReturnType<typeof setInterval> | null,

  onLoad() {
    setAsrEventSink((e) => this.pushEvent(e))
    /**
     * ⭐⭐ 让页面**自己报出它在哪跑**：`devtools` = 微信开发者工具。
     *    ⚠️ 实测：真机识别正常；开发者工具里**裸录音器能出帧、插件报 -30003** ——
     *    所以这一行能直接判掉一大类误判，不用靠人回忆"我是在哪点的"。
     */
    let platform = 'unknown'
    try {
      // ⚠️ 新 API 优先（getSystemInfoSync 已不推荐），拿不到再退回旧的
      const info = (
        typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : wx.getSystemInfoSync()
      ) as { platform?: string }
      platform = String(info?.platform ?? 'unknown')
    } catch {
      /* 拿不到就保持 unknown —— 不因为这个挡住探针 */
    }
    this.setData({ navTop: navPadTop(), available: isAsrAvailable(), platform, isDevtools: platform === 'devtools' })

    /**
     * ⭐⭐ **本页的核心测量之一**：在全局单例录音器上挂帧回调，
     *    然后**只调插件**去录音 —— 看帧会不会照样来。
     *    ⚠️ 必须挂在插件 start() 之前；而且它没有 off*，挂上就摘不掉（探针页可接受）。
     */
    try {
      wx.getRecorderManager().onFrameRecorded((res) => {
        const n = res?.frameBuffer?.byteLength ?? 0
        this._frameN++
        this._frameBytes += n
        this.setData({
          frameCount: this._frameN,
          frameBytes: this._frameBytes,
          // 只在第一帧时判容器（每帧都判是白费）
          ...(this._frameN === 1
            ? {
                frameContainer: sniffAudioContainer(new Uint8Array(res.frameBuffer)),
                frameAtMs: Date.now() - this._recStartedAt,
              }
            : {}),
        })
      })
    } catch {
      /* 挂不上就是没有帧能力 —— 探针照常跑 */
    }
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
      // ⭐ 每一轮都重置帧计数 —— 这一页要回答的就是"插件录音时帧来不来"
      this._frameN = 0
      this._frameBytes = 0
      this._recStartedAt = Date.now()
      this.setData({
        recording: true,
        waiting: false,
        liveStarted: false,
        recSec: 0,
        frameCount: 0,
        frameBytes: 0,
        frameContainer: '',
        frameAtMs: null,
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

  /**
   * ⭐⭐ **裸录音器自检** —— 绕开插件，直接用 `wx.getRecorderManager()` 录 3 秒，
   *    数一数到底有没有拿到音频帧。
   *
   *    这是把责任分开的那个实验：
   *      · 裸录音器**也**拿不到帧  ⇒ 环境问题（系统麦克风权限 / 设备被占）
   *      · 裸录音器**能**拿到帧、只有插件不行 ⇒ 插件的问题
   *
   * ⚠️ 用的是**同一个全局单例**（`wx.getRecorderManager()` 返回的一直是它），
   *    而且它没有 `off*`，监听挂了摘不掉 —— 所以本轮**不允许和插件识别同时跑**。
   *    探针页是一次性的，这个副作用可接受。
   */
  onMicCheck() {
    if (this.data.recording) {
      this.setData({ micCheck: '插件识别正在进行中 —— 先等它结束（两者共用同一个录音器）' })
      return
    }
    if (this._mic) {
      this.setData({ micCheck: '已经跑过一次了（监听摘不掉）。重新编译这一页再跑。' })
      return
    }

    let frames = 0
    let bytes = 0
    let firstFrameMs: number | null = null
    const startedAt = Date.now()
    const rm = wx.getRecorderManager()
    this._mic = rm
    this.setData({ micCheck: '录音中… 请对着手机说话（3 秒）' })

    rm.onFrameRecorded((res) => {
      frames++
      bytes += res.frameBuffer.byteLength
      if (firstFrameMs === null) firstFrameMs = Date.now() - startedAt
    })
    rm.onStop(() => {
      const ok = frames > 0
      this.setData({
        micCheck:
          `裸录音器：${frames} 帧 / ${bytes} 字节 · 首帧 ${firstFrameMs === null ? '—' : firstFrameMs + 'ms'} · ` +
          (ok
            ? '✅ 麦克风出帧正常 ⇒ 问题在插件那边'
            : '❌ 一帧都没拿到 ⇒ 是环境问题（系统麦克风权限 / 设备被占）'),
      })
    })
    rm.onError((e) => {
      this.setData({ micCheck: '裸录音器报错：' + JSON.stringify(e) })
    })

    try {
      rm.start({
        duration: 3000,
        sampleRate: 16000,
        numberOfChannels: 1,
        // ⚠️ 只有 pcm / mp3 支持 onFrameRecorded（官方文档）；这里要的就是帧
        format: 'PCM',
        frameSize: 1,
      })
    } catch (e) {
      this.setData({ micCheck: '裸录音器起不来：' + (e instanceof Error ? e.message : String(e)) })
    }
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
