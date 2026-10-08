import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * ⭐ 录音会话 —— 2026-10 砍掉插件之后，它只是一层薄适配（真机与模拟器**同一条路**）。
 *
 * ⚠️ 这里**不再有 `pickBackend`**：以前要按环境在两套后端里挑一套，
 *    现在只有"我们自己的录音器"一套 ⇒ 那个函数连同它的环境判据一起删了 ✓
 *    （它当初存在的唯一理由是"插件在开发者工具里必失败"，而插件已经没了。）
 */

/** 记下每次 new Recorder 收到的 options —— 断言"回调有没有透传"靠它 */
const created: { onFrame?: unknown; onStop?: unknown; onError?: unknown; start: () => void; stop: () => void }[] = []

vi.mock('./recorder', () => ({
  Recorder: class {
    constructor(opts: { onFrame?: unknown; onStop?: unknown; onError?: unknown }) {
      created.push({ ...opts, start: vi.fn(), stop: vi.fn() })
    }
    start() {}
    stop() {}
    dispose() {}
  },
}))

const { createSpeechSession } = await import('./speech-session')

describe('createSpeechSession —— 只剩一套后端', () => {
  beforeEach(() => {
    created.length = 0
  })

  it('⭐ 后端恒为 local（真机与开发者工具走同一条路）', () => {
    const s = createSpeechSession({ onDone: vi.fn(), onError: vi.fn() })
    expect(s.backend).toBe('local')
  })

  it('⭐ 三个回调都要透传给 Recorder（少一个就是静默失效）', () => {
    const onFrame = vi.fn()
    const onDone = vi.fn()
    const onError = vi.fn()
    createSpeechSession({ onFrame, onDone, onError })

    const opts = created[0]
    // ⚠️ onFrame 是**直接透传**（同一引用）；onStop / onError 在适配层包了一层
    //    （它们要把 Recorder 的形状转成 SpeechResult）⇒ 只能按**行为**断言，不能比引用
    expect(opts?.onFrame).toBe(onFrame)
    expect(typeof opts?.onStop).toBe('function')

    const err = new Error('boom')
    ;(opts?.onError as (e: Error) => void)(err)
    expect(onError).toHaveBeenCalledWith(err)
  })

  it('⚠️⚠️ onStop 给上层的 text 恒为 null —— 这是"没有逐词标色"的**唯一**开关', () => {
    const onDone = vi.fn()
    createSpeechSession({ onDone, onError: vi.fn() })

    // 模拟录音器回调
    const onStop = created[0]?.onStop as (r: { tempFilePath: string; durationMs: number }) => void
    onStop({ tempFilePath: '/tmp/a.mp3', durationMs: 3000 })

    expect(onDone).toHaveBeenCalledWith({ audioPath: '/tmp/a.mp3', durationMs: 3000, text: null })
  })

  it('start / stop / dispose 都转给录音器（不自己记状态）', () => {
    const s = createSpeechSession({ onDone: vi.fn(), onError: vi.fn() })
    // 不抛就行 —— 真正的行为在 recorder 自己的测试里
    expect(() => {
      s.start()
      s.stop()
      s.dispose()
    }).not.toThrow()
  })
})
