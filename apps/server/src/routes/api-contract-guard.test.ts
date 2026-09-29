import fs from 'node:fs'
import path from 'node:path'

import { OpenAPIHono } from '@hono/zod-openapi'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐ **接口契约守门**：两个客户端（小程序 / admin 工具）调用的**每一条路径**，
 *     都必须在服务端生成的 OpenAPI spec 里存在。
 *
 * ⚠️⚠️ 为什么需要它（用户定的"接口工作做完再校准端侧"的**机器化**形式）：
 *     手工对齐靠记性 —— 服务端删一条路由（比如 `/api/schedules` 那次），
 *     客户端还照着调，直到真机上才报错。这里把它变成一条会红的测试。
 *
 * ⚠️ spec 是**从真实挂载表生成**的（解析 `index.ts` 的 `app.route(前缀, 标识符)`），
 *    不是另抄一份列表 —— 挂载变了，这个测试跟着变。
 */

const ROOT = path.resolve(__dirname, '../../../..')
const INDEX = path.join(ROOT, 'apps/server/src/index.ts')
const CLIENTS = [
  path.join(ROOT, 'apps/miniprogram/src/lib/api/client.ts'),
  path.join(ROOT, 'tools/admin/server.ts'),
]

/**
 * ⚠️⚠️ `tools/admin/server.ts` **自己也是一个 Node 服务**（它有 `/api/login`、`/api/envs`
 *    这些**属于它自己**的路由，还有 `require('…/lib/api/cloudapiDirect')` 这种包路径）。
 *    ⇒ 对它只收 `/api/admin/*`：那才是它调**我们服务端**的部分。
 */
const OWN_PREFIX: Record<string, string> = {
  'server.ts': '/api/admin',
}

/** 把 `:id` 归一成 `{id}`，方便和 spec 里的路径比 */
const normalize = (p: string) => p.replace(/:([A-Za-z_]\w*)/g, '{$1}').replace(/\/+$/, '')

/** 从 index.ts 解析真实挂载表：前缀 → 标识符 → 模块 */
function mountsOf() {
  const src = fs.readFileSync(INDEX, 'utf8')
  const identModule = new Map<string, string>()
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(\.\/routes\/[^']+)'/g)) {
    const rel = m[2].replace(/^\.\//, '')
    for (const raw of m[1].split(',')) {
      const ident = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (ident) identModule.set(ident, rel)
    }
  }
  const out: { prefix: string; ident: string; module: string }[] = []
  for (const m of src.matchAll(/app\.route\(\s*'([^']+)'\s*,\s*(\w+)\s*\)/g)) {
    const module = identModule.get(m[2])
    if (module) out.push({ prefix: m[1], ident: m[2], module })
  }
  return out
}

/** 用一个"只有注册表"的 app 生成 spec（不启服务、不连库） */
async function buildSpecPaths(): Promise<Set<string>> {
  const app = new OpenAPIHono()
  for (const mount of mountsOf()) {
    const mod = (await import(path.join(ROOT, 'apps/server/src', mount.module))) as Record<string, unknown>
    const sub = mod[mount.ident]
    if (!sub) throw new Error(`挂载表里的 ${mount.ident} 在 ${mount.module} 里找不到`)
    // route() 会合并子应用的注册表（见 @hono/zod-openapi 的实现）—— 正是它在产文档
    app.route(mount.prefix, sub as never)
  }
  const doc = app.getOpenAPI31Document({
    openapi: '3.1.0',
    info: { title: 'jushuo API', version: '1.0.0' },
  }) as { paths?: Record<string, unknown> }
  return new Set(Object.keys(doc.paths ?? {}).map(normalize))
}

/**
 * 客户端源码里出现的所有 `/api/...`（含 `/media/...`）字面量。
 *
 * ⚠️⚠️ 必须先**剥掉注释与 import 语句**，否则会收进一堆假路径
 *    （实测踩到：`'/api/cloudapiDirect'` 是 npm 包的 import 路径、
 *      `/api/admin/*` 出现在注释里）—— 那样这条守门就会变成"狼来了"。
 */
function clientPaths(): { file: string; literal: string }[] {
  const out: { file: string; literal: string }[] = []
  for (const file of CLIENTS) {
    const cleaned = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')      // 块注释
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')    // 行注释（避开 http:// 里的 //）
      .replace(/^\s*import[\s\S]*?from\s*['"][^'"]+['"]\s*$/gm, '') // import ... from '...'
      .replace(/^\s*\}?\s*from\s*['"][^'"]+['"]\s*$/gm, '')        // 多行 import 的收尾
      .replace(/require\(\s*['"][^'"]+['"]\s*\)/g, '')            // require('…/lib/api/x') 这种包路径
    for (const m of cleaned.matchAll(/['"`](\/(?:api|media)\/[^'"`\s]*)['"`]/g)) {
      // 去掉查询串：接口按路径匹配，参数是运行时拼的
      const literal = m[1].split('?')[0] ?? ''
      const name = path.basename(file)
      const own = OWN_PREFIX[name]
      if (!literal) continue
      // ⚠️ 只收"调我们服务端"的路径（admin 工具自己的路由不收）
      if (own && !literal.startsWith(own)) continue
      out.push({ file: name, literal })
    }
  }
  return out
}

describe('接口契约 —— 两个客户端调的路径都在 spec 里', () => {
  it('没有"客户端在调、服务端却没有"的路径（删路由不再静默打断端侧）', async () => {
    const spec = await buildSpecPaths()
    const missing: string[] = []
    for (const { file, literal } of clientPaths()) {
      const key = normalize(literal)
      /**
       * ⚠️ 端侧大量用「前缀 + 拼接」（`'/api/user/favorites/' + articleId`），
       *    所以前缀形态要按"有路径以它开头"来判。
       */
      const hit =
        spec.has(key) ||
        [...spec].some((p) => p === key || p.startsWith(key + '/') || (literal.endsWith('/') && p.startsWith(key + '/')))
      if (!hit) missing.push(`${file} → ${literal}`)
    }
    expect(
      [...new Set(missing)],
      '这些路径客户端在调、但服务端 spec 里没有（服务端删/改了路由？）：\n' + missing.join('\n'),
    ).toEqual([])
  })

  it('spec 里的每条路径都至少有一个客户端在用，或是明确的服务端专用（无死接口）', async () => {
    const spec = await buildSpecPaths()
    const used = new Set(clientPaths().map((c) => normalize(c.literal)))
    /**
     * ⚠️ 这几个**故意没有客户端**（列出来是为了让"新增死接口"必须显式登记）：
     *    · `/media/*`        —— 由 <audio src> 直接播，不走 client.ts 的 request()
     *    · `/api/pay/notify` —— 支付平台回调
     *    · `/api/auth/session` —— 只在刷新 session_key 时按需调（client 里是拼出来的）
     *    · `/health`、`/api/openapi.json`、`/api/docs` —— 运维/文档自身
     */
    const serverOnly = [
      '/media',
      '/api/pay/notify',
      '/api/auth/session',
      '/health',
      '/api/openapi.json',
      '/api/docs',
    ]
    const orphans = [...spec].filter((p) => {
      if (serverOnly.some((s) => p === s || p.startsWith(s + '/'))) return false
      return ![...used].some((u) => p === u || u.startsWith(p + '/') || p.startsWith(u + '/'))
    })
    expect(orphans, '这些接口没有任何客户端在用（要么删掉，要么在上面登记为服务端专用）：\n' + orphans.join('\n')).toEqual([])
  })
})
