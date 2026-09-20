import { describe, expect, it } from 'vitest'
import { BRAND, startButtonLabel } from './brand'

/**
 * ⚠️ 这些用例守的是**一致性**，不是文案本身 ——
 *    同一个按钮出现在首页和竞技场页，表达的是**同一个状态**。
 *    各写各的字符串必然漂移：一处改了另一处忘，
 *    用户看到同一个状态有两个说法，然后开始怀疑哪一个才算数。
 *    而这种事**无法从任何一处代码看出来**，只能靠只有一个来源。
 */
describe('startButtonLabel', () => {
  it('参与过 → 重新朗读，再次冲榜', () => {
    expect(startButtonLabel(true)).toBe('重新朗读，再次冲榜')
  })

  it('没参与过 → 立即朗读，参与挑战', () => {
    expect(startButtonLabel(false)).toBe('立即朗读，参与挑战')
  })

  it('两个状态必须给出不同的文案 —— 否则按钮就没表达任何状态', () => {
    expect(startButtonLabel(true)).not.toBe(startButtonLabel(false))
  })

  it('⚠️ 两句都要以**动作**开头（朗读），而不是以状态开头', () => {
    // 「再次挑战」四个字要用户先想「挑战什么」；而这一页唯一的主线动作是**读**。
    // 两种状态都点明动作，用户不用先读懂按钮再决定点不点。
    expect(startButtonLabel(false)).toContain('朗读')
    expect(startButtonLabel(true)).toContain('朗读')
  })
})

describe('BRAND', () => {
  it('三句定位都不为空，且互不相同', () => {
    const v = [BRAND.name, BRAND.tagline, BRAND.pitch]
    for (const s of v) expect(s.length).toBeGreaterThan(0)
    expect(new Set(v).size).toBe(3)
  })
})
