import { describe, expect, it, vi, afterEach } from 'vitest'

import { newAttemptId } from './upload'

/**
 * ⚠️⚠️ 这个测试守的是**一条真实事故**（用户 2026-09 报"每次都在显示前一次的结果"）：
 *
 *    微信的 `wx.getRandomValues` 要 **ArrayBuffer**，而这里原来传的是 `Uint8Array` ——
 *    它**静默不回填**，于是 `attemptId` 恒为 32 个 0。服务端把每一次提交都判成
 *    "同一次"（幂等键相同）⇒ 永远返回第一次那条成绩，而日志里只有一句"幂等命中"。
 *
 * ⇒ 这里把"随机源异常"的场景钉死：**无论 `wx.getRandomValues` 怎么坏，都不能返回全 0**。
 */
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('newAttemptId —— 绝不允许全 0', () => {
  it('形状是 32 位十六进制', () => {
    const id = newAttemptId()
    expect(id).toMatch(/^[a-f0-9]{32}$/)
  })

  it('每次调用都不同（重录一次 = 新的一次尝试）', () => {
    const ids = new Set(Array.from({ length: 20 }, () => newAttemptId()))
    expect(ids.size).toBe(20)
  })

  it('⚠️ wx.getRandomValues 存在但**静默不回填**（真机的坑）⇒ 仍然不是全 0', () => {
    vi.stubGlobal('wx', { getRandomValues: () => undefined })
    const id = newAttemptId()
    expect(id).not.toMatch(/^0+$/)
    expect(id).toMatch(/^[a-f0-9]{32}$/)
  })

  it('⚠️ wx.getRandomValues 抛异常 ⇒ 也不能失败', () => {
    vi.stubGlobal('wx', {
      getRandomValues: () => {
        throw new Error('boom')
      },
    })
    const id = newAttemptId()
    expect(id).not.toMatch(/^0+$/)
  })

  it('没有 wx（纯 node）也能生成', () => {
    vi.stubGlobal('wx', undefined)
    expect(newAttemptId()).toMatch(/^[a-f0-9]{32}$/)
  })
})
