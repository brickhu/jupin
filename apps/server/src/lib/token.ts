import crypto from 'node:crypto'
import { env } from '../env'

/**
 * 极简签名 token（微信 openid 已保证身份，这里只需防篡改与会话保持）。
 *
 * ⚠️⚠️ **载荷里必须有 openid，不能只有 userId。**
 *
 *    只放 userId 的话，这个 token 就**只在那一行数据还在时**有效：
 *    账号一旦被删（清库、换环境、误删），token 立刻变成一张废纸 ——
 *    而身份其实还在（微信那一侧的 openid 没变）。
 *    "没有就创建用户"这件事也就无从谈起：手里只有一个指向虚空的 id。
 *
 *    带上 openid 之后，token 表达的是**你是谁**（openid），而不是
 *    "你是数据库里第几行"。行没了，按 openid 再建一行就行。
 */
export interface TokenPayload {
  userId: number
  /**
   * ⚠️ 可空：**这次改动之前签发的老 token 里没有它**。
   *    调用方必须能降级处理（退回按 userId 查），否则所有在线用户会被就地登出。
   */
  openid?: string
  iat: number
}

export function signToken(userId: number, openid: string): string {
  const payload = Buffer.from(JSON.stringify({ userId, openid, iat: Date.now() })).toString('base64url')
  const sig = crypto.createHmac('sha256', env.TOKEN_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifyToken(token: string): TokenPayload | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', env.TOKEN_SECRET).update(payload).digest('base64url')
  // ⚠️ 长度不等时 timingSafeEqual 会**抛异常**（而不是返回 false），必须先挡一道
  if (sig.length !== expected.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenPayload
    if (typeof parsed.userId !== 'number') return null
    return parsed
  } catch {
    return null
  }
}
