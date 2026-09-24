import { describe, expect, it } from 'vitest'
import { parseRange } from './http-range'

/**
 * ⚠️ 这个函数守的是「音频能不能 seek」—— 不是流量优化：
 *    浏览器只有在服务端支持 range 时才把媒体标成 seekable，
 *    否则给 currentTime 赋值会被夹回 0（点词定位整个失效）。
 *    边界（末尾超界、后缀区间、不可满足）错一个，症状都是「某些句子点词没用」。
 */
describe('parseRange', () => {
  it('没有 Range 头 → null（调用方按 200 整份返回）', () => {
    expect(parseRange(undefined, 100)).toBeNull()
    expect(parseRange('', 100)).toBeNull()
  })

  it('bytes=0-99 → 头 100 字节', () => {
    expect(parseRange('bytes=0-99', 300)).toEqual({ start: 0, end: 99 })
  })

  it('bytes=100- → 从 100 到文件末尾', () => {
    expect(parseRange('bytes=100-', 300)).toEqual({ start: 100, end: 299 })
  })

  it('bytes=-50 → 末尾 50 字节（suffix range）', () => {
    expect(parseRange('bytes=-50', 300)).toEqual({ start: 250, end: 299 })
  })

  it('末尾超过文件大小要夹住，不是报错', () => {
    expect(parseRange('bytes=250-999', 300)).toEqual({ start: 250, end: 299 })
    // 媒体播放器常这么请求：bytes=0- 加上一个远大于文件的 end
    expect(parseRange('bytes=0-1048576', 300)).toEqual({ start: 0, end: 299 })
  })

  it('起点越界 / 形状不对 / 多区间 → null', () => {
    expect(parseRange('bytes=300-', 300)).toBeNull()
    expect(parseRange('bytes=400-500', 300)).toBeNull()
    expect(parseRange('bytes=abc', 100)).toBeNull()
    expect(parseRange('bytes=5-2', 100)).toBeNull()
    expect(parseRange('bytes=-0', 100)).toBeNull()
    // 多区间：浏览器取媒体不会用，返回 null 让调用方整份返回
    expect(parseRange('bytes=0-1,5-6', 100)).toBeNull()
  })
})
