import { decodeFrameToSamples } from '../../lib/audio/frame-decode'
import { playBeep, playDing, stopAudio, stopCues } from '../../lib/audio/play'
import { createSpeechSession, type SpeechResult, type SpeechSession } from '../../lib/audio/speech-session'
import { WAVE_GAIN_ZERO, advanceWaveGain, applyWaveGain, peakBars } from '../../lib/audio/wave'
import {
  VAD_STATE_ZERO,
  advancePeakRms,
  advanceVad,
  autoStopAfter,
  classifyChunk,
  rmsOf,
  silenceThresholdOf,
} from '../../lib/audio/vad'
import type { VadState } from '../../lib/audio/vad'

/**
 * ⭐⭐ **recorder —— 全屏录音面板**（prd §7.2，用户 2026-10 定）。
 *
 * ## 它是**独立组件**，首页与详情页共用
 *
 * ⚠️ 与 `btn-record` 同一个理由：两处都要弹它，各写一份必然长歪。
 *    ⭐ 所以**录音管线整条搬进这里**（会话说、帧解码、canvas 波形、静音自停、定稿窗口）——
 *    迁的是**管线**，不是 canvas 节点，所以不存在"canvas 跨组件交接"的问题。
 *
 * ## 它只负责「录出一段音频」，别的什么都不做
 *
 * 打开即录 ⇒ 结束（手动 `■` / **读完静音自停**）⇒ 关面板 + 把录音交给宿主
 * （`done` 事件带 `audioPath` / `durationMs`）。
 * ⚠️⚠️ **结束 ≠ 提交**：宿主拿到这一段之后进 `recoded`，
 *    **提交是 `recoded` 上那颗 ✓**（prd §7.2）。
 *
 * ## ⚠️⚠️ 下面这些是踩出来的，一条都不许退回去
 *
 * 1. **开始录音前必须把正在响的声音全停掉**（标准音 / 逐词 / 试听 + 提示音两套播放器）。
 *    理由不只是"别吵"：**麦克风就在旁边，正在响的声音会被原样录进去** ——
 *    标准音还在播就会把标准音录进去（转写全对、用户却没出声）。
 *    ⚠️ 顺序是**唯一正确的那一种**：先 `stopAllAudio()` → 再 `playBeep()` → 最后开麦克风。
 *    反过来（外面先嘟、进来又 stop）会把刚响的"嘟"杀掉 —— 安卓上尤其明显（起播慢）。
 * 2. **帧只用解码这一条路**（`decodeFrameToSamples`）。
 *    ⚠️ 曾经按"运行时嗅探帧格式"分过两条路，而 `sniffAudioContainer` 的**兜底值是 raw-pcm**、
 *    mp3 帧又没有容器头 ⇒ 被当成 16bit PCM 硬读 ⇒ **VAD 拿到的是垃圾 ⇒ 读完不停**。
 *    `RECORD_SPEC.format` 就是 mp3，所以帧一定是 mp3 分片。
 * 3. **静音自停的阈值要跟着"见过的最大 RMS"走**，不能写死：
 *    低增益真机上固定阈值会把每一帧都判成静音 ⇒ `voicedMs` 永不增长 ⇒ 读完不停。
 * 4. **波形要按"见过的最强音"放大**（人声峰值通常只到满量程的 0.2~0.5）；
 *    但**增益只用在画波形上** —— 喂 VAD 的必须是原始采样。
 * 5. **拿不到能解码的帧时只留一条中线**，绝不摆一条不动的假波形（那比没有更糟）。
 * 6. **`stopSent` 防重入**：满足自动结束条件之后每一帧都会再判一次，不拦就会连发好几次 stop。
 * 7. **定稿窗口**（`finishing`）：说了停、还在等录音器回调的那段时间，
 *    按钮**必须 disabled** —— "看起来能按、按了没反应"比直接变灰糟得多。
 *    它的清除点只有三个：定稿 / 出错 / 3 秒看门狗超时。
 * 8. **30 秒硬上限兜底**：静音判据里有一条"解不出来就当他还在说话"，
 *    环境噪音大时意味着**永远不会自动结束**。
 */
const MAX_RECORD_MS = 30_000
const WAVE_PREPARE_TRIES = 3
const WAVE_MAX_BARS = 64
const WAVE_COLOR = '#4f46e5'
const FRAME_MS_FALLBACK = 170
/** 说了停之后等录音器回调的上限 —— 超了就当这一轮失败 */
const STOP_WATCHDOG_MS = 3000

/** canvas 2d 上下文（只声明我们真调的那几个方法） */
interface WaveCtx {
  scale(x: number, y: number): void
  clearRect(x: number, y: number, w: number, h: number): void
  fillRect(x: number, y: number, w: number, h: number): void
  fillStyle: string
}

/** 每帧都变、又不该走 setData 的那些东西 */
interface Scratch {
  session: SpeechSession | null
  /** ⚠️ "停已经发出去了" —— 只进不出，用来防重入 */
  stopSent: boolean
  startedAt: number
  lastFrameAt: number
  /** 见过的最强 RMS（静音阈值跟着它走） */
  peakRms: number
  vad: VadState
  waveGain: { peak: number }
  waveCanvas: WechatMiniprogram.Canvas | null
  waveCtx: WaveCtx | null
  waveW: number
  waveH: number
  waveTries: number
  tickTimer: ReturnType<typeof setInterval> | null
  recordTimeout: ReturnType<typeof setTimeout> | null
  stopWatchdog: ReturnType<typeof setTimeout> | null
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

Component({
  properties: {
    /** 打开即录：宿主把它置 true 就是"弹面板并开始" */
    visible: { type: Boolean, value: false },
    /** 要朗读的句子（大字显示，用户看着念） */
    sentence: { type: String, value: '' },
    /** 标准音时长（毫秒）—— 静音自停的第一个条件 */
    stdDurationMs: { type: Number, value: 0 },
    /** 这句有几个词 —— 静音自停的第二个条件（⚠️ 为 0 时一律不自停） */
    wordCount: { type: Number, value: 0 },
    /** 开始前响一声"嘟"（⚠️ 只跟用户点击走，自动接续不响） */
    beep: { type: Boolean, value: true },
  },

  data: {
    /** 真的解出采样之后才画波形 —— 拿不到帧的环境不留一条空白横条 */
    waveOn: false,
    /** 已录时长（00:12） */
    elapsedText: '00:00',
    /** 定稿窗口：说了停、还在等回调 ⇒ 按钮 disabled */
    finishing: false,
    /** 面板入场过渡 */
    /**
     * ⚠️⚠️ **每帧都在变的内部状态** —— 放进 data 只是为了有个**类型明确的家**，
     *    实际一律**直接改字段、不调 setData**（每 170ms 一次 setData 会卡）。
     *    ⚠️ 也**不能**用自定义实例字段：小程序的 TS 会因此把 methods 全推成可选，
     *       于是 `this.reset()` 这类调用报"可能为 undefined"。
     */
    scratch: {
      session: null,
      stopSent: false,
      startedAt: 0,
      lastFrameAt: 0,
      peakRms: 0,
      vad: { ...VAD_STATE_ZERO },
      waveGain: { ...WAVE_GAIN_ZERO },
      waveCanvas: null,
      waveCtx: null,
      waveW: 0,
      waveH: 0,
      waveTries: 0,
      tickTimer: null,
      recordTimeout: null,
      stopWatchdog: null,
    } as Scratch,
  },

  observers: {
    visible(v: boolean) {
      if (v) this.begin()
      else this.teardown()
    },
  },

  lifetimes: {
    detached() {
      this.teardown()
    },
  },

  methods: {
    // ── 生命周期 ───────────────────────────────────────────────
    begin() {
      /**
       * ⚠️⚠️ **先全停，再"嘟"，最后开麦** —— 顺序是唯一正确的那一种（见文件头第 1 条）。
       * ⚠️ 必须放在最前面（在 await 麦克风授权之前）：声音要在用户按下的**那一刻**就停，
       *    否则那几百毫秒还在往麦克风里灌。
       */
      this.stopAllAudio()
      if (this.data.beep) playBeep()

      this.reset()
      this.setData({ finishing: false, waveOn: false, elapsedText: '00:00' })

      const session = createSpeechSession({
        /** ⭐ 每来一帧：画波形 + 累计静音（一次解码两处用） */
        onFrame: (f) => void this.onFrame(f),
        /** 录音落地 ⇒ 交给宿主（⚠️ 不是提交） */
        onDone: (r) => this.onDone(r),
        onError: (e) => this.fail(e.message || '录音失败，请重试'),
      })
      this.data.scratch.session = session
      session.start()

      // ⭐ 计时显示（只影响"看得见"，不影响录音）
      this.data.scratch.tickTimer = setInterval(() => {
        this.setData({ elapsedText: mmss(Date.now() - this.data.scratch.startedAt) })
      }, 200)

      /**
       * ⚠️ 30 秒硬上限兜底（见文件头第 8 条）—— 只是兜底，
       *    正常情况下静音自停早就结束了。
       */
      this.data.scratch.recordTimeout = setTimeout(() => this.requestStop(), MAX_RECORD_MS)
    },

    teardown() {
      if (this.data.scratch.tickTimer !== null) {
        clearInterval(this.data.scratch.tickTimer)
        this.data.scratch.tickTimer = null
      }
      if (this.data.scratch.recordTimeout !== null) {
        clearTimeout(this.data.scratch.recordTimeout)
        this.data.scratch.recordTimeout = null
      }
      if (this.data.scratch.stopWatchdog !== null) {
        clearTimeout(this.data.scratch.stopWatchdog)
        this.data.scratch.stopWatchdog = null
      }
      /**
       * ⚠️ 用 `dispose()` 而不是 `stop()`：面板已经关了，再走一次 onDone
       *    会把一段用户没要的录音交给宿主（症状是"我没录完它却让我提交"）。
       */
      this.data.scratch.session?.dispose()
      this.data.scratch.session = null
      this.data.scratch.stopSent = false
      this.data.scratch.waveCtx = null
      this.data.scratch.waveCanvas = null
      this.setData({ waveOn: false })
    },

    reset() {
      this.data.scratch.stopSent = false
      this.data.scratch.startedAt = Date.now()
      this.data.scratch.lastFrameAt = 0
      this.data.scratch.peakRms = 0
      this.data.scratch.vad = { ...VAD_STATE_ZERO }
      this.data.scratch.waveGain = { ...WAVE_GAIN_ZERO }
      this.data.scratch.waveW = 0
      this.data.scratch.waveH = 0
      this.data.scratch.waveTries = 0
    },

    // ── 用户动作 ───────────────────────────────────────────────
    /** ⭐ 用户点了「结束」 */
    onStopTap() {
      if (this.data.finishing) return
      this.requestStop()
    },

    /**
     * ⭐ 三个"该结束了"（用户点击 / 静音自停 / 超时）都汇到这里 —— 只停一次。
     * ⚠️ 它**只负责跟会话说停**，不负责关掉定稿窗口：停止是**异步的**，
     *    要等录音器回调回来才算真的结束（清早了按钮会退回"还在录"的样子）。
     */
    requestStop() {
      if (this.data.scratch.stopSent) return
      this.data.scratch.stopSent = true
      /**
       * ⚠️ 一置 finishing 按钮就变灰 —— 用户点的那一下立刻有反馈，
       *    而且这段时间里他本来也不该再点。
       */
      this.setData({ finishing: true })
      if (this.data.scratch.recordTimeout !== null) {
        clearTimeout(this.data.scratch.recordTimeout)
        this.data.scratch.recordTimeout = null
      }
      this.data.scratch.session?.stop()

      /** 看门狗：3 秒还没等到回调就当这一轮失败（清除点见文件头第 7 条） */
      if (this.data.scratch.stopWatchdog !== null) clearTimeout(this.data.scratch.stopWatchdog)
      this.data.scratch.stopWatchdog = setTimeout(() => {
        this.data.scratch.stopWatchdog = null
        this.fail('录音没有正常结束，请重试')
      }, STOP_WATCHDOG_MS)
    },

    // ── 录音回调 ───────────────────────────────────────────────
    /** ⭐ 录音落地 —— **交给宿主，然后关面板**（⚠️ 结束 ≠ 提交） */
    onDone(r: SpeechResult) {
      /**
       * ⭐⭐ **"叮"要在这里响，不能在上一步（说"停"）就响**。
       *
       * ⚠️⚠️ 说"停"只是**发出请求**，麦克风这时**还在收**（要等录音器把文件落完才真的关）——
       *    在那之前响的任何声音都会被**原样录进用户这一段**的尾巴
       *    （真机上一听就是"我读完了，结尾还带一声叮"）。
       *    ⇒ 与开录前"先停掉所有声音再开麦"是同一条道理：**麦克风开着的时候不放任何声音**。
       *
       * ⚠️ 它仍然表达"**你按的那一下生效了**"——只是晚了几百毫秒（等文件落完）。
       */
      playDing()
      if (this.data.scratch.stopWatchdog !== null) {
        clearTimeout(this.data.scratch.stopWatchdog)
        this.data.scratch.stopWatchdog = null
      }
      if (this.data.scratch.tickTimer !== null) {
        clearInterval(this.data.scratch.tickTimer)
        this.data.scratch.tickTimer = null
      }
      this.data.scratch.session = null
      this.setData({ finishing: false })
      this.triggerEvent('done', { audioPath: r.audioPath, durationMs: r.durationMs })
    },

    /** 出错 ⇒ 面板关掉，把一句人话交给宿主去挂（不在这里画错误态） */
    fail(message: string) {
      this.teardown()
      this.triggerEvent('fail', { message })
    },

    /**
     * ⭐⭐ **每来一帧就做两件事**：画波形、累计静音（判"读完"）。
     *
     * ⚠️ 判"静音 / 有声音"用的是**音量能量**（RMS），不是识别 —— 见 lib/audio/vad.ts。
     * ⚠️ `classifyChunk` 拿不到采样时走 'undecodable'（当成他还在说话）——
     *    那是**安全方向**：绝不因为"读不出数据"就把用户的录音掐断。
     * ⚠️ **开发者工具里帧是 WebM/Opus，解不开** ⇒ 波形不画、静音不判。
     *    这不是 bug，是平台行为，**只能真机验**。
     */
    async onFrame(frame: ArrayBuffer) {
      const samples = await decodeFrameToSamples(frame)
      if (!this.data.scratch.session) return

      // ── ① 波形 ──────────────────────────────────────────────
      if (samples) {
        if (!this.data.waveOn) {
          this.setData({ waveOn: true })
          // ⚠️ 等这一帧把 canvas 渲染出来之后再去找它（同一帧里 query 不到）
          setTimeout(() => this.prepareWave(), 0)
        }
        this.drawWave(samples)
      }

      // ── ② 静音自停 ─────────────────────────────────────────
      /** ⚠️ 帧间隔**用手表量**，不用写死的 170ms：设备忙时帧会变稀 */
      const now = Date.now()
      const frameMs = this.data.scratch.lastFrameAt > 0 ? Math.min(1000, now - this.data.scratch.lastFrameAt) : FRAME_MS_FALLBACK
      this.data.scratch.lastFrameAt = now

      /** ⭐ 先更新"见过的最大 RMS"，再用它算阈值（见文件头第 3 条） */
      const rms = rmsOf(samples)
      this.data.scratch.peakRms = advancePeakRms(this.data.scratch.peakRms, rms)
      const kind = classifyChunk(samples, silenceThresholdOf(this.data.scratch.peakRms))
      this.data.scratch.vad = advanceVad(this.data.scratch.vad, kind, frameMs)

      /**
       * ⚠️ ⭐ `autoStopAfter` 的第一条是 `wordCount <= 0 ⇒ false`
       *    ⇒ **词表一空，自动结束就静默失效**（真实事故：那条文章的 words 是 []）。
       *    所以宿主必须**从正文兜底**把词数传进来（`plainWordsOf(text).length`）。
       */
      if (this.data.wordCount <= 0) return
      if (autoStopAfter({ ...this.data.scratch.vad, wordCount: this.data.wordCount, stdDurationMs: this.data.stdDurationMs })) {
        /** ⚠️ 必须防重入（见文件头第 6 条）—— 满足条件之后每一帧都会再判一次 */
        if (this.data.scratch.stopSent) return
        this.requestStop()
      }
    },

    // ── 波形 ───────────────────────────────────────────────────
    /** ⭐ 准备波形画布（2d canvas）—— 幂等，可以反复调 */
    prepareWave() {
      if (this.data.scratch.waveCtx) return
      this.createSelectorQuery()
        .select('#wave')
        .fields({ node: true, size: true })
        .exec((res) => {
          const info = res?.[0] as
            | { node?: WechatMiniprogram.Canvas; width?: number; height?: number }
            | undefined
          const node = info?.node
          const w = Math.round(info?.width ?? 0)
          const h = Math.round(info?.height ?? 0)
          /**
           * ⚠️ 尺寸**偶尔量到 0**（面板刚打开、布局还没完）⇒ 重试几次（老版本踩过）。
           */
          if (!node || w <= 0 || h <= 0) {
            if (this.data.scratch.waveTries++ < WAVE_PREPARE_TRIES) setTimeout(() => this.prepareWave(), 60)
            return
          }
          /** ⚠️ backing store 按 dpr 开、再 scale，否则高分屏上糊成一块 */
          const dpr = wx.getWindowInfo?.().pixelRatio || 2
          node.width = w * dpr
          node.height = h * dpr
          const ctx = node.getContext('2d') as unknown as WaveCtx
          ctx.scale(dpr, dpr)
          this.data.scratch.waveCanvas = node
          this.data.scratch.waveCtx = ctx
          this.data.scratch.waveW = w
          this.data.scratch.waveH = h
        })
    },

    /** ⭐ 把这一帧的采样画成柱子（**直接画在 canvas 上，不走 setData**） */
    drawWave(samples: Float32Array) {
      const ctx = this.data.scratch.waveCtx
      const w = this.data.scratch.waveW
      const h = this.data.scratch.waveH
      if (!ctx || w <= 0 || h <= 0) return

      const barCount = Math.max(8, Math.min(WAVE_MAX_BARS, Math.floor(w / 8)))
      const raw = peakBars(samples, barCount)
      if (raw.length === 0) return

      /** ⚠️ 增益**只在这里用** —— 喂给 VAD 的必须是原始采样（见文件头第 4 条） */
      this.data.scratch.waveGain = advanceWaveGain(this.data.scratch.waveGain, raw)
      const heights = applyWaveGain(raw, this.data.scratch.waveGain)

      const mid = h / 2
      const step = w / heights.length
      const barW = Math.max(1, step * 0.6)

      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = WAVE_COLOR
      for (let i = 0; i < heights.length; i++) {
        /** ⚠️ 留 1px 上下边距：柱子贴边会被裁掉半个像素，看起来像在抖 */
        const peak = Math.max(1, Math.min(mid - 1, (heights[i] ?? 0) * mid))
        ctx.fillRect(i * step, mid - peak, barW, peak * 2)
      }
    },

    /** ⭐ 两套播放器都停 —— 这才叫"全停"（`stopCues` 漏了的话提示音还在响） */
    stopAllAudio() {
      stopAudio()
      stopCues()
    },

    /** 遮罩/卡片吞掉点击（面板是模态的） */
    noop() {},
  },
})
