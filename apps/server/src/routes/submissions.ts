import { Hono } from 'hono'
import { and, eq, or } from 'drizzle-orm'
import type {
  ScoreDimensions,
  ScoreParts,
  StreakDelta,
  SubmissionStatusResponse,
  SubmitResponse,
  WordScore,
} from '@jushuo/shared'
import { db } from '../db'
import { articles, submissions, users } from '../db/schema'
import { env } from '../env'
import { assertAudioKeyOwnedBy, assertAudioUrlMatchesKey, makeSubmissionId } from '../services/audio-key'
import { nextSeq } from '../services/submission'
import { holdChallengeEnergy, readEnergy } from '../services/energy'
import { getBestExcluding, getLeaderboardAround, getRank } from '../services/leaderboard'
import { claimStaleScoring, markScoringFailed, MAX_SCORING_ATTEMPTS, runScoring } from '../services/scoring'
import { describe } from '../services/submission-view'
import { resolveScheduleDate } from '../services/schedule-date'
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
    articleId?: string
    audioKey?: string
    audioUrl?: string
    isPublic?: boolean
    scheduleDate?: string
    attemptId?: string
  }>()
  const articleId = body.articleId
  const audioKey = body.audioKey
  const audioUrl = body.audioUrl
  const attemptId = body.attemptId
  // ⚠️ 缺省必须是 false（与 DB 默认值一致）—— 公开是用户**自己打开开关**的结果，
  //    不是默认。没传就是私密，由结果页那个「允许公众收听」开关改成 true。
  const isPublic = body.isPublic === true
  if (!articleId || !audioKey) {
    return c.json({ ok: false, error: '缺少 articleId 或 audioKey' }, 400)
  }
  /**
   * ⭐⭐ 幂等键（见 db/schema.ts 的 attemptId）：**必填**，格式固定 32 位十六进制。
   *
   * ⚠️ 为什么必填而不是可选：它是"同一次录音只算一次"的唯一判据。
   *    可选的话就退回到"靠 audioKey（上传时间戳）判重"——那条路正是出过事的路
   *    （用户重试 → 新时间戳 → 多扣一次能量）。
   * ⚠️ 校验格式是为了让它能安全地进对象存储路径（不能有 `/`、不能穿越）。
   *    老客户端（没有这个字段）会拿到 400：这是**故意的**，宁可报错也不要静默多扣费。
   */
  if (!attemptId || !/^[a-f0-9]{32}$/.test(attemptId)) {
    return c.json({ ok: false, error: 'attemptId 不合法（需要 32 位十六进制）' }, 400)
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
  /**
   * ⚠️⚠️ 判据是 **(userId, attemptId)** —— 不是 audioKey。
   *
   * audioKey 里含上传时间戳，而客户端每次重试都会重新上传一次 ⇒ 换了 key，
   * 按它判重必然落空（真实事故：用户按提示重试 → 第二条成绩 + 第二次扣能量）。
   * ⚠️ 同时保留一条 audioKey 兜底：同一次上传被**并发**提交两次时（两个请求同一个 key、
   * 但 attemptId 也相同 —— 那时 attemptId 那条已经能挡），以及理论上"客户端换了
   * attemptId 但复用了同一个音频对象"的异常路径。
   */
  const [dupe] = await db
    .select({ id: submissions.id })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        or(eq(submissions.attemptId, attemptId), eq(submissions.audioKey, audioKey)),
      ),
    )
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

  // ---- 3. （旧的「每天 N 次」门禁已删除：额度整体换成了能量点数，
  //          而且能量锁需要先知道 submissionId，所以挪到了下面第 5 步）----

  const [article] = await db
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)

  /**
   * ⚠️ 这里原来会 `ensureSchedules([scheduleDate])` —— 给这一天补一行**排期**
   *    （"哪一天读哪一句"是提前排好的数据）。2026-09 排期表整体删除：
   *    句子的归属由 `/api/user/today` 的 24 小时窗口决定，
   *    不再需要"这一天必须先有一条排期行"。
   * ⚠️ `scheduleDate` 本身**留着**：它是"这次提交算哪一天"的归属信息
   *    （历史挑战要归到那一天，否则昨天那张卡的数字会变）。
   */

  // ---- 4. 分配序列号 ----
  const seq = await nextSeq(userId, articleId)
  const submissionId = makeSubmissionId(userId, articleId, seq)

  // ---- 5. ⭐ 能量锁：受理时先把这次挑战要花的能量占住 ----
  //
  // ⚠️ 顺序：**幂等检查在前（第 2 步）、锁在后**。反过来的话，用户「重试」
  //    同一段音频会被多锁一次 —— 而他只是想再发一次。
  //
  // ⚠️ **结算不在这里**：成功/失败由 services/scoring.ts 在引擎返回后结算
  //    （成功实扣、失败退回，见 services/energy.ts 的说明）。这里只负责「占住」，
  //    这样并发提交不可能把同一份能量用两遍。
  //
  // ⚠️ 拒绝是 **429 + 明确 code**，不是 400：它是**业务规则**，不是「请求写错了」。
  //    客户端要据此给出可行动的提示，而不是一句「请求失败」。
  const locked = await holdChallengeEnergy(userId, submissionId)
  if (!locked) {
    return c.json(
      {
        ok: false,
        code: 'ENERGY_EXHAUSTED',
        energy: await readEnergy(userId),
        error: '能量不够了 —— 明天会补到 3 点，也可以充值',
      },
      429,
    )
  }

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
    // ⭐ 幂等键落库（见 db/schema.ts）—— 打分过程会改写 audioKey，但这一列永不变
    attemptId,
    status: 'scoring',
    heartbeatAt: new Date(),
    attempts: 1,
    scheduleDate,
    // ⭐ 已锁住 2 点，等打分返回再结算（见 services/energy.ts）
    energyState: 'held',
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

// ⚠️ describe() 已经搬到 services/submission-view.ts ——
//    因为分享页（GET /api/challenge/:sid，任何人可看）要用**同一份**结果，
//    两处各写一份的话，「本人看到的」和「分享出去看到的」迟早不一致。
