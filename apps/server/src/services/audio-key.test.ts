import { describe, expect, it } from 'vitest'
import { assertAudioKeyOwnedBy, makeAudioKey, makeSubmissionId } from './audio-key'

describe('makeSubmissionId', () => {
  it('是确定性的 —— 同样输入永远同样输出', () => {
    expect(makeSubmissionId(1, 2, 3)).toBe(makeSubmissionId(1, 2, 3))
  })

  it('任一输入变化都会改变结果', () => {
    const base = makeSubmissionId(1, 2, 3)
    expect(makeSubmissionId(9, 2, 3)).not.toBe(base)
    expect(makeSubmissionId(1, 9, 3)).not.toBe(base)
    expect(makeSubmissionId(1, 2, 9)).not.toBe(base)
  })

  it('不同组合不会撞号', () => {
    const seen = new Set<string>()
    for (const u of [1, 2, 12]) {
      for (const a of [3, 4, 34]) {
        for (const s of [5, 6, 56]) seen.add(makeSubmissionId(u, a, s))
      }
    }
    expect(seen.size).toBe(27)
  })

  it('长度固定 24，适合做 varchar(40) 主键', () => {
    expect(makeSubmissionId(1, 2, 3)).toHaveLength(24)
    expect(makeSubmissionId(999999, 999999, 999999)).toHaveLength(24)
  })
})

describe('makeAudioKey', () => {
  it('按 句子/用户/时间戳 三段组织', () => {
    expect(makeAudioKey(5, 12, 1757890123456)).toBe('audio/5/12/1757890123456.pcm')
  })
})

describe('assertAudioKeyOwnedBy —— ⚠️ 安全边界', () => {
  const KEY = 'audio/5/12/1757890123456.pcm'

  it('合法且属于本人时通过', () => {
    expect(() => assertAudioKeyOwnedBy(KEY, 12, 5)).not.toThrow()
  })

  it('⛔ 路径属于别人时必须拒绝（这正是防冒充的关键）', () => {
    expect(() => assertAudioKeyOwnedBy(KEY, 999, 5)).toThrow(/不属于当前用户/)
  })

  it('⛔ 路径里的文章与提交的不一致时拒绝', () => {
    expect(() => assertAudioKeyOwnedBy(KEY, 12, 999)).toThrow(/文章/)
  })

  it('⛔ 前缀不对时拒绝（防止指向别的前缀下的对象）', () => {
    expect(() => assertAudioKeyOwnedBy('backup/5/12/1757890123456.pcm', 12, 5)).toThrow(/前缀/)
  })

  it('⛔ 段数不对时拒绝', () => {
    expect(() => assertAudioKeyOwnedBy('audio/5/12.pcm', 12, 5)).toThrow(/格式/)
    expect(() => assertAudioKeyOwnedBy('audio/5/12/x/y.pcm', 12, 5)).toThrow(/格式/)
  })

  it('⛔ 文件名不是 时间戳.pcm 时拒绝（挡住路径穿越）', () => {
    expect(() => assertAudioKeyOwnedBy('audio/5/12/../../etc/passwd', 12, 5)).toThrow()
    expect(() => assertAudioKeyOwnedBy('audio/5/12/abc.pcm', 12, 5)).toThrow(/文件名/)
  })
})
