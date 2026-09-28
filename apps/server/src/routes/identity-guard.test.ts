import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ⭐⭐⭐ **凭据不是身份** —— 这条纪律必须是机器守的（用户 2026-09 定）。
 *
 *     · 身份 = `users.id`（本库自增主键）。业务表、接口、客户端手里的 id 都是它。
 *     · 凭据 = 微信 `openid` / `unionid`、`session_key`，将来的手机号 / Apple sub…
 *       它们**只允许出现在"把凭据换成 user.id"的那一层**
 *       （middleware/auth.ts + lib/token.ts），**绝不许进响应体**。
 *
 * ⚠️ 为什么值得写成测试而不是只写在注释里：
 *    "顺手把 user 整行也带上"是极自然的一步（`db.select().from(users)` 然后
 *    `c.json({ data: user })`），而它的后果不是报错 —— 是把别人的登录凭据发出去，
 *    或者让客户端某天开始拿 openid 当身份用（未来换一种登录方式就全乱）。
 *    ⇒ 两种写法都在这里拦：① 全列查 users；② 响应体里出现凭据。
 *
 * ⚠️ 白名单**必须带理由**，否则它就是"绕过检查"的开关。
 */

const SRC = new URL('../', import.meta.url).pathname
const ROUTES = path.join(SRC, 'routes')

/** 可以全列查 users 的地方 —— 每一处都要说明为什么不会把它发出去 */
const FULL_ROW_ALLOWED = new Map<string, string>([
  [
    'shop.ts',
    '下单要 session_key / openid 去签支付参数（虚拟支付的用户态签名）——' +
      '只进签名计算，响应里只有 outTradeNo 等下单结果',
  ],
])

function routeFiles(): string[] {
  return fs
    .readdirSync(ROUTES)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
}

/**
 * ⚠️⚠️ 先把注释剥掉再判 —— 这一步不能省：注释里写「openid 必须一起签进 token」
 *    是**说明**，不是泄漏；不剥的话检查会被自己的文档绊倒，然后大家把它改成白名单。
 *    （同 miniprogram 的 wxml-handlers 检查里那段教训。）
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, '')
}

/**
 * 截出每一个 `c.json( … )` 的完整片段（括号配平）。
 * ⚠️ 不能只按行扫：响应体常常是跨好几行的对象字面量。
 * ⚠️ 剥完注释再返回：里面只剩真正会被序列化出去的代码。
 */
function jsonSlices(code: string): string[] {
  const out: string[] = []
  const re = /c\.json\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    let depth = 1
    let i = m.index + m[0].length
    while (i < code.length && depth > 0) {
      const ch = code[i]
      if (ch === '(') depth++
      else if (ch === ')') depth--
      i++
    }
    out.push(stripComments(code.slice(m.index, i)))
  }
  return out
}

describe('凭据不进响应体（openid / unionid / session_key）', () => {
  it('⭐⭐ 没有一处 c.json 里出现 openid / unionid / session_key', () => {
    const bad: string[] = []
    for (const file of routeFiles()) {
      const code = fs.readFileSync(path.join(ROUTES, file), 'utf8')
      for (const slice of jsonSlices(code)) {
        /**
         * ⚠️ 只认两种**真的会把它发出去**的形态，避免误报：
         *   · **对象键**：`openid:` / `unionid:` / `sessionKey:` —— 一律违规；
         *   · **取值**：`user.openid` / `row.unionid`—— 只要它不是"喂进某个函数"。
         * ⚠️⚠️ 这一步不能省：`signToken(user.id, identity.openid)` 里的
         *    `identity.openid` 是**喂进签名函数**（凭据必须进 token），不是发出去 ——
         *    机器分不清这两者的话，这条检查就会逼着人去写白名单，然后白名单越长越没人看。
         *    判据：取值后面紧跟 `,` 或 `)` 的，按"函数实参"放过。
         */
        const asKey = /(^|[{,\s])(openid|unionid|sessionKey|session_key)\s*:/.test(slice)
        const asValue = /\.\s*(openid|unionid|sessionKey|session_key)\b(?!\s*[,)])/.test(slice)
        if (asKey || asValue) {
          bad.push(file + ' → ' + slice.replace(/\s+/g, ' ').slice(0, 120))
        }
      }
    }
    expect(bad).toEqual([])
  })

  it('⭐ 除白名单外，没有地方 `db.select().from(users)` 整行取账号', () => {
    const bad: string[] = []
    for (const file of routeFiles()) {
      const code = fs.readFileSync(path.join(ROUTES, file), 'utf8')
      const fullRow = /db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(users\)/.test(code)
      if (fullRow && !FULL_ROW_ALLOWED.has(file)) bad.push(file)
    }
    expect(bad).toEqual([])
  })

  it('⚠️ 白名单里的每一处都还真的存在（过期条目要删掉，否则它会掩护将来的新增）', () => {
    for (const file of FULL_ROW_ALLOWED.keys()) {
      const code = fs.readFileSync(path.join(ROUTES, file), 'utf8')
      expect(/db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(users\)/.test(code)).toBe(true)
    }
  })
})
