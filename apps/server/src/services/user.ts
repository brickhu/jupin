import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { env } from '../env'

export type User = typeof users.$inferSelect

/**
 * ⭐ 本地联调账号的会员到期时间 —— 远到不用再续。
 */
const DEV_MEMBER_UNTIL = new Date('2099-01-01T00:00:00Z')

/**
 * 判断这是不是一个「本地联调账号」。
 *
 * ⚠️⚠️ 为什么这件事必须做进服务端，而不是靠 `tools/dev-unlock.mjs` 手动跑一次：
 *    开发者工具**每次登录都可能创建一个全新的 `dev_*` 账号`
 *    （见 routes/auth.ts：开发环境直接拿 code 当伪 openid）。
 *    手动脚本只能覆盖「它跑的那一刻已经存在」的账号 ——
 *    之后新建的账号照样没有会员，于是测试到一半突然被告知「挑战冷却中」。
 *
 *    这件事**真实发生过**，而且极难排查：报错看起来像是冷却逻辑被改坏了，
 *    实际上是账号是新的、用户根本不知道自己在用一个刚出生的账号。
 *    凡是「靠人工记得跑一次」的开关，迟早会忘 —— 所以把它变成不变量。
 *
 * 判据是**两道**，缺一不可：
 *   ① NODE_ENV 不是 production —— 生产环境一律不认，这条是硬闸
 *   ② openid 以 `dev_` 开头 —— 只有本地登录路径（routes/auth.ts）会造出这种 openid
 *
 * ⚠️ 光看前缀不够：微信真实 openid 的字符集也含下划线，
 *    理论上存在以 `dev_` 开头的真实用户。加上 ① 就彻底排除了。
 */
function isLocalDevAccount(openid: string): boolean {
  return env.NODE_ENV !== 'production' && openid.startsWith('dev_')
}

/**
 * 把本地联调账号补成会员。
 *
 * ⚠️ 它挂在**每次取用户**的路径上，所以不只是新账号，
 *    历史上已经建好的旧账号也会在下次请求时被自动修好 —— 不需要再手动跑脚本。
 *
 * ⚠️ 有 already 短路，不会每个请求都写库。
 */
async function withLocalDevPrivilege(user: User): Promise<User> {
  if (!isLocalDevAccount(user.openid)) return user

  const alreadyMember = user.memberUntil !== null && user.memberUntil.getTime() >= DEV_MEMBER_UNTIL.getTime()
  if (alreadyMember) return user

  await db.update(users).set({ memberUntil: DEV_MEMBER_UNTIL }).where(eq(users.id, user.id))
  return { ...user, memberUntil: DEV_MEMBER_UNTIL }
}

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
  if (existing) return withLocalDevPrivilege(existing)

  await db.insert(users).ignore().values({
    openid,
    // ⭐ 建号时就带上会员，省掉一次 UPDATE
    ...(isLocalDevAccount(openid) ? { memberUntil: DEV_MEMBER_UNTIL } : {}),
  })

  const [created] = await db.select().from(users).where(eq(users.openid, openid)).limit(1)
  if (!created) throw new Error(`创建用户失败: ${openid}`)
  return withLocalDevPrivilege(created)
}
