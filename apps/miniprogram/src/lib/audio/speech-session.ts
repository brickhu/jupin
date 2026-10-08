/**
 * ⭐⭐ **一次朗读的录音会话** —— 薄薄一层适配，把 `Recorder` 包成页面要的形状。
 *
 * ## ⚠️⚠️ 它原来有两套后端，2026-10 砍成一套
 *
 *   | 环境 | 用谁录 | 流式标色 |
 *   |---|---|---|
 *   | 真机 | 微信插件 | ✅ 有 |
 *   | 开发者工具 | 我们自己的录音器 | ❌ 没有 |
 *
 * 砍掉插件的理由（用户 2026-10 定：「不想走插件」）：
 *
 *   ① ⚠️⚠️ **波形和"判读完"都要 PCM 帧，而插件自己拥有录音器** ✗
 *      （官方原文，见 git 历史里的 asr.ts）——两条音频路同时开才能都要，
 *      那不划算也不可靠 ⇒ 只能二选一；
 *   ② ⭐ 用户要的是「**看波形** + 读完自动结束」（点一下开始录音），
 *      那就必须自己录 ⇒ 插件出局；
 *   ③ 插件还带来别的成本：**音频出设备**、有配额（250 条/分钟）、
 *      而且在开发者工具里**能起录但拿不到音频数据**（-30003）⇒
 *      每次改动都得扫码上真机 ✗
 *
 * ⭐ 砍掉之后的好处（最后一条最实在）：
 *   · PCM 帧有了 ⇒ 波形 ✓ + 静音检测 ✓
 *   · **开发者工具里跑的就是真机那条路** ⇒ 开发回路从"每改一个字扫码"变成直接看 ✓
 *   · 录音这个核心动作**不再依赖插件**（它一旦故障就等于录不了音）✓
 *
 * ⚠️ 代价：**没有逐词标色了**（那需要流式识别）——
 *    那条路本来就只在真机插件下才有，而它的判据（ASR 听错占了很大一块）
 *    也一直不够可信 ✓
 *
 * ## ⚠️ 两套后端给的音频格式不同（留着这条备忘）
 *
 * 插件给它的格式、我们给 mp3 —— 但**提交链路对格式免疫**：
 * 服务端 `normalizeAudio` + ffmpeg 能把"上传上来的任何东西"归一化成讯飞要的 16k PCM
 * （见 services/audio.ts）。现在只剩 mp3 一条路，这条备忘仍然有用 ✓
 */

import { Recorder } from './recorder'

/** ⚠️ 只剩一套后端了，保留这个类型是为了不惊动上层（历史上有过 'plugin'） */
export type SpeechBackend = 'local'

export interface SpeechResult {
  /** ⭐ 录音落地的本地文件路径 —— 提交时上传的就是它 */
  audioPath: string
  durationMs: number
  /**
   * ⭐ 识别文本 —— **永远是 null**（流式识别随插件一起砍掉了）。
   * ⚠️ 保留这个字段是为了不惊动上层：它按 `text === null` 判"这一轮没有识别"，
   *    而现在**每一轮都是这样** ⇒ 逐词标色那条路自然不再出现 ✓
   */
  text: string | null
}

export interface SpeechCallbacks {
  /**
   * ⭐⭐ **录音过程中的原始帧**（mp3 压缩码流）—— 波形与静音检测**都靠它**。
   *
   * ⚠️ 帧是**压缩码流**，不是 PCM：想拿采样得先过 `decodeFrameToSamples`
   *    （见 recorder.ts 的文件头，那里写着为什么不能按 16bit 硬解）。
   * ⚠️ 回调是**异步**的（每 ~170ms 一帧）—— 上层要注意别在回调里做重活。
   */
  onFrame?: (frame: ArrayBuffer) => void
  onDone: (r: SpeechResult) => void
  onError: (e: Error) => void
}

export interface SpeechSession {
  /** 这一轮用的哪套后端 —— 现在恒为 'local' */
  readonly backend: SpeechBackend
  /** 开始时调（用户点一下「开始朗读」） */
  start(): void
  /** 结束时调（用户手动点，或静音自停判定为"读完了"） */
  stop(): void
  /** 页面销毁时调：把还没结束的这一轮丢掉，别让它回来往已销毁的页面上写 */
  dispose(): void
}

/** 开一次朗读会话。⚠️ 现在**没有自动停** —— 自动结束的判据在 lib/audio/vad.ts，由上层接 */
export function createSpeechSession(cb: SpeechCallbacks): SpeechSession {
  const recorder = new Recorder({
    onFrame: cb.onFrame,
    onStop: (r) => cb.onDone({ audioPath: r.tempFilePath, durationMs: r.durationMs, text: null }),
    onError: (e) => cb.onError(e),
  })
  return {
    backend: 'local',
    start() {
      recorder.start()
    },
    stop() {
      recorder.stop()
    },
    dispose() {
      recorder.dispose()
    },
  }
}
