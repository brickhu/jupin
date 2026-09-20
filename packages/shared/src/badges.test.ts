import { describe, expect, it } from 'vitest'
import { BADGES, badgesFor, daysToNextBadge, latestBadge, nextBadge } from './badges'

describe('徽章阶梯', () => {
  it('天数严格递增（否则「下一个徽章」会死循环/错乱）', () => {
    for (let i = 1; i < BADGES.length; i++) {
      expect((BADGES[i] as { days: number }).days).toBeGreaterThan(
        (BADGES[i - 1] as { days: number }).days,
      )
    }
  })

  it('code 唯一', () => {
    expect(new Set(BADGES.map((b) => b.code)).size).toBe(BADGES.length)
  })
})

describe('badgesFor', () => {
  it('0 天一个都没有', () => {
    expect(badgesFor(0)).toHaveLength(0)
    expect(latestBadge(0)).toBeNull()
  })

  it('阈值是「达到」而不是「超过」', () => {
    for (const b of BADGES) {
      expect(badgesFor(b.days).map((x) => x.code)).toContain(b.code)
      expect(badgesFor(b.days - 1).map((x) => x.code)).not.toContain(b.code)
    }
  })

  it('按天数升序返回', () => {
    const earned = badgesFor(100)
    expect(earned.map((b) => b.days)).toEqual([...earned.map((b) => b.days)].sort((a, c) => a - c))
  })

  it('封顶后不再增长', () => {
    expect(badgesFor(9999)).toHaveLength(BADGES.length)
    expect(latestBadge(9999)?.code).toBe(BADGES[BADGES.length - 1]?.code)
  })
})

describe('nextBadge / daysToNextBadge', () => {
  it('指向下一个未达成的门槛', () => {
    expect(nextBadge(0)?.days).toBe(1)
    expect(daysToNextBadge(0)).toBe(1)
    expect(daysToNextBadge(5)).toBe(2) // 下一个是 7
    expect(daysToNextBadge(7)).toBe(7) // 刚拿到 7，下一个是 14
  })

  it('到顶后返回 null / 0', () => {
    const top = BADGES[BADGES.length - 1] as { days: number }
    expect(nextBadge(top.days)).toBeNull()
    expect(daysToNextBadge(top.days)).toBe(0)
    expect(daysToNextBadge(top.days + 100)).toBe(0)
  })
})
