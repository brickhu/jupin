import { describe, expect, it } from 'vitest'

import { plainWordsOf } from '@jushuo/shared'

import { alignToWords, parseSse, type AlignmentSegment } from './fishaudio'

/**
 * ⭐ 这两条钉的是 **2026-09 实测翻过的车**（见 fishaudio.ts 文件头 ②/②b）：
 *    一个 49 词的真实句子让「对齐校验失败：本地 49 个词，引擎返回 14 个 segment」，
 *    而当时的假设是「alignment 逐块累积，留最后一个就是全部」—— 前 5 个样本
 *    （全部 ≤18 词、无连字符）都支持这个假设，第 6 个把它推翻了。
 *    ⇒ 现在用**真实返回的形状**当夹具：块内累积、块间重置、连字符被拆开。
 */

/** 造一个 SSE 事件块 —— 形状抄真实返回（audio_base64 + alignment.segments + audio_duration） */
function evt(
  audio: string,
  segments: AlignmentSegment[] | null,
  duration: number | null,
): string {
  const payload = JSON.stringify({
    audio_base64: Buffer.from(audio).toString('base64'),
    alignment:
      segments === null
        ? null
        : { segments, audio_duration: duration, audio_duration_sec: duration },
  })
  return 'data: ' + payload + '\n\n'
}

const seg = (text: string, start: number, end: number): AlignmentSegment => ({ text, start, end })

/**
 * 夹具的正文：9 个本地词（plainWordsOf），其中 well-known / multi-directional 带连字符。
 *
 *   The | days, | well-known | count. | And | a | second, | multi-directional | part.
 */
const TEXT = 'The days, well-known count. And a second, multi-directional part.'

/** 引擎侧：9 个本地词 → 11 段（两个连字符词各被拆成 2 段） */
const CHUNK1 = [
  [seg('The', 0, 0.3)],
  [seg('The', 0, 0.3), seg('days', 0.3, 0.7)],
  [seg('The', 0, 0.3), seg('days', 0.3, 0.7), seg('well', 0.7, 0.9)],
  [
    seg('The', 0, 0.3),
    seg('days', 0.3, 0.7),
    seg('well', 0.7, 0.9),
    seg('known', 0.9, 1.2),
    seg('count', 1.2, 1.6),
  ],
]
const CHUNK2 = [
  [seg('And', 0, 0.2)],
  [seg('And', 0, 0.2), seg('a', 0.2, 0.4)],
  [seg('And', 0, 0.2), seg('a', 0.2, 0.4), seg('second', 0.4, 0.9)],
  [
    seg('And', 0, 0.2),
    seg('a', 0.2, 0.4),
    seg('second', 0.4, 0.9),
    seg('multi', 0.9, 1.2),
    seg('directional', 1.2, 1.7),
  ],
  [
    seg('And', 0, 0.2),
    seg('a', 0.2, 0.4),
    seg('second', 0.4, 0.9),
    seg('multi', 0.9, 1.2),
    seg('directional', 1.2, 1.7),
    seg('part', 1.7, 2.0),
  ],
]

const RAW =
  evt('a', null, null) +
  CHUNK1.slice(0, 3)
    .map((s, i) => evt('b'.repeat(i + 1), s, 0.5 * (i + 1)))
    .join('') +
  evt('dddd', CHUNK1[3]!, 2.0) +
  CHUNK2.map((s, i) => evt('e'.repeat(i + 1), s, 0.4 * (i + 1))).join('')

describe('parseSse —— 块内累积、块间重置', () => {
  it('音频按到达顺序拼起来（含 alignment 为 null 的首块）', () => {
    // 1 + (1+2+3) + 4 + (1+2+3+4+5) = 26 字节
    expect(parseSse(RAW).audio.length).toBe(26)
  })

  it('⚠️ 两块的时间轴要**首尾相接**，不是只留最后一块', () => {
    const { alignment } = parseSse(RAW)
    // 引擎段总数 = 5 + 6（两个连字符词各拆成两段）—— 不是本地词数 9，也不是 6
    expect(alignment.segments.length).toBe(11)
    // chunk2 的时间从 0 重新开始 ⇒ 必须整体加上 chunk1 的时长 2.0
    expect(alignment.segments[5]!.start).toBeCloseTo(2.0 + 0, 6)
    expect(alignment.segments[5]!.text).toBe('And')
    // 总时长 = 块1 的 2.0 + 块2 的 2.0
    expect(alignment.audioDuration).toBeCloseTo(4.0, 6)
    expect(alignment.segments[10]!.end).toBeCloseTo(4.0, 6)
  })

  it('单块（老样本那种短句）行为不变', () => {
    const one = CHUNK1.map((s, i) => evt('x', s, 0.5 * (i + 1))).join('')
    const { alignment } = parseSse(one)
    expect(alignment.segments.length).toBe(5)
    expect(alignment.segments[0]!.start).toBe(0)
  })

  it('没有 alignment 的流要报错（而不是吐出半截数据）', () => {
    expect(() => parseSse(evt('a', null, null))).toThrow(/没有返回 alignment/)
  })
})

describe('alignToWords —— 一个本地词 = 引擎 1…N 段', () => {
  const segmentsOf = () => parseSse(RAW).alignment.segments

  it('⭐ 连字符被拆开的段合并回一个词，取首段 start / 末段 end', () => {
    const words = plainWordsOf(TEXT)
    const aligned = alignToWords(TEXT, segmentsOf())
    expect(aligned.map((s) => s.text)).toEqual(words)
    expect(aligned.length).toBe(9)
    // well-known：第 3 个本地词，吃掉引擎的 well + known
    expect(aligned[2]!.text).toBe('well-known')
    expect(aligned[2]!.start).toBeCloseTo(0.7, 6)
    expect(aligned[2]!.end).toBeCloseTo(1.2, 6)
    // multi-directional：跨块，偏移之后仍然首尾正确
    expect(aligned[7]!.text).toBe('multi-directional')
    expect(aligned[7]!.start).toBeCloseTo(2.9, 6)
    expect(aligned[7]!.end).toBeCloseTo(3.7, 6)
  })

  it('时间轴单调不重叠', () => {
    const aligned = alignToWords(TEXT, segmentsOf())
    for (let i = 1; i < aligned.length; i++) {
      expect(aligned[i]!.start).toBeGreaterThanOrEqual(aligned[i - 1]!.end - 1e-9)
    }
  })

  it('⚠️ 引擎少给一段就**炸**（这是「静默错位」的唯一出口）', () => {
    const missing = segmentsOf().slice(0, 10)
    expect(() => alignToWords(TEXT, missing)).toThrow(/对齐校验失败/)
  })

  it('⚠️ 引擎把词并错也要炸，不是只看条数', () => {
    const wrong = segmentsOf().map((s, i) => (i === 1 ? { ...s, text: 'THE' } : s))
    expect(() => alignToWords(TEXT, wrong)).toThrow(/对齐校验失败/)
  })
})
