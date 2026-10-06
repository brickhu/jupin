import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ⚠️ `PLATFORM` 是 config 模块的**常量**（import 时就定死了），所以只能把整个模块 mock 掉。
 *    用 `vi.hoisted` 是因为 `vi.mock` 会被提升到文件顶部 —— 普通 `let` 在那一刻还不存在。
 */
const h = vi.hoisted(() => ({ platform: 'devtools' }))
vi.mock('../../config', () => ({
  get PLATFORM() {
    return h.platform
  },
}))

/** 插件可用性也要能按需开关 */
const asrState = vi.hoisted(() => ({ available: true, started: 0, stopped: 0 }))
vi.mock('./asr', () => ({
  ASR_MAX_RECORD_MS: 30_000,
  isAsrAvailable: () => asrState.available,
  startRecognize: () => {
    asrState.started++
    return Promise.resolve({ text: 'hello world', tempFilePath: '/tmp/p.mp3', recordMs: 1234 })
  },
  stopRecognize: () => {
    asrState.stopped++
  },
}))

/** 本地录音器：记下 start/stop 被调了几次，以及回调怎么走 */
const rec = vi.hoisted(() => ({
  started: 0,
  stopped: 0,
  cbs: null as null | { onStop?: (r: unknown) => void; onFrame?: (f: ArrayBuffer) => void; onError?: (e: Error) => void },
}))
vi.mock('./recorder', () => ({
  Recorder: class {
    constructor(cb: Record<string, unknown>) {
      rec.cbs = cb as typeof rec.cbs
    }
    start() {
      rec.started++
    }
    stop() {
      rec.stopped++
    }
  },
}))

const { createSpeechSession, pickBackend } = await import('./speech-session')

beforeEach(() => {
  h.platform = 'devtools'
  asrState.available = true
  asrState.started = 0
  asrState.stopped = 0
  rec.started = 0
  rec.stopped = 0
  rec.cbs = null
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('pickBackend —— 环境判据（不是"试一次再说"）', () => {
  it('⭐⭐ 开发者工具 ⇒ 本地后端（插件在那里已知必失败，不去试）', () => {
    h.platform = 'devtools'
    asrState.available = true // 就算插件"看起来可用"，也不走它
    expect(pickBackend()).toBe('local')
  })

  it('真机 + 插件可用 ⇒ 插件后端', () => {
    h.platform = 'ios'
    asrState.available = true
    expect(pickBackend()).toBe('plugin')
  })

  it('真机 + 插件不可用 ⇒ 本地后端', () => {
    h.platform = 'android'
    asrState.available = false
    expect(pickBackend()).toBe('local')
  })
})

describe('本地后端（开发者工具 / 插件降级）', () => {
  it('⭐ 能按住录音：start/stop 都转给录音器', () => {
    h.platform = 'devtools'
    const s = createSpeechSession({ onDone: () => {}, onError: () => {} })
    expect(s.backend).toBe('local')
    s.start()
    s.stop()
    expect(rec.started).toBe(1)
    expect(rec.stopped).toBe(1)
  })

  it('⭐ 没有识别文本（text = null）—— 界面据此决定不标色，但录音照常可用', async () => {
    h.platform = 'devtools'
    const done = vi.fn()
    const s = createSpeechSession({ onDone: done, onError: () => {} })
    s.start()
    rec.cbs?.onStop?.({ tempFilePath: '/tmp/local.mp3', durationMs: 4321 })
    expect(done).toHaveBeenCalledWith({ audioPath: '/tmp/local.mp3', durationMs: 4321, text: null })
  })

  it('录音器报错 ⇒ 走 onError', () => {
    h.platform = 'devtools'
    const onError = vi.fn()
    createSpeechSession({ onDone: () => {}, onError })
    const e = new Error('boom')
    rec.cbs?.onError?.(e)
    expect(onError).toHaveBeenCalledWith(e)
  })
})

describe('插件后端（真机）', () => {
  it('⭐ 拿到识别文本 + 音频路径（两样都要）', async () => {
    h.platform = 'ios'
    asrState.available = true
    const done = vi.fn()
    const s = createSpeechSession({ onDone: done, onError: () => {} })
    expect(s.backend).toBe('plugin')
    s.start()
    await vi.waitFor(() => expect(done).toHaveBeenCalled())
    expect(done).toHaveBeenCalledWith({ audioPath: '/tmp/p.mp3', durationMs: 1234, text: 'hello world' })
  })

  it('stop 转给插件的 stopRecognize', () => {
    h.platform = 'ios'
    asrState.available = true
    const s = createSpeechSession({ onDone: () => {}, onError: () => {} })
    s.start()
    s.stop()
    expect(asrState.stopped).toBe(1)
  })
})
