import crypto from 'node:crypto'
import { env } from '../env'

/**
 * 极简签名 token（微信 openid 已保证身份，这里只需防篡改与会话保持）。
 *
 * ⚠️⚠️⚠️ **我们是自己的账号体系，微信的 openid 只是"一种凭据"**（用户 2026-09 定：
 *    "不要拿 openid 当成我们库里的 userid，未来可能还有其他方式登录"）。
 *
 *    · `users.id`（本库自增主键）才是身份 —— 所有业务表、所有接口、
 *      客户端手里的那个 id，**都必须是它**；
 *    · `openid` / `unionid` / 将来的手机号 / apple-sub… 是**登录凭据**，
 *      只允许出现在"把凭据换成 user.id"的那一层（middleware/auth.ts），
 *      业务代码与响应体里**不许出现**。
 *
 * ⚠️ 载荷里仍然要带凭据（现在就是 openid），但它的角色是**凭证**，不是身份：
 *    它的用处是"这一行数据没了也能按凭据再建回来"（清库 / 换环境 / 误删之后自愈）。
 *
 * ⚠️⚠️ `userId` 在载荷里**只是可观测性**，鉴权**不认它** ——
 *    它是**签发那一刻**我们库里的行号，而那一行可能已经被删、自增 id 还可能被复用：
 *    拿它当身份 = 有概率把请求认成**另一个人**（静默串号）。
 *    所以 resolveUser 只按凭据解析；`userId` 只用于日志与排查。
 */
export interface TokenPayload {
  /** ⚠️ 仅用于日志/排查，**鉴权不认它**（见文件头：静默串号的风险） */
  userId: number
  /**
   * 登录凭据（当前只有微信这一种，将来可能有手机号 / Apple…）。
   * ⚠️ 老 token（加它之前签发的）里没有 —— 那种只能**强制重新登录**，
   *    退回按 userId 查会静默把请求认成另一个人（见文件头）。
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
