import { describe, expect, it } from 'vitest'
import { newRequestId } from './request-id'

describe('newRequestId —— 客户端幂等键', () => {
  it('带前缀，能一眼看出这条流水是哪来的', () => {
    expect(newRequestId('exchange', 1000, 0.5).startsWith('exchange-')).toBe(true)
  })

  it('⭐⭐ 同一时刻、不同随机数 ⇒ **不同的 id**（否则连点两下会被当成同一次）', () => {
    const a = newRequestId('exchange', 1000, 0.1)
    const b = newRequestId('exchange', 1000, 0.9)
    expect(a).not.toBe(b)
  })

  it('⭐ 同样的输入 ⇒ 同样的 id（纯函数，可测）', () => {
    expect(newRequestId('x', 42, 0.25)).toBe(newRequestId('x', 42, 0.25))
  })

  it('⚠️ 长度不超过服务端那一列（ref_id varchar(64)）', () => {
    expect(newRequestId('exchange', Date.now(), 0.999999).length).toBeLessThanOrEqual(64)
  })

  it('⚠️ 随机数为 0 也不塌成一个短串（padStart 兜住）', () => {
    expect(newRequestId('x', 1, 0).length).toBeGreaterThan(3)
  })
})
