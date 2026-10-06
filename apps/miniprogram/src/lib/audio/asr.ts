/**
 * ⭐ 语音 → 文本 —— 走**微信同声传译插件**（WechatSI），和 `tts.ts` 是同一个插件。
 *
 * ⚠️⚠️ 为什么用它而不是自建 ASR：
 *    **免费**、**不占外网域名白名单**、不依赖我们自己的服务端。
 *    代价：① **音频出设备**（走微信服务端）⇒ 隐私指引必须声明「收集语音信息」；
 *          ② 它是通用 ASR，对中式英语的识别质量**未知**（这正是 B41 要真机量的东西）；
 *          ③ 有配额：**250 条/分钟 · 3 万条/天**，不是"无限免费"。
 *
 * ⚠️⚠️ 四个必须记住的插件行为（都踩过或差点踩）：
 *
 *   1. **回调的注册方式有两种说法，官方自相矛盾** —— 文档的方法表把
 *      `onStart/onStop/onError` 列成「方法（参数是 callback）」，而**官方示例代码**
 *      用的是**属性赋值**（`manager.onStop = function(res){…}`）。
 *      2026-10 实测：按方法注册 → `stop()` 之后 `onStop` **永远不回调**、页面卡死在
 *      「正在出结果」。⇒ 下面 `bindEvent` **两种都做**，不赌哪一种。
 *
 *   2. **识别管理器是「全局唯一」的**（官方原文）⇒ 回调**只注册一次**，
 *      不能每次调用都挂一遍。所以是模块级单例 + pending 解析器。
 *
 *   3. **插件自己拥有录音器**（`manager.start()` 内部调 `wx.getRecorderManager`）。
 *      ⇒ 拿不到我们惯用的 `onFrameRecorded` PCM 帧，只有 `onStop` 给的 `tempFilePath`。
 *      本项目「云端只买一个分数、其余端侧自建」的原则在这里要让一步：
 *      录音这件事由插件包办。若将来要同时拿到 PCM，需要**另外单独录一路**。
 *
 *   4. **它可能什么都不回** —— 麦克风没授权、插件状态机卡住、录音器被别处占用……
 *      都可能既没有 `onStop` 也没有 `onError`。⇒ **必须有超时**，
 *      否则用户看到的是一个永远转不完的圈（这正是第一次实现犯的错）。
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
  [k: string]: unknown
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
   * 前提是调用方**手动调了 `stop()`**（没调就是 null）：
   * 有 stop() 才谈得上"说完了"这个时刻，`start → onStop` 那个区间里混着说话时间。
   */
  finalizeMs: number | null
  /** `start()` → `onStop` 的墙钟耗时（含说话时间）—— 只作参考 */
  totalMs: number
}

/** 探针用：把插件回来的每一个事件都摊出来，卡住时才知道卡在哪一步 */
export type AsrEvent =
  | { at: number; kind: 'start-requested' }
  | { at: number; kind: 'plugin-start'; raw: unknown }
  | { at: number; kind: 'stop-requested' }
  | { at: number; kind: 'plugin-stop'; raw: unknown }
  | { at: number; kind: 'plugin-error'; raw: unknown }
  | { at: number; kind: 'timeout'; msg: string }

/**
 * 事件 → 一行字。
 * ⚠️ 单独一个函数而不是在两处各写一遍 `e.raw ?? e.msg`：那是联合类型，
 *    直接取属性 `tsc` 会报"该属性不存在于所有分支"（第一版就是这么红的）。
 */
export function describeAsrEvent(e: AsrEvent): string {
  if (e.kind === 'timeout') return e.msg
  if (e.kind === 'plugin-start' || e.kind === 'plugin-stop' || e.kind === 'plugin-error') {
    try {
      return JSON.stringify(e.raw ?? null).slice(0, 160)
    } catch {
      return String(e.raw)
    }
  }
  return ''
}

/** 识别语言 —— 目前只需要英文；改这里等于改产品行为 */
export const ASR_LANG = 'en_US'

/**
 * ⭐ 插件错误码 → 人话。
 *
 * ⚠️ 为什么要这张表：插件 `onError` 只给一个**负数码 + 一句很含糊的 msg**
 *    （"录音帧数据未产生或者发送失败导致的数据传输失败"），
 *    直接摊给用户等于没说，摊给开发者也定位不了。
 * ⚠️ 码表来源：官方文档「微信同声传译」的 onError 错误码说明
 *    （https://developers.weixin.qq.com/miniprogram/dev/platform-capabilities/extended/translator.html）。
 *    ⚠️ 那份文档对应的是**旧版本（0.0.7）**，而 app.json 用的是 0.3.5 ——
 *      遇到表里没有的码，就照原样把码和 msg 显示出来，别硬猜。
 */
export const ASR_ERROR_HINT: Record<number, string> = {
  [-30001]: '录音接口出错 —— 多半是麦克风权限没给（右上角「…」→ 设置里打开「麦克风」）',
  [-30002]: '录音被暂停，识别终止',
  [-30003]:
    '插件没拿到录音数据。⚠️ 最常见的原因是**在开发者工具里跑** —— 模拟器不产生真实录音帧，必须用真机预览；其次是一开口就点了「说完了」（还没产生任何帧）',
  [-30004]: '没查到识别结果（网络或其他非正常状态）',
  [-30005]: '微信侧识别服务内部错误',
  [-30006]: '识别没在限定时间内完成 —— 句子太长或网络太慢',
  [-30007]: 'start 参数错误',
  [-30008]: '查询结果时网络失败',
  [-30009]: '创建鉴权失败',
  [-30010]: '发送鉴权时网络失败',
  [-30011]: '上一次识别还没结束就再次开始',
  [-30012]: '没有正在进行的识别却调了 stop',
  [-30013]: '未知错误',
  [-40001]: '达到接口调用频率限制（配额 250 条/分钟 · 3 万条/天）',
}

/** 把 retcode 翻成人话；表里没有就照原样带出来 */
export function asrErrorText(retcode: number | undefined, msg: string | undefined): string {
  const known = retcode === undefined ? undefined : ASR_ERROR_HINT[retcode]
  if (known) return `识别失败（${retcode}）：${known}`
  const code = retcode === undefined ? '' : `（${retcode}）`
  return `识别失败${code}：${msg ?? '未知原因'}`
}

/** 调了 start() 之后，插件多久没回 onStart 就认为"根本没录起来" */
const START_TIMEOUT_MS = 6000
/** 调了 stop() 之后，多久没回 onStop 就认为"这次废了" */
const STOP_TIMEOUT_MS = 12000

let manager: RecognitionManager | null = null
let sink: ((e: AsrEvent) => void) | null = null
let pending:
  | {
      resolve: (r: RecognizeResult) => void
      reject: (e: Error) => void
      startedAt: number
      stoppedAt: number | null
      started: boolean
      startTimer: ReturnType<typeof setTimeout>
      stopTimer: ReturnType<typeof setTimeout> | null
    }
  | null = null

/** 探针页用它拿事件流；产品代码不需要 */
export function setAsrEventSink(fn: ((e: AsrEvent) => void) | null): void {
  sink = fn
}

function emit(e: AsrEvent): void {
  try {
    sink?.(e)
  } catch {
    /* 监听者自己炸了不该影响识别 */
  }
  // ⚠️ 同时进 console：真机上 console 比页面更全（页面只有渲染过的东西）
  console.log('[asr]', e.kind, describeAsrEvent(e))
}

/**
 * ⭐ 注册回调 —— **属性赋值与方法调用两种都做**。
 *
 * 官方示例是属性赋值，文档的方法表又说是方法；实测按方法注册时 `onStop` 不回调。
 * 两种都做的语义：
 *   · 若 `name` 此刻是函数 ⇒ 先当 setter 调一次（某些实现是 `onStop(cb){this._cb=cb}`）
 *   · 再**属性赋值**（官方示例那条路，只要实现是"事件里读 this.onStop"就必然生效）
 */
function bindEvent(m: RecognitionManager, name: string, fn: (res: unknown) => void): void {
  const cur = m[name]
  if (typeof cur === 'function') {
    try {
      ;(cur as (cb: unknown) => void).call(m, fn)
    } catch {
      /* 它不是 setter —— 那就只靠下面的属性赋值 */
    }
  }
  m[name] = fn
}

/** 拿识别管理器并**只注册一次**回调（管理器全局唯一） */
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

  bindEvent(m, 'onStart', (res) => {
    if (!pending) return
    pending.started = true
    clearTimeout(pending.startTimer)
    emit({ at: Date.now(), kind: 'plugin-start', raw: res })
  })
  bindEvent(m, 'onStop', (res) => {
    const cur = pending
    if (!cur) return
    pending = null
    clearTimeout(cur.startTimer)
    if (cur.stopTimer) clearTimeout(cur.stopTimer)
    emit({ at: Date.now(), kind: 'plugin-stop', raw: res })
    const r = (res ?? {}) as RecogStopResult
    const now = Date.now()
    cur.resolve({
      text: String(r.result ?? ''),
      tempFilePath: String(r.tempFilePath ?? ''),
      recordMs: Number(r.duration ?? 0),
      finalizeMs: cur.stoppedAt === null ? null : now - cur.stoppedAt,
      totalMs: now - cur.startedAt,
    })
  })
  bindEvent(m, 'onError', (res) => {
    const cur = pending
    if (!cur) {
      emit({ at: Date.now(), kind: 'plugin-error', raw: res })
      return
    }
    pending = null
    clearTimeout(cur.startTimer)
    if (cur.stopTimer) clearTimeout(cur.stopTimer)
    emit({ at: Date.now(), kind: 'plugin-error', raw: res })
    const e = (res ?? {}) as { retcode?: number; msg?: string }
    cur.reject(new Error(asrErrorText(e.retcode, e.msg)))
  })

  manager = m
  return m
}

/** 插件此刻能不能用 */
export function isAsrAvailable(): boolean {
  return ensureManager() !== null
}

/**
 * 确保拿到麦克风授权。
 * ⚠️ 插件内部虽然自己会申请，但它**失败时可能什么都不回**（见文件头第 4 条）——
 *    所以我们自己先问一次，把"没授权"变成一个明确的错，而不是一个转不完的圈。
 * ⚠️ 已经被拒绝过时 `wx.authorize` **不再弹窗、直接 fail**（小程序规则），
 *    这时只能引导用户去设置里开，话术要说清。
 */
export function ensureMicPermission(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || typeof wx.getSetting !== 'function') {
      resolve() // 非小程序环境（单测）—— 交给上层
      return
    }
    wx.getSetting({
      success: (s) => {
        if (s.authSetting && s.authSetting['scope.record']) {
          resolve()
          return
        }
        wx.authorize({
          scope: 'scope.record',
          success: () => resolve(),
          fail: () =>
            reject(
              new Error('需要麦克风权限：请在右上角「…」→ 设置里打开「麦克风」，再回到这一页'),
            ),
        })
      },
      fail: () => resolve(), // 问不到设置就当没结论，别把能用的路堵死
    })
  })
}

/**
 * 开始一次识别。**必须在用户点了"停止"时调 `stopRecognize()`**，
 * 否则要等插件的 `duration` 到点才回结果（默认给到最大值，靠手动停）。
 */
export function startRecognize(opts: { durationMs?: number } = {}): Promise<RecognizeResult> {
  const m = ensureManager()
  if (!m) return Promise.reject(new Error(PLUGIN_HINT))
  if (pending) return Promise.reject(new Error('上一次识别还没结束，请稍等'))

  return new Promise<RecognizeResult>((resolve, reject) => {
    const startedAt = Date.now()
    const fail = (msg: string) => {
      const cur = pending
      pending = null
      if (cur) {
        clearTimeout(cur.startTimer)
        if (cur.stopTimer) clearTimeout(cur.stopTimer)
      }
      emit({ at: Date.now(), kind: 'timeout', msg })
      reject(new Error(msg))
    }

    /**
     * ⚠️ 这两个超时是本文件最重要的防线：插件的失败路径**可能一条回调都不给**，
     *    没有超时的话用户看到的就是一个永远转不完的圈。
     */
    const startTimer = setTimeout(
      () => fail(`插件 ${START_TIMEOUT_MS / 1000} 秒没有开始录音 —— 多半是麦克风权限没给，或插件状态卡住了`),
      START_TIMEOUT_MS,
    )
    pending = { resolve, reject, startedAt, stoppedAt: null, started: false, startTimer, stopTimer: null }
    emit({ at: startedAt, kind: 'start-requested' })
    try {
      m.start({ lang: ASR_LANG, duration: opts.durationMs ?? 60000 })
    } catch (e) {
      fail('启动识别失败：' + PLUGIN_HINT + (e instanceof Error ? ' · ' + e.message : ''))
    }
  })
}

/** 用户说完了 —— 记下这个时刻，`finalizeMs` 就是从这里开始算的 */
export function stopRecognize(): void {
  const cur = pending
  if (!cur) {
    emit({ at: Date.now(), kind: 'timeout', msg: '没有一个进行中的识别可停' })
    return
  }
  if (cur.stoppedAt === null) cur.stoppedAt = Date.now()
  emit({ at: Date.now(), kind: 'stop-requested' })
  // ⚠️ stop() 自己抛错时**不能吞掉** —— 那就是"点了没反应"的根因，
  //    要变成一句人话（第一次实现把它静默 catch 了，于是页面永远停在"正在出结果"）
  try {
    manager?.stop()
  } catch (e) {
    const c = pending
    pending = null
    if (c) {
      clearTimeout(c.startTimer)
      if (c.stopTimer) clearTimeout(c.stopTimer)
    }
    const msg = '停止录音失败：' + (e instanceof Error ? e.message : String(e))
    emit({ at: Date.now(), kind: 'timeout', msg })
    c?.reject(new Error(msg))
    return
  }
  // 兜底：stop() 没抛，但 onStop 不来
  cur.stopTimer = setTimeout(() => {
    const c = pending
    if (!c) return
    pending = null
    clearTimeout(c.startTimer)
    emit({ at: Date.now(), kind: 'timeout', msg: 'stop 之后没有回调' })
    c.reject(new Error(`说完之后 ${STOP_TIMEOUT_MS / 1000} 秒没有出结果 —— 插件没有回调（onStop），这次识别作废`))
  }, STOP_TIMEOUT_MS)
}

/** 丢弃进行中的识别状态（探针页「清空重来」用）—— 不调插件的 stop，只清本地 */
export function resetRecognize(): void {
  const cur = pending
  if (!cur) return
  pending = null
  clearTimeout(cur.startTimer)
  if (cur.stopTimer) clearTimeout(cur.stopTimer)
}
