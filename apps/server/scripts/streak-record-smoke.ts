import { eq } from 'drizzle-orm'
import { addDays, participationIdOf, today as dayOf } from '@jushuo/shared'

import { db } from '../src/db'
import { submissions, users } from '../src/db/schema'
import { readStreakRecord } from '../src/services/streak-record'

/**
 * 连战记录的冒烟测试 —— 铺几天成绩，看日历有没有画对。
 *
 *   DATABASE_URL=... node_modules/.bin/tsx apps/server/scripts/streak-record-smoke.ts
 *
 * ⚠️ 会在本地库造一个 smoke_streak 账号；跑完自己清。
 *
 * ⚠️ 这个脚本原来还测「解冻卡」那一整套（发放 → 待领取 → 领取 → 补签 →
 *    日历上的"解冻日"）。解冻卡 2026-10 整体作废（prd §7.8）⇒ 那些断言全部删除。
 *    补签本身会以**花能量**的形式回来（plan B50），届时这里要重新长出对应断言。
 */

const OPENID = 'smoke_streak'

async function cleanup() {
  const [u] = await db.select({ id: users.id }).from(users).where(eq(users.openid, OPENID)).limit(1)
  if (!u) return
  await db.delete(submissions).where(eq(submissions.userId, u.id))
  await db.delete(users).where(eq(users.id, u.id))
}

/** 造一条"某天读的"成绩 —— createdAt 直接给，用来铺日历 */
async function seedRead(userId: number, articleId: string, day: string, n: number) {
  await db.insert(submissions).values({
    id: 'smk' + String(n).padStart(3, '0') + 'y'.repeat(24),
    userId,
    articleId,
    /**
     * ⚠️ participation_id 是**必填**的（后来那次迁移加的）——
     *    这个脚本一直没跟上，也正因为脚本不在类型检查里。
     *    它是派生值，现算即可（与 services/participations.ts 同一处实现）。
     */
    participationId: participationIdOf(userId, articleId),
    // ⚠️ 这里原来还有 seq —— submissions 早就没有那一列了（改叫 attempts）。
    //    脚本不在类型检查里，所以这个坑一直没被发现（见 tsconfig 的 include）。
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
  // 当天往前推 4/5/6 天 —— 保证落在这个月里（除非今天是月初，那也照样是个有效用例）
  for (const [i, back] of [4, 5, 6].entries()) {
    await seedRead(user.id, '1', addDays(today, -back), i + 1)
  }

  const rec = await readStreakRecord(user.id)
  console.log('')
  console.log('连战记录 month=' + rec.month + ' 首日周几=' + rec.weekdayOfFirst + ' 天数=' + rec.daysInMonth)
  const read = rec.days.filter((d) => d.kind === 'read').map((d) => d.date)
  console.log('连战日：' + (read.join(', ') || '(无)'))

  // ⚠️ 只对**落在这个月里**的那几天断言：上个月的那几天本来就不该出现在这个月
  const expected = [4, 5, 6]
    .map((back) => addDays(today, -back))
    .filter((d) => d.slice(0, 7) === rec.month)
    .sort()
  if (read.slice().sort().join(',') !== expected.join(',')) {
    throw new Error('连战日不对：期望 ' + expected.join(',') + '，实际 ' + read.join(','))
  }

  /**
   * ⚠️ 格子的 kind 只可能是 'read' —— 原来还有 'unfreeze'。
   *    这条盯着的是"日历只剩一种格子"这个事实，不是格式洁癖：
   *    多出第二种 kind 而端侧没画它，用户看到的就是**一个空白的格子**。
   */
  const kinds = new Set(rec.days.map((d) => d.kind))
  for (const k of kinds) {
    if (k !== 'read') throw new Error('日历里出现了 read 以外的格子：' + k)
  }
  console.log('✅ 连战记录冒烟通过')

  await cleanup()
}

void main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ ' + (err as Error).message)
    process.exit(1)
  })
