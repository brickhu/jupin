import { readFileSync } from 'node:fs'
import { dayNumber } from '@jushuo/shared'
import { describe, expect, it } from 'vitest'

import { seededRng, weightedPick } from './recommend'

const SRC = readFileSync(new URL('./recommend.ts', import.meta.url), 'utf-8')
  .split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*')
  })
  .join('\n')

/**
 * ⭐⭐ 守的是**游客的「今日推荐」按天确定**（用户 2026-10-15：
 *    「今日挑战在单个自然日内应该是固定的」）。
 *
 * ⚠️⚠️ 根因：`pickAnonymousArticle` 原来走 `weightedPick(pool, weights)`（默认 `Math.random`）
 *    ⇒ **每次调用换一句** ⇒ 同一个游客刷新一次首页就换一句，
 *    "今日推荐"对游客根本不成立，首页那张卡也"老变"。
 * ⚠️ 现在用**服务端当天的天号**当种子：同一天所有人同一句、跨天才换，
 *    而"按参与人数加权（偏热门）"的意图**保留** —— 只是同一天里这件事不再抖。
 */
describe('游客的今日推荐：按天确定', () => {
  const pool = ['a', 'b', 'c', 'd', 'e']
  const weights = [3, 0, 5, 1, 2]

  it('⭐⭐ 同一个种子 ⇒ 同一串随机数（谁调、调几次都一样）', () => {
    const one = seededRng(dayNumber('2026-10-15'))
    const two = seededRng(dayNumber('2026-10-15'))
    const a = [one(), one(), one()]
    const b = [two(), two(), two()]
    expect(a).toEqual(b)
    expect(a.every((v) => v >= 0 && v < 1)).toBe(true)
  })

  it('⭐⭐ 同一天抽两次 ⇒ 同一句（无状态，不靠调用方缓存）', () => {
    const day = '2026-10-15'
    const pick = () => weightedPick(pool, weights, seededRng(dayNumber(day)))
    expect(pick()).toBe(pick())
  })

  it('⭐ 换一天**会**换句（不是"永远挑第一条"那种假确定）', () => {
    const picks = new Set(
      Array.from({ length: 14 }, (_, i) => {
        const day = '2026-10-' + String(i + 1).padStart(2, '0')
        return weightedPick(pool, weights, seededRng(dayNumber(day)))
      }),
    )
    expect(picks.size, '两周里只有一句 ⇒ 种子没起作用（等于写死）').toBeGreaterThan(1)
  })

  it('⭐⭐ 实现里不许再用默认的 Math.random（那正是"老变"的来源）', () => {
    const i = SRC.indexOf('export async function pickAnonymousArticle')
    expect(i, '找不到 pickAnonymousArticle').toBeGreaterThan(-1)
    const body = SRC.slice(i, SRC.indexOf('\n}', i))
    expect(body.includes('seededRng(dayNumber(date))'), '没用当天种子 ⇒ 游客每次刷新都换一句').toBe(true)
    /** 反向：那一行不许再是"不传 rng"的调用 */
    expect(/weightedPick\(pool, weights\)/.test(body), '又走回默认 Math.random 了').toBe(false)
  })
})
