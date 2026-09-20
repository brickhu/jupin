import {
  AUDIO_SPEC,
  detectPcmByteOrder,
  estimateSampleRateFromFrames,
  normalizePcmRate,
  type PcmByteOrder,
} from '@jushuo/shared'

/**
 * 录音适配层 —— 只做「收帧 → 归一化采样率 → 转发给 Worker」，不做任何算法。
 * ⚠️ 所有音频算法都在 @jushuo/shared/audio 里（纯函数，可在 Node 里单测）。
 */
/** 一段录完的音频 */
export interface RecordResult {
  /**
   * 合并后的裸 PCM（端侧分析 + 上传都给这一份）。
   * ⭐ **已经归一化到 AUDIO_SPEC.sampleRate（16kHz）** —— 调用方不必再关心设备采样率。
   */
  pcm: ArrayBuffer
  /**
   * ⭐ 录音落地的**本地临时文件路径** —— 上传对象存储必须要它。
   * ⚠️ 早先这里把 onStop 的参数丢了、只回传合并后的 PCM，
   *    结果「录完了但传不上去」——wx.cloud.uploadFile 只认 filePath，不认内存 buffer。
   */
  tempFilePath: string
  /** 录音时长（毫秒），用本地计时而非系统回调值 */
  durationMs: number
  /**
   * 录音文件大小，**单位是字节**。
   *
   * ⚠️⚠️ 官方文档写的是「fileSize 录音的文件大小，单位 KB」，**实测不是**：
   *    5 秒的录音回调给出 93384 —— 若真是 KB 那就是 91MB，显然不可能；
   *    按字节算约 91KB，与 WebM/Opus 的码率吻合（另一段 8.8 秒的是 143009 字节）。
   *    所以这里按**字节**取用，字段名也照实叫 fileSizeBytes。
   *    照文档当 KB 用会让所有关于文件大小的判断（比如"压缩比"）差 1024 倍，
   *    而它不会报错，只会安静地给出荒谬的数字。
   */
  fileSizeBytes: number
  /**
   * 设备**实际**采样率（归一化之前的估计值）。
   * ⚠️ 录音 API 的 sampleRate 只是请求值 —— 真机自检实测到过 8kHz（请求 16kHz 未生效）。
   *    暴露出来是为了让自检页能一眼看见「到底给了多少」。
   */
  sourceSampleRate: number
  /**
   * 设备给的是**大端**还是小端 16bit。
   *
   * ⚠️ 这个字段值得单独暴露：实测开发者工具给的是**大端**，
   *    而按小端读出来恰好是"满量程 + 过零率 0.5"，一度被误判成"工具给的是随机噪声"。
   *    见 detectPcmByteOrder 的注释。
   */
  sourceByteOrder: PcmByteOrder
}

/**
 * ⭐ 设备音频的**实况**，在探测完成后回一次。
 *
 * ⚠️ 为什么单独开一个回调：这两个数（采样率、字节率）是判断「喂给对齐器的音频对不对」
 *    的**唯一依据**，而它们只在录音开始后的前几帧才确定。
 *    没有它们，"跟随不准"就只能靠猜 —— 而"设备其实是 8k 被当 16k 用"
 *    会让整条时间轴差整整 2 倍，症状正是"完全不准确"。
 */
export interface RecorderInfo {
  /**
   * 反推出来的设备采样率。
   * ⚠️ **0 表示测不准** —— 那时按请求值放行、不做任何重采样（保守）。
   *    所以 0 本身就意味着"我们不知道设备给了什么"，这是要看的第一件事。
   */
  sourceRate: number
  byteOrder: PcmByteOrder
  /**
   * 由前几帧实测的字节率（B/s）。
   * ⭐ 16kHz / 16bit / 单声道 应当是 **32000** —— 这是不依赖"有没有说话"的硬判据。
   */
  bytesPerSec: number
  /** 用了几帧得出结论 */
  frames: number
}

export interface RecorderCallbacks {
  /** ⚠️ 回调拿到的帧**已经归一化到 16kHz**，Worker 侧无需再做任何换算 */
  onFrame?: (pcm: ArrayBuffer) => void
  /** 设备音频实况（探测完成后回一次）—— 见 RecorderInfo */
  onInfo?: (info: RecorderInfo) => void
  onStop?: (result: RecordResult) => void
  onError?: (err: Error) => void
}

/**
 * 采样率探测需要至少 2 帧：只有一帧时，我们不知道这一帧跨了多少毫秒，
 * 就算不出「字节/毫秒」。所以前两帧先攒着，测出来再一起补发。
 */
const PRIMING_FRAMES = 2

/**
 * ⚠️⚠️ 探测的**硬上限**。攒到这个帧数还测不准，就必须放弃、按请求值放行。
 *
 *    没有这个上限会造成一个很隐蔽的故障：`acceptFrame` 会一直攒、一直 return，
 *    **一帧都不往下发** —— 实时反馈全死、合并后的 PCM 是空的、试听也是空的，
 *    而界面上看起来只是"没有反应"，完全联想不到采样率。
 *
 *    实测：真机的字节率反推出来是 4256 / 9343 这类**不在任何合法档位上**的值，
 *    于是"测不准"是常态而不是例外 —— 必须有退出条件。
 *    4 帧 ≈ 0.5 秒，是"多等一会儿"和"别卡住"之间的折中。
 */
const PRIMING_MAX_FRAMES = 4

export class Recorder {
  /** 已归一化的帧（合并后就是上传用的 PCM） */
  private chunks: ArrayBuffer[] = []
  private startedAt = 0
  private manager = wx.getRecorderManager()
  private wired = false

  /**
   * 探测采样率期间暂存的原始帧。
   * ⚠️ 必须连**到达时刻**一起存 —— 采样率是「字节数 ÷ 时间跨度」，
   *    而跨度是首末时刻之差，分子不能含第一帧（见 estimateSampleRateFromFrames）。
   */
  private priming: { buf: ArrayBuffer; t: number }[] = []
  /** 探测到的设备采样率；0 表示还没测出来 */
  private sourceRate = 0
  /** 探测到的字节序 —— 见 detectPcmByteOrder 的注释（这个坑把"字节序反了"误判成了"噪声"） */
  private byteOrder: PcmByteOrder = 'le'
  /** 设备实况只回一次 */
  private infoReported = false

  constructor(private readonly cb: RecorderCallbacks = {}) {}

  private wire(): void {
    if (this.wired) return
    this.wired = true

    // ⭐ 实时 PCM 帧：端侧分析的数据源
    this.manager.onFrameRecorded((res) => this.acceptFrame(res.frameBuffer))

    this.manager.onStop((res) => {
      const durationMs = Date.now() - this.startedAt
      // ⚠️ 帧数不足（极短录音 / 设备干脆不回帧）时，用「总字节数 ÷ 录音时长」兜底；
      //    若连兜底都测不准，就保持请求值 —— 也就是不做重采样，回到改动前的行为。
      this.flushPriming()
      this.sourceRate ||= AUDIO_SPEC.sampleRate

      const total = this.chunks.reduce((n, b) => n + b.byteLength, 0)
      const merged = new Uint8Array(total)
      let off = 0
      for (const b of this.chunks) {
        merged.set(new Uint8Array(b), off)
        off += b.byteLength
      }
      this.cb.onStop?.({
        pcm: merged.buffer,
        tempFilePath: res.tempFilePath,
        durationMs,
        fileSizeBytes: res.fileSize ?? 0,
        sourceSampleRate: this.sourceRate,
        sourceByteOrder: this.byteOrder,
      })
      this.chunks = []
      this.priming = []
      this.sourceRate = 0
    })

    this.manager.onError((err) => this.cb.onError?.(new Error(err.errMsg)))
  }

  /**
   * 收一帧：先在头两帧里测出设备真实采样率，之后逐帧归一化到 16kHz。
   *
   * ⭐ 为什么必须在**入口**就归一化：下游（VAD 计时、基频、上传给讯飞）
   *    全都按 16kHz 硬编码。在入口转一次，整条链路就不用再知道设备给了什么。
   */
  private acceptFrame(buf: ArrayBuffer): void {
    if (this.sourceRate === 0) {
      this.priming.push({ buf, t: Date.now() })
      if (this.priming.length < PRIMING_FRAMES) return
      if (this.detectRate()) {
        this.flushPriming()
        return
      }
      // ⚠️ 还没到上限就再等等；到了上限必须放行 —— 见 PRIMING_MAX_FRAMES 的注释
      if (this.priming.length < PRIMING_MAX_FRAMES) return
      this.sourceRate = AUDIO_SPEC.sampleRate
      this.flushPriming()
      return
    }
    this.emit(buf)
  }

  /**
   * 反推采样率 + 判定字节序。
   *
   * ⚠️ 只在**攒够 PRIMING_MAX_FRAMES 帧之前**被调用，所以这里的入参永远只有几帧 ——
   *    绝不要让它去扫一个不断增长的数组：那是 O(n²)，
   *    而且会掩盖"其实早就该放弃"这件事。
   */
  private detectRate(): boolean {
    const frames = this.priming
    if (frames.length < 2) return false

    // ⭐ 顺手定字节序：设备不会中途换，两帧（4~8KB）足够判断
    const total = frames.reduce((n, f) => n + f.buf.byteLength, 0)
    const merged = new Uint8Array(total)
    let off = 0
    for (const f of frames) {
      merged.set(new Uint8Array(f.buf), off)
      off += f.buf.byteLength
    }
    this.byteOrder = detectPcmByteOrder(merged)

    /**
     * ⚠️⚠️ 采样率**只能**用 estimateSampleRateFromFrames 算，别在这里手搓 ——
     *    它里面那个「分子不含第一帧」的细节是一个真实毁掉过真机录音的坑：
     *    含第一帧会把 16kHz 算成 32kHz，于是音频被重采样成一半长，
     *    试听快一倍、高一个八度，听起来根本不像本人。
     *    详见 packages/shared/src/audio/resample.ts 的注释与 sample-rate.test.ts。
     */
    const rate = estimateSampleRateFromFrames(
      frames.map((f) => ({ bytes: f.buf.byteLength, t: f.t })),
      AUDIO_SPEC.channels,
      AUDIO_SPEC.bitDepth,
    )
    if (rate === 0) return false
    this.sourceRate = rate
    return true
  }

  /**
   * 把暂存帧按测出的采样率归一化后补发。
   *
   * ⚠️ sourceRate 为 0（测不准）时保持请求值 —— 等价于**不做任何重采样**，
   *    也就是回到引入归一化之前的行为。宁可不动数据，也不要按一个瞎猜的比例毁掉音频。
   */
  private flushPriming(): void {
    if (this.priming.length === 0) return
    this.sourceRate ||= AUDIO_SPEC.sampleRate
    this.reportInfo() // ⚠️ 必须在清空 priming 之前
    for (const f of this.priming) this.emit(f.buf)
    this.priming = []
  }

  /**
   * 把设备实况回给上层 —— 只回一次。
   *
   * ⚠️ 字节率用的是**第 2 帧起**的字节数除以首末时刻之差，
   *    与 estimateSampleRateFromFrames 同一口径（分子不能含第一帧）。
   */
  private reportInfo(): void {
    if (this.infoReported) return
    this.infoReported = true

    const frames = this.priming
    let bytesPerSec = 0
    if (frames.length >= 2) {
      const first = frames[0] as { buf: ArrayBuffer; t: number }
      const last = frames[frames.length - 1] as { buf: ArrayBuffer; t: number }
      const spanMs = last.t - first.t
      const payload = frames.slice(1).reduce((n, f) => n + f.buf.byteLength, 0)
      if (spanMs > 0) bytesPerSec = Math.round((payload / spanMs) * 1000)
    }

    this.cb.onInfo?.({
      sourceRate: this.sourceRate,
      byteOrder: this.byteOrder,
      bytesPerSec,
      frames: frames.length,
    })
  }

  private emit(buf: ArrayBuffer): void {
    // ⚠️ 恒等变换只在「采样率一致 **且** 字节序本来就是小端」时成立 ——
    //    大端设备必须走一遍转换，把数据归一化成小端（下游一律按小端处理）
    const identity = this.sourceRate === AUDIO_SPEC.sampleRate && this.byteOrder === 'le'
    const out = identity
      ? buf
      : (normalizePcmRate(
          new Uint8Array(buf),
          this.sourceRate,
          AUDIO_SPEC.sampleRate,
          this.byteOrder,
        ).buffer as ArrayBuffer)
    this.chunks.push(out)
    this.cb.onFrame?.(out)
  }

  /**
   * @param opts.frameSizeKb 覆盖 frameSize（真机自检的扫描测试用）。
   *        ⚠️ frameSize 只是**请求值**，设备可能不严格采纳 —— 见 AUDIO_SPEC 的注释。
   * @param opts.format 覆盖录音格式（**仅自检用**）。
   *        ⚠️ 正式链路必须用 PCM：讯飞要裸 PCM，且端侧实时分析也要原始帧。
   *        开放它只是为了回答一个问题 —— **mp3 模式下 onFrameRecorded 给的帧
   *        到底是压缩块还是原始 PCM**。若是 PCM，整条存储方案都能简化。
   */
  start(opts: { frameSizeKb?: number; format?: 'PCM' | 'mp3' } = {}): void {
    this.wire()
    this.chunks = []
    this.priming = []
    this.sourceRate = 0
    this.infoReported = false
    this.startedAt = Date.now()
    this.manager.start({
      // ⚠️ 官方限制：duration 最大 600000（10 分钟）
      duration: 60_000,
      // ⚠️ sampleRate 只是**请求值**：实测在 PC 上无效，真机自检也量到过 8kHz。
      //    真正的采样率由 Recorder 从字节流反推，并逐帧归一化到 16kHz。
      sampleRate: AUDIO_SPEC.sampleRate,
      // ⚠️ 默认值是 2（双声道）！不显式传 1 会拿到立体声，与引擎要求不符
      numberOfChannels: AUDIO_SPEC.channels,
      // ⚠️ 必须落在 sampleRate 对应的合法区间：16000Hz → 24000 ~ 96000
      encodeBitRate: 48_000,
      // ⭐ 直出裸 PCM，与引擎零转码
      // ⚠️ frameSize 单位是 KB 且必须是整数；官方限定「暂仅支持 mp3、pcm 格式」
      format: opts.format ?? 'PCM',
      frameSize: opts.frameSizeKb ?? AUDIO_SPEC.frameSizeKb,
    })
  }

  stop(): void {
    this.manager.stop()
  }
}
