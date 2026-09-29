import { randomBytes } from 'node:crypto'

import { describe, expect, it } from 'vitest'
import { RECORD_SPEC, SUBMISSION_ID_LENGTH } from '@jushuo/shared'

import { assertAudioKeyOwnedBy, makeAudioKey, makeSubmissionId } from './audio-key'

describe('makeSubmissionId —— 行 id 由 attemptId 派生（不再依赖序号）', () => {
  /** ⚠️ 同样输入永远同样输出 —— 受理与重试拿到的 id 一致 */
  it('是确定性的', () => {
    expect(makeSubmissionId('a'.repeat(32))).toBe(makeSubmissionId('a'.repeat(32)))
  })

  it('不同 attemptId 不撞号（500 个取值）', () => {
    const seen = new Set<string>()
    // ⚠️ 用 `randomBytes` 造 500 个**真的不同**的 attemptId ——
    //    我第一版用 `i.toString(16) + '0'.repeat(31)` 拼，结果它们互相碰撞
    //    （尾部全是 0），测出来是红的而实现没问题。
    for (let i = 0; i < 500; i++) seen.add(makeSubmissionId(randomBytes(16).toString('hex')))
    expect(seen.size).toBe(500)
  })

  /**
   * ⚠️⚠️ 这条盯的是**这次改动的根因**：
   *    id 曾经是 `hash(userId, articleId, seq)` ⇒ **必须先分配序号才能建行**，
   *    而序号一旦被「没触达」的行白占就留下永久空洞（用户看到「第 4 次跳到第 6 次」）。
   *    ⇒ 现在 id 只由 `attemptId` 决定 —— 受理时就算得出来，与序号解耦。
   */
  it('形状与 attemptId 一致（长度用 shared 常量，别写死）', () => {
    expect(makeSubmissionId('f'.repeat(32))).toHaveLength(SUBMISSION_ID_LENGTH)
  })
})


describe('makeAudioKey', () => {
  it('按 句子/用户/attemptId 三段组织', () => {
    /**
     * ⚠️ 后缀跟着**录音格式**走（RECORD_SPEC）：现在是 mp3（压缩 + 有帧回调的交集）。
     * ⚠️ 断言里刻意**引用常量而不是写死扩展名** —— 写死的话，
     *    哪天换格式（aac / pcm）这条测试就会以「莫名其妙地红」的方式报警，
     *    而它想守的其实是「三段结构」，不是某个具体后缀。
     */
    const attemptId = 'a'.repeat(32)
    expect(makeAudioKey('5', 12, attemptId)).toBe('audio/5/12/' + attemptId + '.' + RECORD_SPEC.extension)
  })
})

describe('assertAudioKeyOwnedBy —— ⚠️ 安全边界', () => {
  const KEY = 'audio/5/12/1757890123456.pcm'

  it('合法且属于本人时通过', () => {
    expect(() => assertAudioKeyOwnedBy(KEY, 12, '5')).not.toThrow()
  })

  it('⛔ 路径属于别人时必须拒绝（这正是防冒充的关键）', () => {
    expect(() => assertAudioKeyOwnedBy(KEY, 999, '5')).toThrow(/不属于当前用户/)
  })

  it('⛔ 路径里的文章与提交的不一致时拒绝', () => {
    expect(() => assertAudioKeyOwnedBy(KEY, 12, '999')).toThrow(/文章/)
  })

  it('⛔ 前缀不对时拒绝（防止指向别的前缀下的对象）', () => {
    expect(() => assertAudioKeyOwnedBy('backup/5/12/1757890123456.pcm', 12, '5')).toThrow(/前缀/)
  })

  it('⛔ 段数不对时拒绝', () => {
    expect(() => assertAudioKeyOwnedBy('audio/5/12.pcm', 12, '5')).toThrow(/格式/)
    expect(() => assertAudioKeyOwnedBy('audio/5/12/x/y.pcm', 12, '5')).toThrow(/格式/)
  })

  it('⛔ 文件名不是 时间戳.pcm 时拒绝（挡住路径穿越）', () => {
    expect(() => assertAudioKeyOwnedBy('audio/5/12/../../etc/passwd', 12, '5')).toThrow()
    expect(() => assertAudioKeyOwnedBy('audio/5/12/abc.pcm', 12, '5')).toThrow(/文件名/)
  })
})
