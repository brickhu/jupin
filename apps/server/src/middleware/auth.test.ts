import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'
import { authMiddleware, type Variables } from './auth'

/**
 * ⭐⭐ 「用户在使用任何业务数据之前，必须已经在我们库里有一行」这条不变量，
 *     由这个中间件保证 —— 它是**全站唯一的注册点**。
 *
 * ⚠️ 这条不变量最容易在一件很平常的事上破掉：**加一个新路由，忘了挂鉴权**。
 *    那一刻没有任何东西会报错 —— 接口能用、数据能出，只是谁都能读别人的。
 *    所以这里用两把锁把它钉住：
 *      ① 行为：没有身份 → 401，根本进不到路由（下面三个用例）
 *      ② 结构：/api 下每一个业务前缀都必须挂上它（扫 index.ts 源码）
 *
 * ⚠️ 刻意**不 import ../index.ts** —— 那个模块在导入时就 serve() 了。
 */

describe('authMiddleware —— 没有身份就没有业务数据', () => {
  const app = new Hono<{ Variables: Variables }>()
  app.use('/api/thing/*', authMiddleware)
  app.get('/api/thing/x', (c) => c.json({ ok: true, data: c.get('userId') }))

  it('⭐ 完全不带凭据 → 401（不存在"匿名但拿到 userId"的路径）', async () => {
    const res = await app.request('/api/thing/x')
    expect(res.status).toBe(401)
  })

  it('⚠️ 只写 x-wx-openid、没有 x-wx-source → 仍然 401', async () => {
    // 公网请求不携带任何 x-wx-* header。只看 openid 的话，
    // 任何人手写一个 header 就能冒充任意用户 —— 这是本文件唯一的安全要害。
    const res = await app.request('/api/thing/x', { headers: { 'x-wx-openid': 'o_fake' } })
    expect(res.status).toBe(401)
  })

  it('⚠️ token 无效 → 401（不是 500，也不是放行）', async () => {
    const res = await app.request('/api/thing/x', { headers: { Authorization: 'Bearer nonsense' } })
    expect(res.status).toBe(401)
    expect(((await res.json()) as { error: string }).error).toBe('登录已过期')
  })
})

/* ------------------------------------------------------------------ */
/* 结构锁：每个 /api 业务前缀都必须挂 authMiddleware，且挂在 route 之前    */
/* ------------------------------------------------------------------ */

const SOURCE = readFileSync(fileURLToPath(new URL('../index.ts', import.meta.url)), 'utf8')

interface Hit {
  path: string
  line: number
}

function scan(re: RegExp): Hit[] {
  const out: Hit[] = []
  const rx = new RegExp(re.source, 'g')
  let m: RegExpExecArray | null
  while ((m = rx.exec(SOURCE)) !== null) {
    out.push({ path: m[1] as string, line: SOURCE.slice(0, m.index).split('\n').length })
  }
  return out
}

const ROUTES = scan(/app\.route\('(\/api\/[a-z-]+)'/)
const GUARDS = scan(/app\.use\('(\/api\/[a-z-]+)\/\*',\s*authMiddleware\)/)

/** 唯一允许不鉴权的 /api 前缀：登录入口本身（它要拿 code 换 token）。 */
const PUBLIC_PREFIXES = new Set(['/api/auth'])

describe('业务路由的鉴权覆盖 —— 「先注册，再用业务数据」', () => {
  it('扫到了路由（别让正则悄悄失配，那会让下面几条变成空转）', () => {
    expect(ROUTES.length).toBeGreaterThan(4)
  })

  it('⭐ 每个 /api 业务前缀都挂了 authMiddleware，且写在 app.route 之前', () => {
    for (const route of ROUTES) {
      if (PUBLIC_PREFIXES.has(route.path)) continue
      const guard = GUARDS.find((g) => g.path === route.path)
      expect(guard, route.path + ' 没有挂 authMiddleware').toBeTruthy()
      // ⚠️ 顺序也要管：Hono 按注册顺序匹配，挂在后面等于没挂
      expect(guard!.line, route.path + ' 的 authMiddleware 必须在 app.route 之前').toBeLessThan(
        route.line,
      )
    }
  })

  it('⚠️ 没有多余的鉴权（挂在一个不存在的路由上 = 以为守住了，其实没守）', () => {
    const routed = new Set(ROUTES.map((r) => r.path))
    for (const guard of GUARDS) {
      expect(routed.has(guard.path), guard.path + ' 挂了 authMiddleware 但没有对应路由').toBe(true)
    }
  })

  it('⚠️ /api/auth 是唯一公开的 /api 前缀', () => {
    const unguarded = ROUTES.map((r) => r.path)
      .filter((p) => !PUBLIC_PREFIXES.has(p))
      .filter((p) => !GUARDS.some((g) => g.path === p))
    expect(unguarded).toEqual([])
  })
})
