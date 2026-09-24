/**
 * ⭐ HTTP Range 解析 —— 静态音频**能不能 seek** 的唯一前提。
 *
 * ⚠️⚠️ 这不是「省流量」的优化，是**功能开关**：
 *    浏览器只有在服务端支持 range 请求时才会把媒体标成 seekable。
 *    否则 `audio.seekable` 是 [0,0]，给 `currentTime` 赋值会被**夹回 0** ——
 *    症状是「点词定位播放整个失效：点哪个词都在播句子开头」。
 *    （实测：文件已经完整 buffered（0–3.3s），但 seekable=[0,0]，
 *      赋 currentTime=1.59 读回来还是 0。加 Range 支持后立刻正常。）
 *
 * 只支持**单区间**（`bytes=a-b` / `bytes=a-` / `bytes=-n`）：
 * 浏览器取媒体只用这几种；多区间返回 null，调用方按 200 整份返回即可，不算错。
 */
export interface ByteRange {
  start: number
  /** 闭区间（不是长度） */
  end: number
}

export function parseRange(header: string | undefined, size: number): ByteRange | null {
  if (!header || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const rawStart = m[1] ?? ''
  const rawEnd = m[2] ?? ''
  if (rawStart === '' && rawEnd === '') return null

  let start: number
  let end: number
  if (rawStart === '') {
    // bytes=-N：最后 N 个字节
    const n = Number(rawEnd)
    if (!Number.isFinite(n) || n <= 0) return null
    start = Math.max(0, size - n)
    end = size - 1
  } else {
    start = Number(rawStart)
    // 末尾超界要夹住：请求 bytes=250-999 而文件只有 300 字节是合法的
    end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1)
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  if (start > end || start >= size) return null
  return { start, end }
}
