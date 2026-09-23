import { randomBytes } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { env } from '../env'

export type User = typeof users.$inferSelect

/**
 * ⭐ 本地联调账号直接发一大笔能量 —— 远到用不完。
 *
 * ⚠️ 以前这里发的是**会员**（每天 50 次额度）。额度整体换成能量之后，
 *    "发会员"这条路不通了：能量是**余额**，不是身份。
 *    不发的话本地只有 3 点，读一次扣 2 点 —— 什么都测不了。
 */
const DEV_ENERGY = 9999

/**
 * 这是不是一个「本地联调环境」—— 是的话，账号一律给会员。
 *
 * ⚠️⚠️ 为什么这件事必须做进服务端，而不是靠 `tools/dev-unlock.mjs` 手动跑一次：
 *    手动脚本只能覆盖「它跑的那一刻已经存在」的账号，之后新建的照样没有会员，
 *    于是测试到一半突然被告知「今天的挑战次数用完了」。
 *    这件事**真实发生过**，而且极难排查 —— 报错看起来像额度逻辑被改坏了，
 *    实际上是账号刚出生。凡是「靠人工记得跑一次」的开关，迟早会忘。
 *
 * ⚠️ 判据只有**一条**：NODE_ENV 不是 production。
 *
 *    以前还要求"openid 以 dev_ 开头"，那是建立在"本地用合成 openid"之上的。
 *    现在本地走的是**真实登录**（模拟器里 wx.login 给的 code 也是真的，
 *    换回来就是开发者本人微信账号的真实 openid，见 routes/auth.ts），
 *    真实 openid 当然没有 dev_ 前缀 —— 按前缀判断会让本地账号
 *    全部掉回免费档（每天 1 次），本地根本没法测。
 *
 *    ⚠️ 生产环境这条永远不成立，所以它不可能泄漏到线上。
 */
function isLocalDevEnv(): boolean {
  return env.NODE_ENV !== 'production'
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
  if (!isLocalDevEnv()) return user

  if (user.energy >= DEV_ENERGY) return user

  await db.update(users).set({ energy: DEV_ENERGY }).where(eq(users.id, user.id))
  return { ...user, energy: DEV_ENERGY }
}

/**
 * ⭐ 生成一个分享标识 —— 24 位十六进制，与 submissions.id 同一种形状。
 * ⚠️ 必须用 randomBytes 而不是 Math.random：它是**凭据**，可猜就等于公开。
 */
export function newShareKey(): string {
  return randomBytes(12).toString('hex')
}

/**
 * 给还没有分享标识的用户补一个（已有就原样返回，一次库都不碰）。
 *
 * ⚠️ 为什么不能只靠建号时生成：这一列是**后加的** —— 迁移能回填存量行，
 *    但任何绕过建号那条路的行（种子脚本直接 insert、将来别处再插）都会是 NULL，
 *    而 NULL 的人分享不出去。挂在「每次取用户」这条必经之路上，
 *    就不需要谁记得跑一次补数脚本。
 */
export async function ensureShareKey(user: User): Promise<string> {
  if (user.shareKey) return user.shareKey
  const key = newShareKey()
  await db.update(users).set({ shareKey: key }).where(eq(users.id, user.id))
  return key
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
  if (existing) {
    // ⚠️ 老行 / 种子行可能是 NULL —— 补上，再用同一份返回值往下走
    const shareKey = await ensureShareKey(existing)
    return withLocalDevPrivilege({ ...existing, shareKey })
  }

  await db.insert(users).ignore().values({
    openid,
    // ⭐ 建号时就把分享标识与本地能量发好，省掉一次 UPDATE
    shareKey: newShareKey(),
    ...(isLocalDevEnv() ? { energy: DEV_ENERGY } : {}),
  })

  const [created] = await db.select().from(users).where(eq(users.openid, openid)).limit(1)
  if (!created) throw new Error(`创建用户失败: ${openid}`)
  return withLocalDevPrivilege(created)
}
