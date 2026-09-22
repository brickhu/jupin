import { AUDIO_SPEC, RECORD_SPEC } from '@jushuo/shared'

/**
 * 录音适配层 —— 只做「挂监听 → 原样转发帧 → 转发停止/错误」，不做任何加工。
 *
 * ⚠️⚠️ 这里曾经是个「音频归一化」层（测设备采样率、逐帧重采样到 16kHz、
 *    合并成整段 PCM）。那一套随录音格式换成 mp3 而**整段删除** ——
 *    帧里装的是压缩码流，再按 16bit 重采样只会静默毁掉它（见 acceptFrame 的说明）。
 *    现在帧的唯一去处是「解码成采样画波形」（lib/audio/frame-decode.ts）。
 */
/** 一段录完的音频 */
export interface RecordResult {
  // ⚠️ 这里原来还有 pcm / sourceSampleRate / sourceByteOrder 三个字段（端侧归一化的产物）。
  //    mp3 格式下帧是压缩码流、上传走的又是落盘文件，它们已经没有任何用处 —— 删掉，
  //    免得下次有人以为「手里有一份现成的 16k PCM」而拿它去算别的东西。
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
}

export interface RecorderCallbacks {
  /**
   * ⭐ 一帧**原始**的录音分片（mp3 码流），**未经任何加工**。
   * ⚠️ 想拿振幅就得先解码（见 lib/audio/frame-decode.ts）；
   *    把它当 16bit PCM 读会得到一条满量程的假波形。
   */
  onFrame?: (frame: ArrayBuffer) => void
  onStop?: (result: RecordResult) => void
  onError?: (err: Error) => void
}

/**
 * ⭐ 全局唯一的录音管理器 —— **监听只挂一次**，事件路由给「当前那个 Recorder」。
 *
 * ⚠️⚠️ 为什么不能每个 Recorder 实例各挂一次（原来就是这么写的）：
 *    `wx.getRecorderManager()` 返回的是**全局唯一**的单例（官方文档原话），
 *    而它能注册的都是 `on*`，**没有任何 `off*`** —— 监听器一旦挂上就摘不掉。
 *    于是「进朗读页 → 录音 → 退出 → 再进朗读页」会挂上第二组监听：
 *    同一帧被处理两遍、同一次停止回调两次，而旧那一组还在往**已经销毁的页面**上写。
 *    ⇒ 管理器与监听挂在这里（模块级），谁在录就把事件给谁。
 */
let manager: WechatMiniprogram.RecorderManager | null = null
/** 当前正在录的那个实例 —— 事件只发给它 */
let active: Recorder | null = null

function managerOf(): WechatMiniprogram.RecorderManager {
  if (manager) return manager
  const m = wx.getRecorderManager()
  m.onFrameRecorded((res) => active?.acceptFrame(res.frameBuffer))
  m.onStop((res) => active?.handleStop(res))
  m.onError((err) => active?.handleError(err))
  manager = m
  return m
}

export class Recorder {
  /** 这一轮录音的开始时刻 —— 时长用本地计时，不用系统回调给的值 */
  private startedAt = 0

  constructor(private readonly cb: RecorderCallbacks = {}) {}

  /**
   * 录音结束 —— 由模块级监听转过来（见 managerOf 的说明）。
   * ⚠️ 只有 active === this 时才会被调，所以这里不必再判自己是不是那个在录的。
   */
  // ⚠️ 这一组不标 private：模块级的那几个监听器（managerOf）要调它们，
  //    而 TS 的 private 是**类作用域**，同模块的普通函数也访问不到。
  //    对外不需要用它们 —— 注释里写清楚「内部用」就够了。
  /** @internal 模块级监听器转发过来的停止事件 */
  handleStop(res: WechatMiniprogram.OnStopListenerResult): void {
    const durationMs = Date.now() - this.startedAt

    this.cb.onStop?.({
      tempFilePath: res.tempFilePath,
      durationMs,
      fileSizeBytes: res.fileSize ?? 0,
    })
  }

  /** @internal 模块级监听器转发过来的错误事件 */
  handleError(err: WechatMiniprogram.GeneralCallbackResult): void {
    this.cb.onError?.(new Error(err.errMsg))
  }
  /**
   * ⭐ 收到一帧，**原样**交给上层。
   *
   * ⚠️⚠️ 这里原来有一整套「测设备采样率 → 逐帧重采样到 16kHz → 合并成整段 PCM」，
   *    已经整段删掉，因为它的前提**不成立了**：
   *      · 那时帧是裸 PCM（format:'PCM'），而下游要 16kHz；
   *      · 现在的录音格式是 mp3（见 RECORD_SPEC），帧里装的是**压缩码流** ——
   *        再按 16bit 去重采样，等于把码流按错误的采样率又采一遍，
   *        解出来必然是噪声，而且是**静默**的（波形照样有柱子，只是与声音无关）；
   *      · 上传给讯飞的音频也不再来自帧：现在传的是录音落地的那个文件
   *        （见 reading 页的 handleRecorded），帧只服务实时波形。
   *    ⇒ 帧的唯一去处是「解码成采样画波形」（lib/audio/frame-decode.ts），
   *      解码器要的是**原始分片**，任何加工都是破坏。
   */
  /** @internal 模块级监听器转发过来的一帧（见 managerOf 的说明） */
  acceptFrame(buf: ArrayBuffer): void {
    this.cb.onFrame?.(buf)
  }

  /**
   * 开始录音（参数见 @jushuo/shared 的 RECORD_SPEC）。
   *
   * ⚠️ 只有 mp3 / pcm 支持帧回调（官方文档），所以只有这两种格式才传 frameSize ——
   *    给不支持的格式传它，轻则被忽略、重则整个 start 失败，
   *    而后者表现为「点了开始朗读没反应」，极难定位。
   *
   * @param opts.frameSizeKb 覆盖 frameSize（仅 mp3/pcm 用得上）。
   *
   * @param opts.frameSizeKb 覆盖 frameSize（仅 mp3/pcm 用得上）。
   *        ⚠️ frameSize 只是**请求值**，设备可能不严格采纳 —— 见 AUDIO_SPEC 的注释。
   * @param opts.format 覆盖录音格式（仅试验 / 自检用）。
   */
  start(opts: { frameSizeKb?: number; format?: 'PCM' | 'mp3' | 'aac' | 'wav' } = {}): void {
    // ⭐ 从现在起事件归我 —— 模块级监听只认 active（见 managerOf 的说明）
    active = this
    this.startedAt = Date.now()

    const format = opts.format ?? RECORD_SPEC.format
    /**
     * ⚠️ 只有 mp3 / pcm 支持帧回调（官方文档）。给不支持的格式传 frameSize，
     *    轻则被忽略、重则整个 start 失败 —— 而后者表现为「点了开始朗读没反应」，
     *    极难定位。所以不支持就干脆不传这个参数。
     */
    const framesSupported = format === 'mp3' || format === 'PCM'

    managerOf().start({
      // ⚠️ 官方限制：duration 最大 600000（10 分钟）
      duration: 60_000,
      // ⚠️ sampleRate 只是**请求值**：实测在 PC 上无效，真机自检也量到过 8kHz。
      //    帧链路上，真正的采样率由 Recorder 从字节流反推、逐帧归一化到 16kHz。
      sampleRate: AUDIO_SPEC.sampleRate,
      // ⚠️ 默认值是 2（双声道）！不显式传 1 会拿到立体声，与引擎要求不符
      numberOfChannels: AUDIO_SPEC.channels,
      // ⚠️ 必须落在 sampleRate 对应的合法区间：16000Hz → 24000 ~ 96000
      encodeBitRate: RECORD_SPEC.encodeBitRate,
      format,
      ...(framesSupported ? { frameSize: opts.frameSizeKb ?? RECORD_SPEC.frameSizeKb } : {}),
    })
  }

  stop(): void {
    managerOf().stop()
  }

  /**
   * ⚠️ 页面销毁时**必须**调：不清掉的话，active 还指着这个已经没了的页面，
   *    下一帧会往它身上写（`setData on destroyed page`）。
   *    ⚠️ 只清「自己还是 active」的情况 —— 别把新页面刚接上的那一个清掉。
   */
  dispose(): void {
    if (active === this) active = null
  }
}
