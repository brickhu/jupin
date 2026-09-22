import { eq } from 'drizzle-orm'
import { addDays, today as dayOf } from '@jushuo/shared'
import { db } from '../src/db'
import { submissions, unfreezeCards, users } from '../src/db/schema'
import {
  claimUnfreezeCards,
  grantUnfreezeCard,
  unfreezeStatus,
  useUnfreezeCards,
} from '../src/services/unfreeze'
import { readStreakRecord } from '../src/services/streak-record'

/**
 * 连战记录 + 领取的冒烟测试。
 *
 *   DATABASE_URL=... node_modules/.bin/tsx apps/server/scripts/streak-record-smoke.ts
 *
 * ⚠️ 会在本地库造一个 smoke_streak 账号；跑完自己清。
 */

const OPENID = 'smoke_streak'

async function cleanup() {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.openid, OPENID)).limit(1)
  if (!u) return
  await db.delete(unfreezeCards).where(eq(unfreezeCards.userId, u.id))
  await db.delete(submissions).where(eq(submissions.userId, u.id))
  await db.delete(users).where(eq(users.id, u.id))
}

/** 造一条"某天读的"成绩 —— createdAt 直接给，用来铺日历 */
async function seedRead(userId: number, articleId: number, day: string, n: number) {
  await db.insert(submissions).values({
    id: 'smk' + String(n).padStart(3, '0') + 'y'.repeat(24),
    userId,
    articleId,
    seq: n,
    audioKey: 'audio/smoke/' + userId + '/' + n + '.mp3',
    status: 'scored',
    score: '80.0',
    createdAt: new Date(day + 'T04:00:00.000Z'), // 北京时间当天中午
  })
}

async function main() {
  await cleanup()
  await db.insert(users).values({ openid: OPENID, nickname: '连战冒烟' })
  const [user] = await db.select().from(users).where(eq(users.openid, OPENID)).limit(1)
  if (!user) throw new Error('建号失败')

  const today = dayOf()
  // 本月 5/6/7 号读过（用当天往前推，保证落在这个月里）
  for (const [i, back] of [4, 5, 6].entries()) {
    await seedRead(user.id, 1, addDays(today, -back), i + 1)
  }

  // 2 张待领取的卡
  await grantUnfreezeCard({ userId: user.id, ruleCode: 'streak_unfreeze_7' })
  await grantUnfreezeCard({ userId: user.id, ruleCode: 'streak_unfreeze_7' })

  let st = await unfreezeStatus(user.id)
  console.log('发放后：手上 ' + st.count + ' 张，待领取 ' + st.pending + ' 张')

  const rec = await readStreakRecord(user.id)
  console.log('')
  console.log('连战记录 month=' + rec.month + ' 首日周几=' + rec.weekdayOfFirst + ' 天数=' + rec.daysInMonth)
  console.log('连战日：' + rec.days.filter((d) => d.kind === 'read').map((d) => d.date).join(', '))
  console.log('解冻日：' + (rec.days.filter((d) => d.kind === 'unfreeze').map((d) => d.date).join(', ') || '(无)'))
  console.log('待领取 ' + rec.unfreezePending + ' / 手上 ' + rec.unfreezeCards)

  const claimed = await claimUnfreezeCards(user.id)
  console.log('')
  console.log('领取：' + claimed + ' 张')
  st = await unfreezeStatus(user.id)
  console.log('领取后：手上 ' + st.count + ' 张，待领取 ' + st.pending + ' 张，最早到期 ' + st.expiresOn)

  // ---- 真的补一次签：把 lastReadDate 退回前天（缺口 1 天），再走真实的用卡逻辑 ----
  await db.update(users).set({ lastReadDate: addDays(today, -2) }).where(eq(users.id, user.id))
  const used = await useUnfreezeCards(user.id)
  console.log('补签：' + JSON.stringify(used))

  const rec2 = await readStreakRecord(user.id)
  const blue = rec2.days.filter((d) => d.kind === 'unfreeze').map((d) => d.date)
  console.log('再取日历 —— 解冻日：' + (blue.join(', ') || '(无)'))
  console.log('期望解冻日：' + addDays(today, -1))
  if (blue.length !== 1 || blue[0] !== addDays(today, -1)) throw new Error('解冻日反推不对')
  st = await unfreezeStatus(user.id)
  console.log('补签后：手上 ' + st.count + ' 张')
  if (st.count !== 1) throw new Error('补签应该正好用掉 1 张')

  // ---- 重复补签应该被拒（今天读过 / 没断档）----
  const again = await useUnfreezeCards(user.id)
  console.log('再补一次：' + JSON.stringify(again))
  if (again.ok) throw new Error('不该允许补第二次')

  await cleanup()
  console.log('')
  console.log('✅ 冒烟结束，测试数据已清理')
  process.exit(0)
}

main().catch((e) => {
  console.error('❌', e)
  process.exit(1)
})
