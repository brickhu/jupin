import { afterEach, describe, expect, it, vi } from 'vitest'

import { PLUGIN_HINT, isTtsAvailable, speak, stripToSpoken } from './tts'

/**
 * ⚠️ 插件是**运行时全局**（`requirePlugin`，由小程序引擎提供），vitest 里没有 ——
 *    所以这里按需要挂到 globalThis 上，测完摘掉。
 *    lib/audio/tts.ts 用的是 try/catch，没挂时它只是"插件不可用"，不会炸。
 */
const g = globalThis as unknown as { requirePlugin?: unknown }

afterEach(() => {
  delete g.requirePlugin
  vi.restoreAllMocks()
})

/** 造一个假的插件：记录调用参数，并按剧本回调 */
function fakePlugin(script: {
  filename?: string | undefined
  failWith?: { retcode?: number; msg?: string }
}): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = []
  g.requirePlugin = () => ({
    textToSpeech(o: Record<string, unknown>) {
      calls.push(o)
      if (script.failWith) (o.fail as (e: unknown) => void)(script.failWith)
      else (o.success as (r: { filename?: string }) => void)({ filename: script.filename })
    },
  })
  return { calls }
}

describe('stripToSpoken —— 送进插件前剥掉首尾标点', () => {
  it('剥掉首尾标点（插件会把句号念出来）', () => {
    expect(stripToSpoken('count.')).toBe('count')
    expect(stripToSpoken('"shells,"')).toBe('shells')
    expect(stripToSpoken('  the  ')).toBe('the')
  })

  // ⚠️ 标题里有撇号 —— 用双引号，别把字符串提前闭合了（第一次就栽在这）
  it("⚠️ 词内部的撇号与连字符必须保留（don't 不是两个词）", () => {
    expect(stripToSpoken("Don't,")).toBe("Don't")
    expect(stripToSpoken('well-known.')).toBe('well-known')
    expect(stripToSpoken('multi-directional')).toBe('multi-directional')
  })

  it('纯符号 → 空串（调用方据此不请求合成）', () => {
    expect(stripToSpoken('—')).toBe('')
    expect(stripToSpoken('')).toBe('')
  })
})

describe('speak —— 插件不可用时的提示', () => {
  it('没挂插件时不静默失败，而是把"去哪添加插件"讲清楚', async () => {
    expect(isTtsAvailable()).toBe(false)
    await expect(speak('count')).rejects.toThrow(PLUGIN_HINT)
  })

  it('空内容直接拒绝，不浪费一次插件调用', async () => {
    const { calls } = fakePlugin({ filename: 'x.mp3' })
    await expect(speak('—')).rejects.toThrow('这个词没有可发音的内容')
    expect(calls.length).toBe(0)
  })

  /**
   * ⚠️ 下面每个用例用**不同的词**：缓存是模块级的，同一个词第二次就命中缓存、
   *    根本不会再走插件（那正是缓存要测的行为，但会污染别的用例）。
   */
})

describe('speak —— 合成成功', () => {
  it('⭐ 传的是英文文本 + lang: en_US（插件默认中文，不指定会把单词按中文念）', async () => {
    const { calls } = fakePlugin({ filename: 'wxfile://tts/count.mp3' })
    await expect(speak('count.')).resolves.toBe('wxfile://tts/count.mp3')
    expect(calls.length).toBe(1)
    expect(calls[0]!.lang).toBe('en_US')
    expect(calls[0]!.tts).toBe(true)
    // ⚠️ 送进去的是**剥过标点**的文本，不是 "count."
    expect(calls[0]!.content).toBe('count')
  })

  it('⭐ 同一个词第二次点必须命中缓存（插件有配额，别重复合成）', async () => {
    const { calls } = fakePlugin({ filename: 'wxfile://tts/the.mp3' })
    await speak('the')
    await expect(speak('the')).resolves.toBe('wxfile://tts/the.mp3')
    expect(calls.length).toBe(1)
  })

  it('合成回来却没有文件 → 拒绝，而不是把 undefined 当路径播（那会静默不响）', async () => {
    fakePlugin({ filename: undefined })
    await expect(speak('silence')).rejects.toThrow('合成了但没拿到音频文件')
  })
})

describe('speak —— 合成失败', () => {
  it('把 retcode 带进 message，并仍然给出插件配置的提示', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakePlugin({ failWith: { retcode: 40001, msg: 'invalid params' } })
    await expect(speak('quota')).rejects.toThrow(/合成失败（40001）/)
    await expect(speak('quota')).rejects.toThrow(PLUGIN_HINT)
  })

  it('没有 retcode 时也能给出人话', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fakePlugin({ failWith: {} })
    await expect(speak('neterr')).rejects.toThrow(/合成失败：/)
  })
})
