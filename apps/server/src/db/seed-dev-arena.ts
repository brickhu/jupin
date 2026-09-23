import { and, count, countDistinct, eq } from 'drizzle-orm'
import { UNFREEZE_VALID_DAYS, addDays, today } from '@jushuo/shared'

import { unfreezeCards, users } from './schema'
import { RULE_CODE } from '../services/rewards'

/**
 * 开发用的**竞技数据**种子 —— 让本地库看起来像真的有人在读。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么值得单独写一个种子：
 *
 *   句子只有 5 条、真机账号只有几个，于是首页每张卡都是「1 人参与」、
 *   榜单只有一行、成长值永远是 0 —— 而这三样（人有多少 / 我排第几 /
 *   连续了几天）**恰恰是这个产品唯一的看点**。空库上根本看不出它对不对。
 *   这不是「造点假数据让页面好看」，是让本地能验证排名与 streak 的正确性。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ **只写 seed_ 前缀的账号，绝不碰 dev_* 和任何真实账号。**
 *    那些是真机上跑出来的记录，种子混进去就再也分不出真假了。
 *    要清掉本脚本的产物（先子后父，别用通配删整个表）：
 *      DELETE FROM submissions WHERE engine = 'mock';
 *      DELETE FROM users WHERE openid LIKE 'seed_%';
 *
 * ⚠️ 幂等：全部走主键 upsert，重复跑不会翻倍、不会撞键。
 *    ⚠️ 但改了 COMPETITORS 之后重跑，**已有的行不会跟着改**（见下面 upsert 的说明）。
 *
 * ⚠️ 分数、四维、streak 都是**这里按规则编的**，不是真评测结果 ——
 *    所以 engine 一律写 'mock'，一眼能认出这批是造的。
 *
 * ⚠️ 排期不在这里编：调服务端自己的 ensureSchedules()，
 *    于是「哪天读哪一句」与线上**完全同一套规则**（天号取模）。
 *    自己再写一遍轮转，就会造出一批在别的日子根本对不上的历史。
 */

/** 往今天之前铺多少天 —— 30 天正好能让坚持不懈的 30 天档亮起来 */
const LOOKBACK_DAYS = 30

/**
 * 每个「选手」：昵称 / 水平 / 连续天数 / 最后一次读是不是今天。
 *
 * ⚠️ 手写而不是随机生成：排行榜的头几名是这个页面最重要的东西，
 *    随机数会造出「第一名 61 分」这种一看就假的榜。
 *    skill 决定分数区间，run 决定 streak，两者刻意**不成正比** ——
 *    现实里天天来的人往往读得一般，而高分的人常常三天打鱼。
 */
const COMPETITORS: { name: string; skill: number; run: number; readsToday: boolean }[] = [
  { name: 'Ada', skill: 0.95, run: 12, readsToday: true },
  { name: '林小满', skill: 0.9, run: 4, readsToday: true },
  { name: 'Chris', skill: 0.86, run: 21, readsToday: true },
  { name: '周舟', skill: 0.83, run: 7, readsToday: true },
  { name: 'Nina', skill: 0.8, run: 30, readsToday: true },
  { name: '沈知白', skill: 0.77, run: 2, readsToday: true },
  { name: 'Leo', skill: 0.74, run: 15, readsToday: true },
  { name: '苏一', skill: 0.71, run: 9, readsToday: false },
  { name: 'Mia', skill: 0.68, run: 5, readsToday: true },
  { name: '陈默', skill: 0.66, run: 3, readsToday: true },
  { name: 'Ryan', skill: 0.63, run: 18, readsToday: false },
  { name: '许知野', skill: 0.6, run: 6, readsToday: true },
  { name: 'Zoe', skill: 0.58, run: 1, readsToday: true },
  { name: '何砚', skill: 0.55, run: 11, readsToday: true },
  { name: 'Tom', skill: 0.52, run: 8, readsToday: false },
  { name: '温梨', skill: 0.5, run: 24, readsToday: true },
  { name: 'Iris', skill: 0.47, run: 2, readsToday: true },
  { name: '陆听澜', skill: 0.44, run: 7, readsToday: false },
  { name: 'Sam', skill: 0.41, run: 16, readsToday: true },
  { name: '顾南枝', skill: 0.38, run: 4, readsToday: true },
  { name: 'Ella', skill: 0.34, run: 1, readsToday: false },
  { name: '闻笛', skill: 0.3, run: 10, readsToday: true },
  { name: 'Kai', skill: 0.26, run: 3, readsToday: true },
  { name: '江照', skill: 0.2, run: 6, readsToday: true },
  { name: '白鹭', skill: 0.88, run: 33, readsToday: true },
  { name: 'Yuki', skill: 0.62, run: 40, readsToday: false },
]

/**
 * 确定性随机 —— 固定种子，保证每次跑出来的数据**一模一样**。
 * ⚠️ 用 Math.random() 的话，重跑一次榜就变了，而「上次明明是这样」
 *    这种问题在调试时会被浪费掉一整轮。
 */
function makeRng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** 夹到 0–100，保留两位小数 */
function clamp100(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v * 100) / 100))
}

/**
 * 由总分反推一组**自洽的**四维得分。
 *
 * ⚠️ 讯飞的公式是 total = (0.6×acc + 0.3×flu + 0.1×std) × integrity，
 *    权重 0.6/0.3/0.1 是实测出来的（见 @jushuo/shared 的 ScoreDimensions 注释）。
 *    这里让 acc 略高、std 略低、integrity 取 100，反推出来的加权和与总分只差零点几分。
 *    随便填四个数的话，朗读页那张四维表会和总分对不上。
 */
function dimensionsOf(score: number, jitter: number): Record<string, number> {
  return {
    accuracy: clamp100(score + 4 + jitter * 2),
    fluency: clamp100(score - 6 + jitter),
    standard: clamp100(score - 10 + jitter * 3),
    integrity: 100,
  }
}

async function main(): Promise<void> {
  // ⚠️ 动态 import：本文件与 db/index.ts 之间会成环，静态 import 解析不了（同 seed-articles）
  const { db } = await import('./index')
  const { articles, submissions, users } = await import('./schema')
  const { makeAudioKey, makeSubmissionId } = await import('../services/audio-key')
  const { ensureSchedules } = await import('../services/schedules')

  const start = today()
  const dates: string[] = []
  for (let i = LOOKBACK_DAYS - 1; i >= 0; i--) dates.push(addDays(start, -i))

  // ⭐ 排期交给服务端自己补：没有排期的日子按天号取模自动补一行，与线上同一个函数。
  const sched = await ensureSchedules(dates)
  const articleOf = new Map<string, number>()
  for (const [date, row] of sched) articleOf.set(date, row.article.id)

  const allArticles = await db.select({ id: articles.id }).from(articles)
  if (allArticles.length === 0) throw new Error('句库是空的 —— 先跑 pnpm seed 灌种子文章')

  console.log('铺 ' + dates.length + ' 天（' + dates[0] + ' … ' + dates[dates.length - 1] + '）')
  console.log('选手 ' + COMPETITORS.length + ' 人\n')

  // ----------------------------------------------------------------
  // ① 选手账号 —— openid 一律 seed_ 前缀，一眼能认出来
  // ----------------------------------------------------------------
  const userIds: number[] = []
  for (let i = 0; i < COMPETITORS.length; i++) {
    const c = COMPETITORS[i]!
    const openid = 'seed_u' + String(i + 1).padStart(2, '0')
    // ⚠️ streakBest 只增不减，真实账号里它几乎总是 ≥ streakDays —— 所以给得比 run 略高
    const lastReadDate = c.readsToday ? start : addDays(start, -1)
    const streakBest = Math.max(c.run, Math.round(c.run * 1.1))
    const patch = {
      nickname: c.name,
      streakDays: c.run,
      streakBest,
      lastReadDate,
      // ⚠️ 解冻卡**不再是 users 上的计数器**（一张卡一行、带有效期，见 unfreeze_cards）。
      //    这里只把 marker 设成 streakBest —— 他们"已经记过账"，不会再补发。
      unfreezeMarkerStreak: streakBest,
    }
    await db
      .insert(users)
      .values({ openid, ...patch })
      .onDuplicateKeyUpdate({ set: patch })

    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.openid, openid))
      .limit(1)

    // ⭐ 顺手发几张解冻卡 —— 本地看「我的主页」时卡不是 0，才有东西可验
    if (row) {
      const cards = Math.min(3, Math.floor(streakBest / 7))
      await db.delete(unfreezeCards).where(eq(unfreezeCards.userId, row.id))
      if (cards > 0) {
        const now = new Date()
        const expiresAt = new Date(now.getTime() + UNFREEZE_VALID_DAYS * 86_400_000)
        await db.insert(unfreezeCards).values(
          Array.from({ length: cards }, () => ({
            userId: row.id,
            grantedAt: now,
            expiresAt,
            ruleCode: RULE_CODE.streakUnfreeze,
          })),
        )
      }
    }
    if (!row) throw new Error('写入选手失败：' + openid)
    userIds.push(row.id)
  }

  // ----------------------------------------------------------------
  // ② 提交记录 —— 分数看 skill，日期看 run
  // ----------------------------------------------------------------
  const rows: (typeof submissions.$inferInsert)[] = []

  for (let i = 0; i < COMPETITORS.length; i++) {
    const c = COMPETITORS[i]!
    const userId = userIds[i]!
    const rnd = makeRng(1000 + i * 37)

    // 这位选手连着读的那几天：[首日, 末日]
    const lastDay = addDays(start, c.readsToday ? 0 : -1)
    const firstDay = addDays(lastDay, -(c.run - 1))

    // 他在该句上的第几次提交 —— 与服务端的 seq 口径一致（按 articleId 计）
    const seqOf = new Map<number, number>()

    for (let d = 0; d < c.run; d++) {
      const date = addDays(firstDay, d)
      const articleId = articleOf.get(date)
      if (!articleId) continue

      const seq = (seqOf.get(articleId) ?? 0) + 1
      seqOf.set(articleId, seq)

      // 58 分的底 + 水平带来的上限，再加一点当天波动
      const jitter = rnd() * 8 - 4
      const score = Math.round(Math.max(35, Math.min(99, 58 + c.skill * 34 + jitter)))
      // ⚠️ 提交时刻取当天 20:00（北京时间）= 12:00 UTC。
      //    连接池把时区钉死成 UTC，塞一个 UTC 时刻进去，dayKey() 解出来还是同一天。
      const at = new Date(date + 'T12:00:00.000Z')

      rows.push({
        id: makeSubmissionId(userId, articleId, seq),
        userId,
        articleId,
        seq,
        scheduleDate: date,
        status: 'scored',
        // ⚠️ DECIMAL 列要字符串（见 schema 里的说明）
        score: Number(score).toFixed(1),
        // ⚠️ 攻克 = 出分即可（85 分线已废除，见 constants 里的说明）
        isConquered: true,
        audioKey: makeAudioKey(articleId, userId, at.getTime()),
        audioBytes: 40000 + Math.round(rnd() * 60000),
        audioDurationMs: 3200 + Math.round(rnd() * 4200),
        // 绝大多数公开，留一部分关掉 —— 隐私开关那条路也要有数据可查
        isPublic: rnd() > 0.15,
        dimensions: JSON.stringify(dimensionsOf(score, jitter)),
        engine: 'mock',
        attempts: 1,
        createdAt: at,
        scoredAt: new Date(at.getTime() + 12000),
      })
    }
  }

  // 分批 upsert：一次几百条最稳（几万条会撞 max_allowed_packet）
  const BATCH = 100
  for (let i = 0; i < rows.length; i += BATCH) {
    await db
      .insert(submissions)
      .values(rows.slice(i, i + BATCH))
      // ⚠️ 撞键时**只写 status**：这批行的其它列全是确定性算出来的，值本来就不会变；
      //    真要改分数就改 COMPETITORS，然后先删掉 engine='mock' 的行再跑。
      .onDuplicateKeyUpdate({ set: { status: 'scored' } })
  }

  // ----------------------------------------------------------------
  // ③ 把 articles 上那两个冗余计数对齐
  //    ⚠️ 竞技口径全部从 submissions 现算（见 services/leaderboard.ts），
  //       这两列**没有任何代码在读**；但留着「39 人参与、实际只有 4 条成绩」
  //       只会让下一个看库的人以为哪里坏了。
  // ----------------------------------------------------------------
  for (const a of allArticles) {
    // ⚠️ 两个数都必须是**去重人数**（同一句读十遍只算一个人），
    //    与 services/leaderboard.ts 的 COUNT(DISTINCT user_id) 同一口径。
    const [p] = await db
      .select({ n: countDistinct(submissions.userId) })
      .from(submissions)
      .where(and(eq(submissions.articleId, a.id), eq(submissions.status, 'scored')))
    const [c] = await db
      .select({ n: countDistinct(submissions.userId) })
      .from(submissions)
      .where(
        and(
          eq(submissions.articleId, a.id),
          eq(submissions.status, 'scored'),
          eq(submissions.isConquered, true),
        ),
      )
    await db
      .update(articles)
      .set({ participantCount: Number(p?.n ?? 0), conqueredCount: Number(c?.n ?? 0) })
      .where(eq(articles.id, a.id))
  }

  const [mock] = await db
    .select({ n: count() })
    .from(submissions)
    .where(eq(submissions.engine, 'mock'))

  console.log('✅ 本次生成 ' + rows.length + ' 条提交（库里 seed 数据共 ' + (mock?.n ?? 0) + ' 条）')
  console.log('   清理：DELETE FROM submissions WHERE engine = \'mock\';')
  console.log('         DELETE FROM users WHERE openid LIKE \'seed_%\';')
  // ⚠️ 必须显式退出：连接池不会自己关，进程会一直挂着
  process.exit(0)
}

void main()