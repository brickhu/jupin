import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'

export type User = typeof users.$inferSelect

/**
 * 按 openid 取用户，没有就建。
 *
 * ⭐ 这是「打开即已登录」的落点：小程序用户没有注册、没有密码、没有验证码。
 *
 * ⚠️ 两个 MySQL 特有的坑：
 *   ① 没有 INSERT ... RETURNING，拿不到刚插入的行，只能回查；
 *   ② 首登并发时两个请求会同时插入、撞 openid 唯一键 ——
 *      用 INSERT IGNORE 让其中一个静默失败，之后统一回查。
 */
export async function getOrCreateUserByOpenid(openid: string): Promise<User> {
  const [existing] = await db.select().from(users).where(eq(users.openid, openid)).limit(1)
  if (existing) return existing

  // ⚠️ ignore() 在 MySqlInsertBuilder 上，必须在 .values() **之前**调用。
  await db.insert(users).ignore().values({ openid, nextFreeAt: new Date(0) })

  const [created] = await db.select().from(users).where(eq(users.openid, openid)).limit(1)
  if (!created) throw new Error(`创建用户失败: ${openid}`)
  return created
}
