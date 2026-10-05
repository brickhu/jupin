/**
 * ⭐ 语音 → 文本 —— 走**微信同声传译插件**（WechatSI），和 `tts.ts` 是同一个插件。
 *
 * ⚠️⚠️ 为什么用它而不是自建 ASR：
 *    **免费**、**不占外网域名白名单**、不依赖我们自己的服务端。
 *    代价：① **音频出设备**（走微信服务端）⇒ 隐私指引必须声明「收集语音信息」；
 *          ② 它是通用 ASR，对中式英语的识别质量**未知**（这正是 B41 要真机量的东西）；
 *          ③ 有配额：**250 条/分钟 · 3 万条/天**，不是"无限免费"。
 *
 * ⚠️⚠️ 两个必须记住的插件行为（来自官方文档，与 TTS 那边完全不同的坑）：
 *
 *   1. **识别管理器是「全局唯一」的**（官方原文）。⇒ 回调**只注册一次**，
 *      不能每次调用都挂一遍 —— 那会让上一次的回调被覆盖/堆积，
 *      症状是"第二次识别永远不回调"。所以下面是模块级单例 + pending 解析器。
 *
 *   2. **插件自己拥有录音器**（`manager.start()` 内部调 `wx.getRecorderManager`）。
 *      ⇒ 拿不到我们惯用的 `onFrameRecorded` PCM 帧，只有 `onStop` 给的 `tempFilePath`。
 *      本项目「云端只买一个分数、其余端侧自建」的原则在这里要让一步：
 *      录音这件事由插件包办。若将来要同时拿到 PCM，需要**另外单独录一路**。
 *
 * ⚠️ 与 `tts.ts` 同名的话术从 `./wechatsi` 来（**唯一一份**）。
 */

import { getPlugin, PLUGIN_HINT } from './wechatsi'

/** `onStop` 回的东西 —— 官方文档的字段 */
export interface RecogStopResult {
  /** 最终识别结果 */
  result?: string
  /** 录音临时文件路径 —— 插件把录音也给了我们（格式待核） */
  tempFilePath?: string
  /** 录音总时长（ms） */
  duration?: number
  /** 文件大小（B） */
  fileSize?: number
}

interface RecognitionManager {
  start: (o: { lang?: string; duration?: number }) => void
  stop: () => void
  onStart: (cb: (res: { msg?: string }) => void) => void
  onStop: (cb: (res: RecogStopResult) => void) => void
  onError: (cb: (res: { retcode?: number; msg?: string }) => void) => void
}

interface AsrPlugin {
  getRecordRecognitionManager: () => RecognitionManager
}

/** 一次识别的结果 —— **延迟字段刻意分两个**，见下面注释 */
export interface RecognizeResult {
  /** 识别文本（插件给什么就是什么，**不做任何清洗** —— 清洗是判据那一层的事） */
  text: string
  tempFilePath: string
  /** 插件自报的录音时长（ms） */
  recordMs: number
  /**
   * ⭐⭐ **「用户说完 → 拿到文本」的耗时（ms）** —— 这才是「读完立刻标」要看的数。
   *
   * 前提是调用方**手动调了 `stop()`**（没调就是 null）：
   * 有 stop() 才谈得上"说完了"这个时刻，`start → onStop` 那个区间里混着说话时间，
   * 用它当延迟会把"用户读了 6 秒"算成"延迟 6 秒"。
   */
  finalizeMs: number | null
  /** `start()` → `onStop` 的墙钟耗时（含说话时间）—— 只作参考 */
  totalMs: number
}

/** 识别语言 —— 目前只需要英文；改这里等于改产品行为 */
export const ASR_LANG = 'en_US'

let manager: RecognitionManager | null = null
let pending:
  | {
      resolve: (r: RecognizeResult) => void
      reject: (e: Error) => void
      startedAt: number
      stoppedAt: number | null
    }
  | null = null

/**
 * 拿识别管理器并**只注册一次**回调。
 * ⚠️ 全局唯一 ⇒ 单例；`onStart` 我们不用（没有可做的事），但也必须注册，
 *    否则某些基础库版本会把没注册的回调当异常。
 */
function ensureManager(): RecognitionManager | null {
  const p = getPlugin<AsrPlugin>()
  if (!p) return null
  if (manager) return manager

  let m: RecognitionManager
  try {
    m = p.getRecordRecognitionManager()
  } catch {
    return null
  }

  m.onStart(() => {
    /* 开始录音识别 —— 没有需要做的事（计时在 start() 那一刻已经记了） */
  })
  m.onStop((res) => {
    const cur = pending
    if (!cur) return
    pending = null
    const now = Date.now()
    cur.resolve({
      text: String(res?.result ?? ''),
      tempFilePath: String(res?.tempFilePath ?? ''),
      recordMs: Number(res?.duration ?? 0),
      finalizeMs: cur.stoppedAt === null ? null : now - cur.stoppedAt,
      totalMs: now - cur.startedAt,
    })
  })
  m.onError((res) => {
    const cur = pending
    if (!cur) return
    pending = null
    // ⚠️ 把 retcode 带进 message：光看插件那句 msg 分不清是配额、参数还是网络
    const code = res?.retcode === undefined ? '' : `（${res.retcode}）`
    cur.reject(new Error(`识别失败${code}：${res?.msg ?? '未知原因'}`))
  })

  manager = m
  return m
}

/** 插件此刻能不能用 —— 界面可以用它决定要不要渲染这个入口 */
export function isAsrAvailable(): boolean {
  return ensureManager() !== null
}

/**
 * 开始一次识别。**必须在用户点了"停止"时调 `stopRecognize()`**，
 * 否则要等插件的 `duration` 到点才回结果（默认给到最大值，靠手动停）。
 *
 * ⚠️ 同一时刻只允许一次：上一次还没结束就再 start，插件会回 `-30011`。
 *    这里提前用 pending 拦住，给一句人话而不是让插件报错码。
 */
export function startRecognize(opts: { durationMs?: number } = {}): Promise<RecognizeResult> {
  const m = ensureManager()
  if (!m) return Promise.reject(new Error(PLUGIN_HINT))
  if (pending) return Promise.reject(new Error('上一次识别还没结束，请稍等'))

  return new Promise<RecognizeResult>((resolve, reject) => {
    pending = { resolve, reject, startedAt: Date.now(), stoppedAt: null }
    try {
      m.start({ lang: ASR_LANG, duration: opts.durationMs ?? 60000 })
    } catch (e) {
      pending = null
      reject(new Error('启动识别失败：' + PLUGIN_HINT + (e instanceof Error ? ' · ' + e.message : '')))
    }
  })
}

/** 用户说完了 —— 记下这个时刻，`finalizeMs` 就是从这里开始算的 */
export function stopRecognize(): void {
  if (!manager || !pending) return
  if (pending.stoppedAt === null) pending.stoppedAt = Date.now()
  try {
    manager.stop()
  } catch {
    /* 没在识别中时 stop 会抛（插件回 -30012），忽略即可 —— pending 会由超时兜底 */
  }
}
