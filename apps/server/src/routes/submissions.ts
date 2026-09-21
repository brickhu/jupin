import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import type {
  ScoreDimensions,
  StreakDelta,
  SubmissionStatusResponse,
  SubmitResponse,
  WordScore,
} from '@jushuo/shared'
import { db } from '../db'
import { articles, submissions, users } from '../db/schema'
import { env } from '../env'
import { assertAudioKeyOwnedBy, assertAudioUrlMatchesKey, makeSubmissionId } from '../services/audio-key'
import { dailyChallengeUsage, nextSeq } from '../services/submission'
import { checkChallenge } from '../services/quota'
import { getBestExcluding, getLeaderboardAround, getRank } from '../services/leaderboard'
import { claimStaleScoring, markScoringFailed, MAX_SCORING_ATTEMPTS, runScoring } from '../services/scoring'
import { resolveScheduleDate } from '../services/schedule-date'
import { ensureSchedules } from '../services/schedules'
import type { Variables } from '../middleware/auth'

export const submissionsRoutes = new Hono<{ Variables: Variables }>()

/** 心跳多久没刷新就认为跑打分的进程已经死了 —— 与 services/scoring.ts 保持一致 */
const HEARTBEAT_TIMEOUT_MS = 30_000

/*
 * ⭐ 提交检测 —— 全产品唯一花钱的地方。
 *
 * ⚠️⚠️ 本路由是**异步任务模型**，不是「一个请求干完所有事」：
 *
 *      POST /       受理 → 立刻返回 { submissionId, status:'scoring' }
 *      后台         跑评测（services/scoring.ts），边跑边刷心跳
 *      GET  /:id    轮询 → scoring / scored / failed
 *
 *   为什么必须这样：一次讯飞评测实测 **9.8 秒**，长句 15 秒以上，
 *   而云托管 callContainer 的**单次超时上限是 15 秒**（硬限制）。
 *   一个请求装不下一次打分，这不是调参能解决的。
 *
 *   曾经的同步版本被迫设「总预算 50 秒」之类的固定上限 —— 那等于
 *   **给句子长度设了上限**，而且撞上去的表现是「用户永远拿不到分」。
 *   现在链路上没有任何时长上限，唯一的判据是**心跳**。
 *
 * 受理顺序很讲究：
 *   1. **校验音频路径属于当前用户**（安全边界，最便宜的拒绝放最前）
 *   2. **幂等检查** —— 同一段音频已提交过就回放同一个 submissionId，
 *      **必须在冷却之前**（否则「重试」会被自己造成的冷却挡住，得到 429）
 *   3. 冷却检查
 *   4. 分配序列号 → 生成 submissionId(hash(userId, articleId, seq))
 *   5. 落 status='scoring' 的行 → 后台开跑
 *
 * ⚠️⚠️ 服务端不接受客户端传 fileID，只接受结构化路径并校验它。
 * ⚠️ 音频**永久保留**，只在检测失败时删除。
 */
submissionsRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const user = c.get('user')

  const body = await c.req.json<{
    articleId?: number
    audioKey?: string
    audioUrl?: string
    isPublic?: boolean
    scheduleDate?: string
  }>()
  const articleId = Number(body.articleId)
  const audioKey = body.audioKey
  const audioUrl = body.audioUrl
  // ⚠️ 缺省必须是 true（与 DB 默认值一致）—— 别写成 false，那会让「没传」变成「悄悄私有」
  const isPublic = body.isPublic !== false
  if (!articleId || !audioKey) {
    return c.json({ ok: false, error: '缺少 articleId 或 audioKey' }, 400)
  }

  // ---- 0. 挑战日期 ----
  //
  // ⚠️ 由客户端声明、服务端**校验**，而不是服务端一律取今天：
  //    用户可以对历史挑战点「再次挑战」，那次提交的归属是**那一天**；
  //    一律记成今天的话，昨天那张卡片的参与人数会莫名其妙地涨。
  //
  // ⚠️ 校验两道，缺一不可：
  //    ① 格式与真实性（isValidDay 会把 2026-02-30 这种「格式对但不存在」的挡掉）
  //    ② **范围**：不能是未来，也不能太旧 —— 否则可以伪造任意日期的成绩，
  //       把历史榜单刷成自己的。
  const scheduleDate = resolveScheduleDate(body.scheduleDate)
  if (!scheduleDate) {
    return c.json({ ok: false, error: 'scheduleDate 不合法（必须是最近 30 天内的日期）' }, 400)
  }

  // ---- 1. ⚠️ 安全边界：路径必须属于当前用户 ----
  // ⚠️ 两步的顺序不能反：先确认 audioKey 属于本人，再确认 audioUrl 指的就是那个 key。
  try {
    assertAudioKeyOwnedBy(audioKey, userId, articleId)
  } catch (err) {
    console.warn('[submissions] 拒绝非法音频路径 user=' + userId + ' key=' + audioKey)
    return c.json({ ok: false, error: (err as Error).message }, 403)
  }
  if (audioUrl) {
    try {
      assertAudioUrlMatchesKey({
        audioUrl,
        audioKey,
        bucket: env.COS_BUCKET ?? '',
        region: env.COS_REGION ?? '',
      })
    } catch (err) {
      console.warn('[submissions] 拒绝不匹配的下载地址 user=' + userId + ' url=' + audioUrl.slice(0, 80))
      return c.json({ ok: false, error: (err as Error).message }, 403)
    }
  }

  // ---- 2. ⭐ 幂等：同一段录音只算一次 ----
  //
  // ⚠️ 按 (userId, audioKey) 查，不能只挑 scored：客户端在网络重发、
  //    或用户重复点「提交检测」时会再 POST 一次同一段音频。
  //    查不到 scoring 就会**再开一个打分任务**（重复计费），
  //    而且第二次 INSERT 会撞 submissions_user_audio_idx 唯一键。
  //
  // ⭐ 幂等命中时返回的是**同一个 submissionId** —— 客户端接着轮询就行，
  //    完全不需要知道「这是重发」。
  const [dupe] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(and(eq(submissions.userId, userId), eq(submissions.audioKey, audioKey)))
    .limit(1)
  if (dupe) {
    const status = await describe(userId, dupe.id)
    if (status) {
      console.log('[submissions] 幂等命中 user=' + userId + ' key=' + audioKey + ' → ' + status.status)
      // ⚠️ failed 也返回 200 + 明确状态，而不是 400：
      //    客户端只需要读 status 一条路径，分支越少越不容易漏。
      return c.json({ ok: true, data: status }, status.status === 'scoring' ? 202 : 200)
    }
  }

  // ---- 3. ⭐ 挑战门禁：今天还剩几次（与句子无关）----
  //
  // ⚠️ 顺序：**幂等检查在前，门禁在后**（见上面第 2 步）。
  //    反过来的话，用户"重试"会把同一段音频又算一次挑战 —— 而他只是想再发一次。
  //
  // ⚠️ 拒绝是 **429 + 明确的 code**，不是 400：
  //    它是**业务规则**，不是"请求写错了"。客户端要据此给出可行动的提示
  //    （"今天的次数用完了，明天再来"），而不是一句"请求失败"。
  const isMember = !!user.memberUntil && user.memberUntil > new Date()
  const { usedToday } = await dailyChallengeUsage(userId)
  const gate = checkChallenge({ usedToday, isMember })
  if (!gate.allowed) {
    return c.json(
      {
        ok: false,
        code: gate.code,
        reason: gate.reason,
        usedToday: gate.usedToday,
        dailyLimit: gate.dailyLimit,
        error:
          gate.reason === 'free'
            ? '今天的免费挑战已经用完了，明天再来'
            : `今天已经挑战满 ${gate.dailyLimit} 次了，明天再来`,
      },
      429,
    )
  }

  const [article] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)

  // ⭐ 确保这一天的挑战确实存在 —— 提交是「针对某一天的挑战」的一次参与，
  //    那一天的挑战行不能在数据上缺席（否则这一天只有成绩、没有题目）。
  //    ⚠️ 幂等（INSERT IGNORE），代价是一条按主键的插入。
  await ensureSchedules([scheduleDate])

  // ---- 4. 分配序列号 ----
  const seq = await nextSeq(userId, articleId)
  const submissionId = makeSubmissionId(userId, articleId, seq)

  // ---- 5. ⭐ 落「打分中」的行，然后**不等它** ----
  //
  // ⚠️ 用 insert().ignore()：并发重发时两个请求可能同时到这里，
  //    先查后插会让其中一个撞唯一键 500。ignore() 让后到者静默失败，
  //    两边随后都会读同一行、回答同一个 submissionId。
  await db.insert(submissions).ignore().values({
    id: submissionId,
    userId,
    articleId,
    seq,
    audioKey,
    // ⚠️ 签名地址必须存下来：打分在**后台**跑，那时已经没有请求上下文了。
    //    不存它就只能走「开放接口服务」——那条路在本项目 dev 环境实测没通。
    audioUrl: audioUrl ?? null,
    engine: env.ENGINE,
    isPublic,
    status: 'scoring',
    heartbeatAt: new Date(),
    attempts: 1,
    scheduleDate,
  })

  // ⭐ 立刻开跑，但**不 await** —— 受理必须毫秒级返回，
  //   否则又回到了「一个请求装不下一次打分」的老问题。
  void runScoring(submissionId)

  console.log('[submissions] 已受理 id=' + submissionId + ' user=' + userId + ' article=' + articleId)
  return c.json({ ok: true, data: { submissionId, status: 'scoring' as const } }, 202)
})

/**
 * 轮询打分状态 —— 客户端拿到 submissionId 后反复调它，直到 scored / failed。
 *
 * ⚠️ 这个端点还承担**故障恢复**：如果跑打分的进程死了（心跳停），
 *    是这里把它认领回来重跑的。没有这一步，容器一重启那条音频就永远停在 scoring。
 */
submissionsRoutes.get('/:id', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const [row] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1)
  // ⚠️ 不属于本人一律当作不存在 —— 不要区分 403/404，那会泄露「这个 id 存在」
  if (!row || row.userId !== userId) {
    return c.json({ ok: false, error: '提交记录不存在' }, 404)
  }

  if (row.status !== 'scoring') {
    const done = await describe(userId, id)
    return c.json({ ok: true, data: done ?? { submissionId: id, status: 'failed' as const } })
  }

  // ---- 还在打分：先看心跳 ----
  const alive =
    row.heartbeatAt !== null &&
    Date.now() - new Date(row.heartbeatAt).getTime() < HEARTBEAT_TIMEOUT_MS
  if (alive) {
    return c.json({ ok: true, data: { submissionId: id, status: 'scoring' as const } })
  }

  // ---- 心跳停了 ----
  if (row.attempts >= MAX_SCORING_ATTEMPTS) {
    // 已经跑满重跑次数，不会再有人接手 —— 判失败让用户重录，而不是让他无限等
    console.warn('[submissions] 打分重试次数用尽 id=' + id + '（' + row.attempts + ' 次）')
    await markScoringFailed(id, '打分多次中断，请重录一次')
    const dead = await describe(userId, id)
    return c.json({ ok: true, data: dead ?? { submissionId: id, status: 'failed' as const } })
  }

  // ⭐ 原子认领。⚠️ 认领成功后**在原地把它跑完**（await），而不是又丢回后台：
  //    请求没返回，容器就不会被回收，这次重跑才真的跑得完。
  //    它可能超过 callContainer 的 15 秒 —— 没关系，客户端下一轮轮询就能拿到结果。
  const claimed = await claimStaleScoring(id)
  if (!claimed) {
    // 被并发的另一次轮询抢走了，让它跑
    return c.json({ ok: true, data: { submissionId: id, status: 'scoring' as const } })
  }
  console.log('[submissions] 接管停跳的打分任务 id=' + id + '（第 ' + (row.attempts + 1) + ' 次）')
  await runScoring(id)
  const recovered = await describe(userId, id)
  return c.json({ ok: true, data: recovered ?? { submissionId: id, status: 'scoring' as const } })
})

/**
 * ⭐ 改这段录音的可见性 —— **提交之后才问用户**。
 *
 * ⚠️ 为什么不在提交前问：提交是这一页唯一的主线动作，
 *    在它前面横一个开关，等于让每个用户先做一个与「读好这句」无关的决定。
 *    而「别人能不能听到」这件事，用户听完自己的分数再决定反而更有依据。
 *
 * ⚠️ 用 POST 子路径而不是 PATCH：callContainer 的类型里**根本没有 PATCH**
 *    （微信网关只保证转发它列出的那几个方法）。为一个开关去赌网关支不支持，
 *    赌输的表现是「真机上点了没反应」，而模拟器里一切正常。
 *
 * ⚠️ 只允许本人改：不校验归属的话，任何人就能把别人的录音设成公开 ——
 *    那是一次真实的隐私事故，不是一个越权小 bug。
 */
submissionsRoutes.post('/:id/visibility', async (c) => {
  const userId = c.get('userId')
  const id = c.req.param('id')

  const body = await c
    .req.json<{ isPublic?: boolean }>()
    .catch(() => ({}) as { isPublic?: boolean })
  if (typeof body.isPublic !== 'boolean') {
    return c.json({ ok: false, error: '缺少 isPublic' }, 400)
  }

  const [row] = await db.select().from(submissions).where(eq(submissions.id, id)).limit(1)
  // ⚠️ 不属于本人一律当作不存在 —— 与 GET /:id 同一条口径
  if (!row || row.userId !== userId) {
    return c.json({ ok: false, error: '提交记录不存在' }, 404)
  }

  await db.update(submissions).set({ isPublic: body.isPublic }).where(eq(submissions.id, id))
  console.log('[submissions] 可见性改为 ' + (body.isPublic ? '公开' : '私密') + ' id=' + id)
  return c.json({ ok: true, data: { submissionId: id, isPublic: body.isPublic } })
})

/**
 * 把一行记录翻译成客户端要的状态包 —— POST 与 GET **共用**，避免两处逻辑漂移。
 *
 * ⚠️⚠️ 这个函数会被**反复调用**（客户端每次轮询都调一次），
 *    所以每个字段都必须是**幂等**的：同样的数据永远给同样的答案。
 *    `isPersonalBest` 因此被定义成「比我这篇文章里**其它**提交都高」，
 *    而不是「刚才写入时是不是新高」—— 后者每轮询一次就会变一次，
 *    结果页的「🎉 刷新最好成绩」会忽有忽无。
 */
async function describe(
  userId: number,
  submissionId: string,
): Promise<SubmissionStatusResponse | null> {
  const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
  if (!row) return null

  if (row.status === 'failed') {
    return {
      submissionId,
      status: 'failed',
      error: row.failReason ?? '这段录音检测失败，请重录',
    }
  }
  if (row.status !== 'scored' || row.score === null) {
    return { submissionId, status: 'scoring' }
  }

  // ⚠️ 排行与「上次最好成绩」都按 **articleId**（句子就是竞技场）——
  //    同一句会被排在很多天，那些天的参与者本来就该在同一张榜上。
  //    见 services/leaderboard.ts 的说明。
  const articleId = row.articleId
  const [rankInfo, leaderboard, previous] = await Promise.all([
    getRank(articleId, userId),
    getLeaderboardAround(articleId, userId),
    getBestExcluding(articleId, userId, submissionId),
  ])

  const result: SubmitResponse = {
    score: row.score,
    rank: rankInfo.rank,
    participantCount: rankInfo.participantCount,
    gapToPrev: rankInfo.gapToPrev,
    beatenCount: rankInfo.beatenCount,
    // ⚠️ 服务端认定的句子 —— 客户端用它当「我在这句上的战绩」的键。
    //    竞技数据跟着句子走，与日期无关（见 services/leaderboard.ts）。
    articleId: row.articleId,
    // ⚠️ 从库里读回来，不是写死 —— 用户可能在结果页改过（见 /visibility）
    isPublic: row.isPublic,
    isPersonalBest: previous === null || row.score > previous,
    isConquered: row.isConquered ?? false,
    previousBest: previous,
    leaderboard,
    words: row.wordScores ? (JSON.parse(row.wordScores) as WordScore[]) : undefined,
    // ⚠️ 维度也必须从库里读回来，否则轮询取到的结果里四维会不见
    dimensions: row.dimensions ? (JSON.parse(row.dimensions) as ScoreDimensions) : undefined,
    streak: row.streakDelta ? (JSON.parse(row.streakDelta) as StreakDelta) : undefined,
  }
  return { submissionId, status: 'scored', result }
}
