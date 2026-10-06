import { describe, expect, it } from 'vitest'

import { AD_REWARD_MIN_INTERVAL_MS, adRewardTooSoon } from './ad-energy'

/**
 * ⭐ 守「看一次广告发一次」里**唯一能在没有数据库的情况下判断对错**的那件事。
 *
 * ⚠️ 为什么值得写：`adRewardTooSoon` 的两个失败方向都会造成**用户能感知的错**：
 *    · 判太松（该拦不拦）→ 脚本把接口当提款机；
 *    · 判太严（不该拦却拦）→ **真实用户看完广告拿不到能量**，
 *      而《小程序流量主行为规范》把「播放后未下发所承诺的奖励」列为二级违规。
 *
 * ⚠️ 它**不是产品日限**（2026-10 用户定：日限交给微信广告系统）——
 *    一次激励视频最短 6 秒，所以正常用户的两次发放间隔必然 > 5 秒，撞不到这里。
 */
describe('adRewardTooSoon —— 最小间隔（挡脚本，不是产品日限）', () => {
  const now = 1_700_000_000_000

  it('第一次看（没有上一次记录）→ 放行', () => {
    expect(adRewardTooSoon(null, now)).toBe(false)
    expect(adRewardTooSoon(undefined, now)).toBe(false)
  })

  it('间隔够久 → 放行', () => {
    expect(adRewardTooSoon(new Date(now - AD_REWARD_MIN_INTERVAL_MS), now)).toBe(false)
    expect(adRewardTooSoon(new Date(now - 60_000), now)).toBe(false)
  })

  it('间隔不够 → 拦下', () => {
    expect(adRewardTooSoon(new Date(now - 1), now)).toBe(true)
    expect(adRewardTooSoon(new Date(now - (AD_REWARD_MIN_INTERVAL_MS - 1)), now)).toBe(true)
  })

  it('⚠️ 边界：正好等于间隔 → **放行**（判据是"小于才拦"，不留一个神秘的死区）', () => {
    expect(adRewardTooSoon(new Date(now - AD_REWARD_MIN_INTERVAL_MS), now)).toBe(false)
  })

  it('⚠️ 时间戳是坏的（NaN）→ **放行**：宁可多发 1 点，也不要因为一条坏数据把功能永久锁死', () => {
    expect(adRewardTooSoon(new Date(Number.NaN), now)).toBe(false)
  })

  it('⚠️ 上一次发放"在未来"：一个间隔以内当**时钟差**拦下（不拦会连发两次）', () => {
    expect(adRewardTooSoon(new Date(now + 1_000), now)).toBe(true)
    expect(adRewardTooSoon(new Date(now + AD_REWARD_MIN_INTERVAL_MS - 1), now)).toBe(true)
  })

  it('⚠️ 上一次发放"在未来"很远 ⇒ 当**坏数据**放行（否则功能会被锁到那个时间为止）', () => {
    expect(adRewardTooSoon(new Date(now + 60_000), now)).toBe(false)
    expect(adRewardTooSoon(new Date(now + 365 * 24 * 3600_000), now)).toBe(false)
  })

  it('间隔是常量且大于 0（为 0 等于没有这道保护）', () => {
    expect(AD_REWARD_MIN_INTERVAL_MS).toBeGreaterThan(0)
  })
})
