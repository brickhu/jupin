import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db'
import { articles, energyLedger, rewardGrants, submissions, unfreezeCards, users } from '../src/db/schema'
import { settle } from '../src/services/settle'
import { readGrowth } from '../src/services/growth'
import { readEnergy } from '../src/services/energy'
import { unfreezeStatus } from '../src/services/unfreeze'
import { ensureDefaultRules, listRules } from '../src/services/rewards'

/**
 * ⭐ 结算的**冒烟测试** —— 不经过引擎，直接造几条成绩，看结算对不对。
 *
 *   DATABASE_URL=... node_modules/.bin/tsx apps/server/scripts/settle-smoke.ts
 *
 * ⚠️ 它会在**本地库**里造一个 smoke_settle 账号并写几条成绩。
 *    跑完自己清（下次跑会先把上一次的清掉）。
 * ⚠️ 为什么不走真引擎：这里要验的是**结算**，不是打分。造分才能覆盖
 *    「第一次读 / 破纪录 / 破全场纪录」这些必须用特定分数才能触发的分支。
 */

const OPENID = 'smoke_settle'

async function cleanup() {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.openid, OPENID)).limit(1)
  if (!u) return
  // ⚠️ 顺序：所有指向 users 的表都要先清，否则外键拦着删不掉账号
  await db.delete(energyLedger).where(eq(energyLedger.userId, u.id))
  await db.delete(rewardGrants).where(eq(rewardGrants.userId, u.id))
  await db.delete(unfreezeCards).where(eq(unfreezeCards.userId, u.id))
  await db.delete(submissions).where(eq(submissions.userId, u.id))
  await db.delete(users).where(eq(users.id, u.id))
}

async function main() {
  await cleanup()
  // ⭐ 规则表空 = 什么都不发，而那是**静默**的 —— 冒烟前先补一次（幂等）
  await ensureDefaultRules()

  // ⚠️ MySQL 没有 INSERT ... RETURNING，插完回查一次
  await db.insert(users).values({ openid: OPENID, nickname: '冒烟' })
  const [user] = await db.select().from(users).where(eq(users.openid, OPENID)).limit(1)
  if (!user) throw new Error('建号失败')

  const arts = await db.select({ id: articles.id }).from(articles).limit(2)
  if (arts.length < 2) throw new Error('句库不足 2 句，先灌内容')
  const [a1, a2] = arts as [{ id: number }, { id: number }]

  console.log('规则：', (await listRules()).map((r) => r.code + ':' + r.trigger).join(', '))
  console.log('')

  const seqOf = new Map<number, number>()
  let n = 0

  /** 造一条"已打分"的成绩并结算 */
  async function attempt(label: string, articleId: number, score: number) {
    n += 1
    const seq = (seqOf.get(articleId) ?? 0) + 1
    seqOf.set(articleId, seq)
    const id = 'smoke' + String(n).padStart(3, '0') + 'x'.repeat(20)

    await db.insert(submissions).values({
      id,
      userId: user.id,
      articleId,
      seq,
      audioKey: 'audio/' + articleId + '/' + user.id + '/' + n + '.mp3',
      status: 'scored',
      score: score.toFixed(1),
      isConquered: true,
      energyState: 'charged',
    })

    const r = await settle(user.id, id)
    const g = await readGrowth(user.id)
    const e = await readEnergy(user.id)
    const cards = await unfreezeStatus(user.id)
    console.log(
      label.padEnd(22) +
        ('分=' + score).padEnd(8) +
        ('streak=' + (r?.streakDays ?? '-')).padEnd(10) +
        ('本次成长 ' + (r ? r.growth.self + '/' + r.growth.diligence + '/' + r.growth.standout : '-')).padEnd(18) +
        ('累计 ' + g.self + '/' + g.diligence + '/' + g.standout).padEnd(16) +
        ('奖 ' + (r ? r.rewards.map((x) => x.kind + 'x' + x.amount).join(',') || '无' : '-')).padEnd(14) +
        '能量=' + e + ' 卡=' + cards.count,
    )
    return r
  }

  console.log('开始（同一句读 4 次 + 另一句 2 次）')
  console.log('')
  await attempt('① 句A 第一次 80', a1.id, 80)
  await attempt('② 句A 再读 85', a1.id, 85)
  await attempt('③ 句A 读低了 70', a1.id, 70)
  await attempt('④ 句A 破纪录 92', a1.id, 92)
  await attempt('⑤ 句B 第一次 95', a2.id, 95)
  await attempt('⑥ 句B 再读 95（追平）', a2.id, 95)

  console.log('')
  console.log('⚠️ 幂等复核：对第 ④ 条再结算一次')
  const again = await settle(user.id, 'smoke' + String(4).padStart(3, '0') + 'x'.repeat(20))
  console.log('  返回值 =', again === null ? 'null（已结算过，正确）' : '⚠️ 又结算了一次：' + JSON.stringify(again.growth))

  await cleanup()
  console.log('')
  console.log('✅ 冒烟结束，测试数据已清理')
  process.exit(0)
}

main().catch((err) => {
  console.error('❌', err)
  process.exit(1)
})
