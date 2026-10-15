import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * 静态断言用：首页源码（剥注释 —— 否则"解释这条规则的注释"会自己触发）。
 */
const SRC = readFileSync(new URL('./index.ts', import.meta.url), 'utf-8')
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  .join('\n')

/** 取方法体（按 4 空格缩进的结尾 `},` 收） */
function bodyOf(name: string): string {
  const i = SRC.indexOf('async ' + name + '()')
  expect(i, '找不到 ' + name).toBeGreaterThan(-1)
  return SRC.slice(i, SRC.indexOf('\n  },', i))
}

/**
 * ⭐⭐ 守的是**「今日挑战」是当天/本次打开固定的**（用户 2026-10-15 报的"这张卡老变"）。
 *
 * ⚠️⚠️ 根因：`loadToday()` 原来**每次都问服务端**，而服务端对**匿名**用户是
 *    「初级档里随机 + 按参与人数加权挑一条」⇒ 问一次换一句（首屏 / onShow / 下拉 / 重试都会问）。
 *    ⭐ 而 store 里**一直有按天缓存**（`cachedToday()`）—— 从来没被查过。
 *
 * ⚠️ 两层都要有，缺一层就会在某个场景下漏：
 *   ① **会话内**：`this.cards.today` 有值就直接用（不依赖任何日期比较）；
 *   ② **跨会话**：`cachedToday()` 按天缓存（服务端 `date` == 本地自然日）。
 */
describe('今日卡的稳定性', () => {
  it('⭐⭐ loadToday 必须先查缓存/会话内钉住，再考虑请求', () => {
    const body = bodyOf('loadToday')
    /**
     * ⚠️ 断言**确切写法**，不只看"这两句出现过"：
     *    第一版只比位置 + 数 return，于是把条件改成 `if (false && …)`（等于关掉）
     *    照样通过 —— 那种守门等于没有（注入验证时发现的）。
     */
    expect(body.includes('if (this.cards?.today) {'), '会话内的钉住条件被改坏/关掉了').toBe(true)
    expect(body.includes('if (cached) {'), '按天缓存的条件被改坏/关掉了').toBe(true)

    const pin = body.indexOf('if (this.cards?.today) {')
    const cache = body.indexOf('if (cached) {')
    const fetch = body.indexOf('await fetchToday()')
    expect(fetch, '找不到 fetchToday').toBeGreaterThan(-1)
    expect(pin, '会话内钉住必须在请求之前').toBeLessThan(fetch)
    expect(cache, '按天缓存必须在请求之前').toBeLessThan(fetch)
    /** 两条提前返回都要真的 return（否则会一路走到 fetch） */
    const early = body.slice(pin, fetch)
    expect((early.match(/\breturn\b/g) ?? []).length, '命中缓存后没 return ⇒ 照样会再问一次').toBeGreaterThanOrEqual(2)
  })
})
