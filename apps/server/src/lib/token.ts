import crypto from 'node:crypto'
import { env } from '../env'

/** 极简签名 token（微信 openid 已保证身份，这里只需防篡改与会话保持） */
export function signToken(userId: number): string {
  const payload = Buffer.from(JSON.stringify({ userId, iat: Date.now() })).toString('base64url')
  const sig = crypto.createHmac('sha256', env.TOKEN_SECRET).update(payload).digest('base64url')
  return `${payload}.${sig}`
}

export function verifyToken(token: string): { userId: number } | null {
  const [payload, sig] = token.split('.')
  if (!payload || !sig) return null
  const expected = crypto.createHmac('sha256', env.TOKEN_SECRET).update(payload).digest('base64url')
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { userId: number }
  } catch {
    return null
  }
}
