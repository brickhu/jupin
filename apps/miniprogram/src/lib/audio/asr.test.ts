import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PLUGIN_HINT } from './wechatsi'

/**
 * ⚠️ 插件是**运行时全局**（`requirePlugin`，由小程序引擎提供），vitest 里没有 ——
 *    按需挂到 globalThis 上，测完摘掉（与 tts.test.ts 同一套做法）。
 */
const g = globalThis as unknown as { requirePlugin?: unknown }

/**
 * ⭐ 每个用例都要**重新 import 一次模块**：`asr.ts` 里管理器与 pending 都是
 *    **模块级单例**（插件要求），不重置的话上一个用例的状态会漏进下一个。
 */
async function freshAsr() {
  vi.resetModules()
  return (await import('./asr')) as typeof import('./asr')
}

interface FakeMgr {
  start: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  onStart?: (res: unknown) => void
  onStop?: (res: unknown) => void
  onError?: (res: unknown) => void
  [k: string]: unknown
}

/**
 * 造一个假插件。
 * ⚠️ 管理器故意**只有 start / stop 两个函数**，`onStart/onStop/onError` 一律不存在 ——
 *    这正是真机上实际的样子（官方示例是**属性赋值**，不是方法调用）。
 *    asr.ts 的 bindEvent 会把它们当属性挂上来，所以下面能直接 `mgr.onStop?.(…)`。
 */
function fakePlugin(over: { stopThrows?: boolean } = {}): FakeMgr {
  const mgr: FakeMgr = {
    start: vi.fn(),
    stop: vi.fn(() => {
      if (over.stopThrows) throw new Error('not recording')
    }),
  }
  g.requirePlugin = () => ({ getRecordRecognitionManager: () => mgr })
  return mgr
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  delete g.requirePlugin
  vi.restoreAllMocks()
})

describe('asr —— 插件不可用', () => {
  it('没挂 requirePlugin：isAsrAvailable 为 false，start 给的是可读的话术', async () => {
    const asr = await freshAsr()
    expect(asr.isAsrAvailable()).toBe(false)
    await expect(asr.startRecognize()).rejects.toThrow(PLUGIN_HINT)
  })

  it('插件在、但 getRecordRecognitionManager 抛错 ⇒ 当作不可用，不炸', async () => {
    g.requirePlugin = () => ({
      getRecordRecognitionManager: () => {
        throw new Error('boom')
      },
    })
    const asr = await freshAsr()
    expect(asr.isAsrAvailable()).toBe(false)
  })
})

describe('asr —— 正常一次识别', () => {
  it('⭐ 回调按**属性赋值**挂上（官方示例那条路），onStop 回来即 resolve', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()

    const p = asr.startRecognize()
    expect(typeof mgr.onStop).toBe('function') // 挂上了属性 —— 不是方法调用
    expect(mgr.start).toHaveBeenCalledWith({ lang: 'en_US', duration: asr.ASR_MAX_RECORD_MS })

    // ⚠️ 先让时间走一点，否则 finalizeMs 恒为 0、测不出东西
    vi.advanceTimersByTime(20)
    mgr.onStart?.({ msg: 'Ok' })
    asr.stopRecognize()
    mgr.onStop?.({ result: 'hello world', tempFilePath: '/tmp/a.mp3', duration: 1234 })

    const r = await p
    expect(r.text).toBe('hello world')
    expect(r.tempFilePath).toBe('/tmp/a.mp3')
    expect(r.recordMs).toBe(1234)
    // ⭐ finalizeMs 量的是"说完 → 出结果"，不是"开始录 → 出结果"
    expect(r.finalizeMs).not.toBeNull()
    expect(r.finalizeMs as number).toBeLessThan(20)
    expect(r.totalMs).toBeGreaterThanOrEqual(20)
  })

  it('没调 stop 就回调（插件 duration 到点自动停）⇒ finalizeMs 为 null，不当成延迟用', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()
    const p = asr.startRecognize()
    mgr.onStop?.({ result: 'ok' })
    const r = await p
    expect(r.finalizeMs).toBeNull()
  })

  it('插件报错 ⇒ reject 且把 retcode 带进 message', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()
    const p = asr.startRecognize()
    mgr.onError?.({ retcode: -30001, msg: '录音接口出错' })
    await expect(p).rejects.toThrow('-30001')
  })
})

describe('asr —— 卡住时必须有人说话（第一版就是在这里永久转圈）', () => {
  it('⭐⭐ stop() 自己抛错 ⇒ 立刻 reject 一句人话，**不是静默等待**', async () => {
    const mgr = fakePlugin({ stopThrows: true })
    const asr = await freshAsr()
    const p = asr.startRecognize()
    mgr.onStart?.({ msg: 'Ok' })
    asr.stopRecognize()
    await expect(p).rejects.toThrow(/停止录音失败/)
  })

  it('⭐⭐ stop() 没抛、但 onStop 永远不来 ⇒ 超时 reject', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()
    const p = asr.startRecognize()
    mgr.onStart?.({ msg: 'Ok' })
    asr.stopRecognize()
    const assertion = expect(p).rejects.toThrow(/没有回调/)
    await vi.advanceTimersByTimeAsync(13000)
    await assertion
  })

  it('⭐ 插件连 onStart 都不回（多半是麦克风没授权）⇒ 超时 reject', async () => {
    fakePlugin()
    const asr = await freshAsr()
    const p = asr.startRecognize()
    const assertion = expect(p).rejects.toThrow(/没有开始录音/)
    await vi.advanceTimersByTimeAsync(7000)
    await assertion
  })

  it('上一次没结束就再 start ⇒ 给一句人话，而不是让插件回 -30011', async () => {
    fakePlugin()
    const asr = await freshAsr()
    asr.startRecognize()
    await expect(asr.startRecognize()).rejects.toThrow(/上一次识别还没结束/)
  })

  it('resetRecognize 之后可以重新开始（清掉卡住的状态）', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()
    asr.startRecognize()
    asr.resetRecognize()
    // ⚠️ 不能 await 这个 promise —— 它要等 onStop，这里只验"没被上一次挡住"
    asr.startRecognize()
    expect(mgr.start).toHaveBeenCalledTimes(2)
  })
})

describe('describeAsrEvent —— 联合类型取字段只有这一处', () => {
  it('timeout 给 msg，其余给 raw 的 JSON', async () => {
    const asr = await freshAsr()
    expect(asr.describeAsrEvent({ at: 1, kind: 'timeout', msg: '超时了' })).toBe('超时了')
    expect(asr.describeAsrEvent({ at: 1, kind: 'plugin-stop', raw: { result: 'hi' } })).toContain('hi')
    expect(asr.describeAsrEvent({ at: 1, kind: 'start-requested' })).toBe('')
  })
})

describe('asrErrorText —— 负数码要变成人话（-30003 真机遇到过）', () => {
  it('⭐ -30003 的话术里必须点出「开发者工具/模拟器」这个最常见原因', async () => {
    const asr = await freshAsr()
    const t = asr.asrErrorText(-30003, '录音帧数据未产生或者发送失败导致的数据传输失败')
    expect(t).toContain('-30003')
    expect(t).toContain('开发者工具')
  })

  it('-30001 指向麦克风权限', async () => {
    const asr = await freshAsr()
    expect(asr.asrErrorText(-30001, '录音接口出错')).toContain('麦克风')
  })

  it('-40001 要点出配额数字（它比讯飞的钱更早成为瓶颈）', async () => {
    const asr = await freshAsr()
    const t = asr.asrErrorText(-40001, '频率限制')
    expect(t).toContain('3 万条/天')
  })

  it('表里没有的码：照原样带出来，不硬猜', async () => {
    const asr = await freshAsr()
    const t = asr.asrErrorText(-99999, '某种新错误')
    expect(t).toContain('-99999')
    expect(t).toContain('某种新错误')
  })

  it('onError 走的就是这条翻译（不是把 retcode 裸给用户）', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()
    const p = asr.startRecognize()
    mgr.onError?.({ retcode: -30003, msg: '录音帧数据未产生' })
    await expect(p).rejects.toThrow(/开发者工具/)
  })
})

describe('录音时长上限 —— 不要取插件的最大值', () => {
  it('⭐ 默认值必须明显小于插件的上限 60000（否则忘了点停止就白挂一分钟）', async () => {
    const asr = await freshAsr()
    expect(asr.ASR_MAX_RECORD_MS).toBeLessThan(60_000)
    expect(asr.ASR_MAX_RECORD_MS).toBeGreaterThanOrEqual(15_000) // 也别短到把正常朗读掐了
  })

  it('startRecognize 把它传给插件（不是硬编码 60000）', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()
    asr.startRecognize()
    expect(mgr.start).toHaveBeenCalledWith({ lang: 'en_US', duration: asr.ASR_MAX_RECORD_MS })
  })

  it('调用方可以按句长覆盖', async () => {
    const mgr = fakePlugin()
    const asr = await freshAsr()
    asr.startRecognize({ durationMs: 12_345 })
    expect(mgr.start).toHaveBeenCalledWith({ lang: 'en_US', duration: 12_345 })
  })
})
