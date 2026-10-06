import { eq, sql } from 'drizzle-orm'
import { db } from '../src/db'
import { articles, energyLedger, rewardGrants, submissions, users } from '../src/db/schema'
import { participationIdOf } from '@jushuo/shared'

import { settle } from '../src/services/settle'
import { readCookies } from '../src/services/cookies'
import { readEnergy } from '../src/services/energy'
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
  const uid = user.id

  const arts = await db.select({ id: articles.id }).from(articles).limit(2)
  if (arts.length < 2) throw new Error('句库不足 2 句，先灌内容')
  const a1 = arts[0] as { id: string }
  const a2 = arts[1] as { id: string }

  console.log('规则：', (await listRules()).map((r) => r.code + ':' + r.trigger).join(', '))
  console.log('')

  let n = 0

  /** 造一条"已打分"的成绩并结算 */
  async function attempt(label: string, articleId: string, score: number) {
    n += 1
    /**
     * ⚠️ 这里原来在数一个 `seq`（每次提交 +1）并写进 submissions ——
     *    那一列早就没了（改叫 attempts）。脚本不在类型检查里，所以一直没被发现。
     *    幂等键现在是 (user, article, attempt_id)，这里用不到序号。
     */
    const id = 'smoke' + String(n).padStart(3, '0') + 'x'.repeat(20)

    await db.insert(submissions).values({
      id,
      userId: uid,
      articleId,
      /** ⚠️ 必填（后加的派生列）—— 这个脚本原来没写，因为脚本不被类型检查 */
      participationId: participationIdOf(uid, articleId),
      audioKey: 'audio/' + articleId + '/' + uid + '/' + n + '.mp3',
      status: 'scored',
      score: score.toFixed(1),
      // ⚠️ 这里原来还写了 isConquered —— 那一列早就没了（与 seq 同一个来源：
      //    脚本不在类型检查里，改表时漏了它们没人发现）。
      //    energyState 保留：它是这套 fixture 的真实性细节（正常流程里结算前就是 charged）
      energyState: 'charged',
    })

    const r = await settle(uid, id)
    const g = await readCookies(uid)
    const e = await readEnergy(uid)
    console.log(
      label.padEnd(22) +
        ('分=' + score).padEnd(8) +
        ('streak=' + (r?.streakDays ?? '-')).padEnd(10) +
        ('本次饼干 ' + (r ? r.cookies.earned : '-')).padEnd(14) +
        ('累计 ' + g.total + '/可用 ' + g.balance).padEnd(18) +
        ('奖 ' + (r ? r.rewards.map((x) => x.kind + 'x' + x.amount).join(',') || '无' : '-')).padEnd(14) +
        '能量=' + e,
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
  const again = await settle(uid, 'smoke' + String(4).padStart(3, '0') + 'x'.repeat(20))
  console.log('  返回值 =', again === null ? 'null（已结算过，正确）' : '⚠️ 又结算了一次：' + JSON.stringify(again.cookies))

  await cleanup()
  console.log('')
  console.log('✅ 冒烟结束，测试数据已清理')
  process.exit(0)
}

main().catch((err) => {
  console.error('❌', err)
  process.exit(1)
})
