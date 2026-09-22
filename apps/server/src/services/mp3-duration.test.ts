import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { mp3DurationMs } from './mp3-duration'

/**
 * ⚠️ 这些用例守着的是「卡片上那个时长到底有没有算对」这件事的**下限**：
 *    算不出来时必须返回 null（端侧据此不显示时长），
 *    而不是返回 0 或者一个从 ID3 标签里误读出来的离谱数。
 */

/** 一个最小可解析的 MP3：MPEG1 Layer III / 128kbps / 44.1kHz 的帧头 + 一帧的填充 */
function fakeMp3(id3Bytes = 0): Buffer {
  const frame = Buffer.from([0xff, 0xfb, 0x90, 0x00])
  const body = Buffer.alloc(417) // 128kbps @44.1kHz 一帧约 417 字节
  const audio = Buffer.concat([frame, body])
  if (id3Bytes === 0) return audio
  /** ID3v2 头 10 字节 + 标签体；大小那 4 个字节是「同步安全」的（每字节低 7 位） */
  const header = Buffer.alloc(10)
  header.write('ID3', 0, 'latin1')
  header[9] = id3Bytes & 0x7f
  return Buffer.concat([header, Buffer.alloc(id3Bytes), audio])
}

describe('MP3 时长解析', () => {
  it('能从一个正常帧头算出正数时长', () => {
    const ms = mp3DurationMs(fakeMp3())
    expect(ms).not.toBeNull()
    expect(ms as number).toBeGreaterThan(0)
  })

  it('⭐ 会跳过 ID3v2 标签（不跳的话会被标签里的 0xFF 骗到）', () => {
    // ⚠️ 标签体里塞一个假的同步字，正是「不跳过就会误读」的那种情况
    const withJunk = fakeMp3(64)
    withJunk[15] = 0xff
    withJunk[16] = 0xfb
    expect(mp3DurationMs(withJunk)).toBe(mp3DurationMs(fakeMp3()))
  })

  it('认不出帧头就返回 null（绝不是 0）', () => {
    expect(mp3DurationMs(Buffer.alloc(1000))).toBeNull()
    expect(mp3DurationMs(Buffer.from('not an mp3 at all'))).toBeNull()
    expect(mp3DurationMs(Buffer.alloc(0))).toBeNull()
  })

  /**
   * 拿仓库里真实的标准音过一遍（存在才测）。
   * ⚠️ 断言的是**区间**不是精确值：音频重录之后时长会变，
   *    而钉死一个数会让「换了配音」这种正常操作变成测试失败。
   */
  it('仓库里的标准音能算出合理时长（1–60 秒）', () => {
    const file = fileURLToPath(new URL('../../../../content/audio/1.mp3', import.meta.url))
    if (!existsSync(file)) return
    const ms = mp3DurationMs(readFileSync(file))
    expect(ms).not.toBeNull()
    expect(ms as number).toBeGreaterThan(1000)
    expect(ms as number).toBeLessThan(60000)
  })
})
