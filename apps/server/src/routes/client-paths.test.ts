import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐ 端侧请求路径 vs 服务端挂载点 —— 一道「改名只改了一边」的守卫。
 *
 * ⚠️⚠️ 为什么必须有它：把 /share/* 改成 /api/* 那次，服务端与端侧必须同时改，
 *    而 **tsc 看不见字符串路径** —— 漏一处就是一整页 404，且只有真机才发现。
 *    CI 里 354 条测试当时全绿，却没有任何一条盯着这件事。
 *
 * ⚠️ 做法是**最笨也最稳**的：把 client.ts 里所有 /api/<x> 字面量抠出来，
 *    逐个看它的一级前缀在 index.ts 里有没有对应的 app.route / app.use。
 *    不校验参数与语义 —— 而漏改恰恰总是整段前缀。
 */
const CLIENT = readFileSync(
  new URL('../../../miniprogram/src/lib/api/client.ts', import.meta.url),
  'utf8',
)
const INDEX = readFileSync(new URL('../index.ts', import.meta.url), 'utf8')

describe('端侧请求路径 vs 服务端挂载', () => {
  it('client.ts 里每个 /api/<x> 前缀，index.ts 里都有 app.route / app.use', () => {
    const paths = new Set([...CLIENT.matchAll(/'\/api\/[a-z-]+/g)].map((m) => m[0].slice(1)))
    expect(paths.size, '一个都没扫到 —— 正则失配，这条测试会变成空转').toBeGreaterThan(5)

    const mounts = new Set(
      [...INDEX.matchAll(/app\.(?:route|use)\('(\/api\/[a-z-]+)/g)].map((m) => m[1]!),
    )
    const missing = [...paths].filter((p) => !mounts.has(p))
    expect(missing, '端侧在请求这些前缀，服务端没有对应挂载：' + missing.join(' ')).toEqual([])
  })
})
