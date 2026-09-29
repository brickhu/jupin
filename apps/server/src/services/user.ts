import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db } from '../db'
import { users } from '../db/schema'
import { env } from '../env'
import { ENERGY_REASON, grantEnergy } from './energy'

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
 * 这是不是一个「本地联调环境」—— 是的话，账号补满能量。
 *
 * ⚠️⚠️ 判据是**显式开关** `DEV_ENERGY_TOPUP`，默认关。
 *
 *    旧判据「NODE_ENV !== 'production'」的失败模式极其危险：线上只要漏配 /
 *    换镜像 / CI 覆盖了 NODE_ENV，**全站每个用户立刻白拿 9999 点**
 *    （付费资源变免费，而且这个判据本身不可审计）。
 *    新判据的失败模式是「没人写这一行 ⇒ 什么都不发生」—— 本地少个便利而已。
 *    两者风险量级不对称，所以默认必须落在「什么都不发生」那一侧。
 *
 * ⚠️ 要开只能在 .env.local 里显式写 `DEV_ENERGY_TOPUP=true`，
 *    它不会再因为 NODE_ENV / 镜像 / CI 的任何一次漏配而自动生效。
 *
 * ⚠️⚠️ 为什么这件事必须做进服务端，而不是靠 `tools/dev-unlock.mjs` 手动跑一次：
 *    手动脚本只能覆盖「它跑的那一刻已经存在」的账号，之后新建的照样没有能量，
 *    于是测试到一半突然被告知「能量不够」。这件事**真实发生过**，而且极难排查。
 *    凡是「靠人工记得跑一次」的开关，迟早会忘。
 */
function devEnergyTopUpEnabled(): boolean {
  return env.DEV_ENERGY_TOPUP
}

/**
 * 把本地联调账号补满能量 —— **走账本，不直写余额**。
 *
 * ⚠️ 它挂在**每次取用户**的路径上，所以不只是新账号，
 *    历史上已经建好的旧账号也会在下次请求时被自动补上 —— 不需要再手动跑脚本。
 *
 * ⚠️⚠️ 旧实现 `UPDATE users SET energy=9999` 绕过 energy_ledger，余额与流水
 *    结构上可永久漂移（本机实测：余额合计 10000、流水合计 -15）。现在一律走
 *    `grantEnergy` → `addEnergy`（能量唯一写入方），缓存与流水在**同一个事务**里写，
 *    从结构上杜绝漂移。
 *
 * ⚠️ 保留「余额已经够就不动」的短路：否则每个请求都会写一条流水。
 *
 * ⚠️ refId 每次补满都不同。幂等键 (reason, refType, refId, userId) 会拒绝重复的
 *    refId；若把 refId 固定（或写成补满前的余额），用户花掉、再回到同一余额时
 *    会被幂等键永久挡回，账号会一路花到 0 再也补不上。代价是并发请求可能重复补，
 *    但缓存与流水同事务、同增量，「余额 == 流水合计」这条不变量不受影响。
 */
async function withLocalDevPrivilege(user: User): Promise<User> {
  if (!devEnergyTopUpEnabled()) return user

  if (user.energy >= DEV_ENERGY) return user

  const amount = DEV_ENERGY - user.energy
  const granted = await grantEnergy({
    userId: user.id,
    amount,
    reason: ENERGY_REASON.admin,
    refType: 'dev',
    refId: `dev:from:${user.energy}:${randomUUID()}`,
  })
  // 幂等命中（理论上只在并发下发生）就按原样返回，不谎报余额
  if (!granted) return user
  return { ...user, energy: user.energy + amount }
}


/**
 * ⭐⭐ **只查，不建** —— 按 openid 看这个人在不在我们库里。
 *
 * ⚠️⚠️ 这是鉴权路径（middleware/auth.ts）唯一允许用的那个：
 *    **注册不能是自动的**（用户 2026-09 定）—— 不能用一次网络请求就替用户
 *    在 `users` 里建一行。建行只能由用户**显式**的动作触发（见 createUserByOpenid）。
 *
 * ✗ 这里曾经叫 `getOrCreateUserByOpenid`，被中间件与 /api/auth/login 一起调用，
 *    结果「打开小程序」就等于「注册」：用户连首屏都没看到，库里已经有他了。
 *    把「取」和「建」拆开就是为了让这件事不可能再悄悄发生 ——
 *    想建行，只能显式调用下面那个函数。
 */
export async function findUserByOpenid(openid: string): Promise<User | null> {
  const [found] = await db.select().from(users).where(eq(users.openid, openid)).limit(1)
  return found ? withLocalDevPrivilege(found) : null
}

/**
 * ⭐⭐⭐ **全站唯一的建行点** —— 只有「加入句拼」那一次显式动作能到这里
 *    （`POST /api/auth/register`，见 routes/auth.ts）。
 *
 * ⚠️⚠️ 调用方必须是一个**用户主动发起的写操作**。任何"顺手取一下用户"的路径
 *    都不许调它 —— 那正是「自动注册」这个错误的形态。
 *
 * ⚠️ 幂等：行已存在时直接返回它（重试 / 双端点击不会建出第二行）。
 *
 * ⚠️ 两个 MySQL 特有的坑：
 *   ① 没有 INSERT ... RETURNING，拿不到刚插入的行，只能回查；
 *   ② 并发注册时两个请求会同时插入、撞 openid 唯一键 ——
 *      用 INSERT IGNORE 让其中一个静默失败，之后统一回查。
 */
export async function createUserByOpenid(openid: string): Promise<User> {
  const existing = await findUserByOpenid(openid)
  if (existing) return existing

  // ⚠️ 建号时**不再直接写 energy**：先把账号建出来（energy 走默认 0），
  //    再由 withLocalDevPrivilege 走账本补一条流水 —— 两处直写合成同一条路。
  await db.insert(users).ignore().values({ openid })

  const [created] = await db.select().from(users).where(eq(users.openid, openid)).limit(1)
  if (!created) throw new Error(`创建用户失败: ${openid}`)
  return withLocalDevPrivilege(created)
}
