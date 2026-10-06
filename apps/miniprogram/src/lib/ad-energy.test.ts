import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AD_REWARD_ENERGY, type AdEnergyResponse } from '@jushuo/shared'

import {
  adClaimFailedText,
  adErrorText,
  adRewardPromiseText,
  adRewardToast,
  forgetPendingClaim,
  readPendingClaims,
  rememberPendingClaim,
} from './ad-energy'

/**
 * ⭐ 守「看激励视频补能量」里**能被判断对错**的那几件事。
 *
 * ⚠️ 为什么值得写：这里的两个方向都对应**官方明文违规**（《小程序流量主行为规范》）：
 *    · 错误码映射错了 → 用户看到"小程序坏了"，于是反复点（而其实只是没有广告）；
 *    · 承诺与实发不同源 → 「播放后未下发所承诺的奖励」是二级违规。
 *    · 待补发队列坏了 → 用户看完广告白看，同样是那条违规。
 */

const memory = new Map<string, unknown>()

beforeEach(() => {
  memory.clear()
  vi.stubGlobal('wx', {
    getStorageSync: (k: string) => memory.get(k) ?? '',
    setStorageSync: (k: string, v: unknown) => memory.set(k, v),
  })
})

describe('adRewardPromiseText —— 承诺文案只能来自 shared 常量', () => {
  it('承诺与实发同源（不许端侧另写一个数字）', () => {
    expect(adRewardPromiseText()).toContain(String(AD_REWARD_ENERGY))
  })
})

describe('adErrorText —— 激励视频错误码', () => {
  it('1004（无合适广告，最常见）说"稍后再试"而不是"失败"', () => {
    expect(adErrorText(1004)).toContain('没有合适的广告')
  })

  it('1005 审核中 / 1006 驳回 / 1007 封禁 / 1008 关闭 → 各自可区分的一句话', () => {
    expect(adErrorText(1005)).toContain('审核')
    for (const code of [1006, 1007, 1008]) {
      expect(adErrorText(code)).toContain('暂时不可用')
    }
  })

  it('未知 / 缺失错误码 → 通用兜底，绝不留空', () => {
    for (const code of [undefined, 0, 1000, 1003, 9999]) {
      expect(adErrorText(code).length).toBeGreaterThan(0)
    }
  })
})

describe('adRewardToast —— 三种"成功"必须分清', () => {
  const res = (patch: Partial<AdEnergyResponse>): AdEnergyResponse => ({
    ok: true,
    energyGained: 0,
    energy: 3,
    ...patch,
  })

  it('真发了 → 报「+N 点能量」', () => {
    expect(adRewardToast(res({ energyGained: AD_REWARD_ENERGY }))).toBe('+' + AD_REWARD_ENERGY + ' 点能量')
  })

  it('重放（ok 但没发）→ **不弹**：点数早在账上，再说一次 +1 是假的', () => {
    expect(adRewardToast(res({ energyGained: 0 }))).toBeNull()
  })

  it('too-soon → 一句人话（正常用户看不到，只有脚本会撞上）', () => {
    expect(adRewardToast(res({ ok: false, reason: 'too-soon' }))).toContain('慢一点')
  })

  it('其它失败 → 也要有反馈（用户刚看完广告，静默最糟）', () => {
    expect(adRewardToast(res({ ok: false, reason: 'unavailable' }))).toBeTruthy()
  })
})

describe('待补发队列 —— 「承诺了必须发」的机制', () => {
  it('记下 → 读回；同一笔记两次不会变成两条', () => {
    rememberPendingClaim('ad-1')
    rememberPendingClaim('ad-1')
    rememberPendingClaim('ad-2')
    expect(readPendingClaims()).toEqual(['ad-1', 'ad-2'])
  })

  it('空 id 不记（否则会往队列里塞垃圾）', () => {
    rememberPendingClaim('')
    expect(readPendingClaims()).toEqual([])
  })

  it('补发成功后抹掉这一笔，别的不动', () => {
    rememberPendingClaim('ad-1')
    rememberPendingClaim('ad-2')
    forgetPendingClaim('ad-1')
    expect(readPendingClaims()).toEqual(['ad-2'])
  })

  it('存了非数组 / 坏 JSON → 当"没有待补"，**绝不抛**', () => {
    memory.set('ad_energy_pending', '{不是数组')
    expect(readPendingClaims()).toEqual([])
    memory.set('ad_energy_pending', { nope: true })
    expect(readPendingClaims()).toEqual([])
    memory.set('ad_energy_pending', ['ok', 123, null, ''])
    expect(readPendingClaims()).toEqual(['ok'])
  })

  it('有条数上限：坏数据不会永久占着本地存储', () => {
    for (let i = 0; i < 20; i++) rememberPendingClaim('ad-' + i)
    expect(readPendingClaims()).toHaveLength(5)
    /** ⚠️ 保留的是**最近**的几笔 —— 老的那几笔早已过了能补的时间 */
    expect(readPendingClaims()).toContain('ad-19')
  })

  it('存储写不进去（满了 / 被禁）时**不抛** —— 发奖主路不该被本地存储拖垮', () => {
    vi.stubGlobal('wx', {
      getStorageSync: () => [],
      setStorageSync: () => {
        throw new Error('storage full')
      },
    })
    expect(() => rememberPendingClaim('ad-x')).not.toThrow()
    expect(() => forgetPendingClaim('ad-x')).not.toThrow()
  })

  it('兜底文案承诺"稍后会补" —— 它必须与上面这套机制同时存在', () => {
    expect(adClaimFailedText()).toContain('补')
  })
})
