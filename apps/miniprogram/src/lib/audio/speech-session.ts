/**
 * ⭐⭐ **一次朗读的录音会话** —— 把「用插件录」和「用我们自己的录音器录」统一成一个接口。
 *
 * ⚠️⚠️ 为什么必须有两套后端（用户 2026-10 定：「模拟器需要做个兜底策略，
 *      可以不支持标色，但是要支持按住录音」）：
 *
 *   | 环境 | 用谁录 | 流式标色 |
 *   |---|---|---|
 *   | **真机** | 微信插件 | ✅ 有 |
 *   | **开发者工具** | **我们自己的录音器** | ❌ 没有 |
 *   | **真机上插件失败** | 同上（降级） | ❌ 没有 |
 *
 *   两条理由：
 *   ① **开发者工具里插件很可能录不了音** —— ⚠️ **这是推断，不是实测**（见 plan.md B43/B44）：
 *      证据只有"模拟器里报过 `-30003`"和"裸录音器在模拟器能出帧"两句话，而**两者互相矛盾**
 *      （devtools 能产帧，插件为何产不出？）。**没有排除**我自己的代码 bug（后来修过
 *      "回调按属性挂"那个）、版本差异、以及 devtools 对插件的沙箱限制。
 *      ⇒ 不做兜底的**后果**是明确的（每改一个字都要扫码上真机），但**原因待查**；
 *   ② 它顺手解掉了另一个风险：插件一旦拥有录音器，它的故障就等于**录不了音**。
 *      有了这条降级路径，录音这个核心动作**不再依赖插件**。
 *
 * ⚠️ **判据是"环境"，不是"试一次再说"**：开发者工具里**已知必失败**，
 *    所以直接跳过插件 —— 不浪费一次失败尝试，也不让用户白等几秒。
 *    真机上才走插件；真机上插件报错时才降级。
 *
 * ⚠️ **两套后端给的音频格式不同**（插件给它的格式，我们给 mp3），
 *    但**提交链路对格式免疫** —— 服务端 `normalizeAudio` + ffmpeg 能把
 *    「上传上来的任何东西」归一化成讯飞要的 16k PCM（见 services/audio.ts 的文件头）。
 *    所以这里**不需要统一格式**，各自把自己那条路径给出来就行。
 */

import { PLATFORM } from '../../config'
import { Recorder } from './recorder'
import { ASR_MAX_RECORD_MS, isAsrAvailable, startRecognize, stopRecognize } from './asr'

/** 这一轮用的是哪套后端 —— 界面据此决定要不要显示逐词标色 */
export type SpeechBackend = 'plugin' | 'local'

export interface SpeechResult {
  /** ⭐ 录音落地的本地文件路径 —— 提交时上传的就是它（两套后端都给） */
  audioPath: string
  durationMs: number
  /**
   * ⭐ 识别文本 —— **只有插件后端有**。
   * `null` = 这一轮没有识别（开发者工具 / 插件降级）⇒ **不做逐词标色**，但录音照常能用。
   */
  text: string | null
}

export interface SpeechCallbacks {
  /**
   * ⭐ **流式中间结果** —— 只有插件后端会给（「边读文字边变色」靠它）。
   * ⚠️ 文本是**整段当前结果**（可能是修正而不是追加），上层按整段处理，别自己拼接。
   */
  onPartial?: (text: string) => void
  /**
   * 音频帧 —— **只有本地后端有**（插件不给帧，实测 0 帧）。
   * ⚠️ 帧是压缩码流（mp3），要画波形得先解码，见 `frame-decode.ts`。
   */
  onFrame?: (frame: ArrayBuffer) => void
  onDone: (r: SpeechResult) => void
  onError: (e: Error) => void
}

export interface SpeechSession {
  /** 这一轮用的哪套后端 —— 上层据此决定要不要渲染标色 */
  readonly backend: SpeechBackend
  /** 按下时调 */
  start(): void
  /** 抬起（或 touchcancel）时调 */
  stop(): void
}

/**
 * 这一轮该用哪套后端。
 * ⚠️ 开发者工具**直接排除插件**（已实测必失败），不去试。
 */
export function pickBackend(): SpeechBackend {
  if (PLATFORM === 'devtools') return 'local'
  return isAsrAvailable() ? 'plugin' : 'local'
}

/** 插件后端：录音 + 流式识别，两样一起给 */
function pluginSession(cb: SpeechCallbacks): SpeechSession {
  return {
    backend: 'plugin',
    start() {
      startRecognize({ durationMs: ASR_MAX_RECORD_MS, onPartial: cb.onPartial })
        .then((r) => {
          cb.onDone({ audioPath: r.tempFilePath, durationMs: r.recordMs, text: r.text })
        })
        .catch((e: Error) => cb.onError(e))
    },
    stop() {
      stopRecognize()
    },
  }
}

/**
 * 本地后端：只有录音，没有识别。
 * ⚠️ 它给的是**我们自己的** `tempFilePath`（mp3），提交链路照用 —— 这与插件那条完全等价。
 */
function localSession(cb: SpeechCallbacks): SpeechSession {
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
  }
}

/** 开一次朗读会话。**必须在按下时 start、抬起时 stop** —— 没有自动停 */
export function createSpeechSession(cb: SpeechCallbacks): SpeechSession {
  return pickBackend() === 'plugin' ? pluginSession(cb) : localSession(cb)
}
