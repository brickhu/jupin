import { describe, expect, it } from 'vitest'

import { computeNavMetrics } from './nav'

/**
 * 导航栏尺寸的边界。
 *
 * ⚠️ 这些边界在真机上的表现全都是「位置不对」，而不是报错 ——
 *    所以只能在这里钉死。
 */
describe('computeNavMetrics', () => {
  it('正常设备：内容区高度 = 胶囊高 + 上下留白', () => {
    // 刘海机：状态栏 44，胶囊 top 48 / 高 32 → 上下各留 4
    const m = computeNavMetrics({
      statusBarHeight: 44,
      capsule: { top: 48, height: 32, width: 87 },
    })
    expect(m.statusBarHeight).toBe(44)
    expect(m.navBarHeight).toBe(40)
    expect(m.totalHeight).toBe(84)
    expect(m.sideWidth).toBe(87)
  })

  it('胶囊返回全 0（开发者工具刚启动 / 低版本基础库）→ 走兜底，不能出负高度', () => {
    const m = computeNavMetrics({ statusBarHeight: 44, capsule: { top: 0, height: 0, width: 0 } })
    expect(m.navBarHeight).toBe(44)
    expect(m.totalHeight).toBe(88)
    expect(m.sideWidth).toBe(87)
  })

  it('胶囊缺失（接口不存在）→ 同样兜底', () => {
    expect(computeNavMetrics({ statusBarHeight: 20 }).navBarHeight).toBe(44)
    expect(computeNavMetrics({ statusBarHeight: 20, capsule: null }).navBarHeight).toBe(44)
  })

  it('状态栏高度缺失 / 非法 → 用 20', () => {
    expect(computeNavMetrics({}).statusBarHeight).toBe(20)
    expect(computeNavMetrics({ statusBarHeight: 0 }).statusBarHeight).toBe(20)
    expect(computeNavMetrics({ statusBarHeight: -5 }).statusBarHeight).toBe(20)
    expect(computeNavMetrics({ statusBarHeight: Number.NaN }).statusBarHeight).toBe(20)
  })

  it('异常大的胶囊高度被夹住 —— 否则导航栏会吃掉半个屏幕', () => {
    const m = computeNavMetrics({
      statusBarHeight: 20,
      capsule: { top: 200, height: 200, width: 87 },
    })
    expect(m.navBarHeight).toBe(96)
  })

  it('异常小的胶囊高度被夹住 —— 否则标题会贴到状态栏上', () => {
    const m = computeNavMetrics({
      statusBarHeight: 20,
      capsule: { top: 21, height: 1, width: 87 },
    })
    expect(m.navBarHeight).toBe(28)
  })

  it('胶囊宽度异常时用兜底宽度（标题居中靠它）', () => {
    expect(
      computeNavMetrics({ statusBarHeight: 20, capsule: { top: 24, height: 32, width: 0 } })
        .sideWidth,
    ).toBe(87)
    expect(
      computeNavMetrics({ statusBarHeight: 20, capsule: { top: 24, height: 32, width: 999 } })
        .sideWidth,
    ).toBe(87)
  })
})
