import { Hono } from 'hono'
import { and, count, eq, sql } from 'drizzle-orm'
import { AUDIO_SPEC, CONQUEST_THRESHOLD } from '@jushuo/shared'
import type { SubmitResponse, WordScore } from '@jushuo/shared'
import { db } from '../db'
import { articles, submissions, users } from '../db/schema'
import { env } from '../env'
import { getEngine } from '../engines'
import { getStorage } from '../storage'
import { assertAudioKeyOwnedBy, makeSubmissionId } from '../services/audio-key'
import { nextSeq } from '../services/submission'
import { canSubmitFree, nextFreeAtFrom, trackInvalid } from '../services/cooldown'
import { getLeaderboardAround, getMyBest, getRank } from '../services/leaderboard'
import type { Variables } from '../middleware/auth'

export const submissionsRoutes = new Hono<{ Variables: Variables }>()

/**
 * ⭐ 提交检测 —— 全产品唯一花钱的地方。
 *
 * 顺序很讲究：
 *   1. **校验音频路径属于当前用户**（安全边界，最便宜的拒绝放最前）
 *   2. **幂等检查** —— 同一段音频已提交过就直接返回，**必须在冷却之前**
 *      （否则「重试」会被自己造成的冷却挡住，得到 429）
 *   3. 冷却检查
 *   4. 分配序列号 → 生成 submissionId(hash(userId, articleId, seq))
 *   5. 读音频 → 评分 → 写 submissions（每次一条，永久）
 *   6. 失败则删除音频对象
 *
 * ⚠️⚠️ 服务端不接受客户端传 fileID，只接受结构化路径并校验它。
 * ⚠️ 音频**永久保留**，只在检测失败时删除。
 */
submissionsRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const user = c.get('user')

  const body = await c.req.json<{ articleId?: number; audioKey?: string }>()
  const articleId = Number(body.articleId)
  const audioKey = body.audioKey
  if (!articleId || !audioKey) {
    return c.json({ ok: false, error: '缺少 articleId 或 audioKey' }, 400)
  }

  // ---- 1. ⚠️ 安全边界：路径必须属于当前用户 ----
  try {
    assertAudioKeyOwnedBy(audioKey, userId, articleId)
  } catch (err) {
    console.warn(`[submissions] 拒绝非法音频路径 user=${userId} key=${audioKey}`)
    return c.json({ ok: false, error: (err as Error).message }, 403)
  }

  // ---- 2. ⭐ 幂等：同一段录音只算一次提交 ----
  // 网络重试 / 用户连点都会走到这里。没有它就会重复扣冷却、多插一条记录。
  const [replay] = await db
    .select()
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.audioKey, audioKey),
        eq(submissions.status, 'scored'),
      ),
    )
    .limit(1)
  if (replay && replay.score !== null) {
    console.log(`[submissions] 幂等命中，重放结果 user=${userId} key=${audioKey}`)
    return c.json({
      ok: true,
      data: await buildResponse({
        articleId,
        userId,
        score: replay.score,
        isConquered: replay.isConquered ?? false,
        // 重放不是新成绩：不动冷却，也不显示进步
        isPersonalBest: false,
        previousBest: replay.score,
        nextFreeAt: user.nextFreeAt,
        words: replay.wordScores ? (JSON.parse(replay.wordScores) as WordScore[]) : undefined,
      }),
    })
  }

  // ---- 3. 冷却检查 ----
  const gate = canSubmitFree(user.nextFreeAt, user.memberUntil)
  if (!gate.allowed) {
    return c.json(
      { ok: false, code: 'COOLDOWN', error: '挑战冷却中', nextFreeAt: user.nextFreeAt },
      429,
    )
  }

  const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1)
  if (!article) return c.json({ ok: false, error: '文章不存在' }, 404)

  // ---- 4. 分配序列号 ----
  const seq = await nextSeq(userId, articleId)
  const submissionId = makeSubmissionId(userId, articleId, seq)

  // ---- 5. 读音频 + 评分 ----
  let audio: Uint8Array
  try {
    audio = await getStorage().get(audioKey)
  } catch (err) {
    return c.json({ ok: false, error: `读取音频失败: ${(err as Error).message}` }, 400)
  }

  const record = {
    id: submissionId,
    userId,
    articleId,
    seq,
    audioKey,
    engine: env.ENGINE,
    audioBytes: audio.byteLength,
    // 裸 PCM 16bit 单声道：字节数 ÷ 每秒字节数 = 秒数
    audioDurationMs: Math.round(
      (audio.byteLength / ((AUDIO_SPEC.sampleRate * AUDIO_SPEC.channels * AUDIO_SPEC.bitDepth) / 8)) *
        1000,
    ),
  }

  let result
  try {
    const refText = await articleRefText(article)
    result = await getEngine().score({ refText, audio })
  } catch (err) {
    const reason = (err as Error).message

    // 检测失败 → 记一条 failed（序列号递增），并删除音频
    await db
      .insert(submissions)
      .values({ ...record, status: 'failed', failReason: reason.slice(0, 255) })
      .catch(() => {})
    await getStorage().remove(audioKey).catch((e) => {
      console.warn(`[submissions] 删除无效音频失败 key=${audioKey}:`, (e as Error).message)
    })

    const today = new Date().toISOString().slice(0, 10)
    const { count: invalidCount, blocked } = trackInvalid(user.invalidCount, user.invalidDate, today)
    await db.update(users).set({ invalidCount, invalidDate: today }).where(eq(users.id, userId))
    return c.json({ ok: false, error: reason, blocked }, blocked ? 429 : 400)
  }

  const score = Math.round(result.total)
  const isConquered = score >= CONQUEST_THRESHOLD

  // 是否第一次提交 / 第一次征服（用于更新 articles 的冗余计数）
  const isFirstSubmission = seq === 1
  const [priorConquer] = await db
    .select({ n: count() })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.articleId, articleId),
        eq(submissions.isConquered, true),
      ),
    )
  const isFirstConquer = isConquered && Number(priorConquer?.n ?? 0) === 0

  // 本次之前的最高分（要在插入之前取）
  const before = await getMyBest(articleId, userId)
  const previousBest = before ? before.score : null
  const isPersonalBest = previousBest === null || score > previousBest

  // ---- 6a. 写提交记录（每次一条，永久）----
  await db.insert(submissions).values({
    ...record,
    status: 'scored',
    score,
    isConquered,
    wordScores: result.words ? JSON.stringify(result.words) : null,
    scoredAt: new Date(),
  })

  // ---- 6b. 更新文章的参与/征服计数 ----
  await db
    .update(articles)
    .set({
      participantCount: sql`${articles.participantCount} + ${isFirstSubmission ? 1 : 0}`,
      conqueredCount: sql`${articles.conqueredCount} + ${isFirstConquer ? 1 : 0}`,
    })
    .where(eq(articles.id, articleId))

  // ---- 7. 更新冷却（会员不变）----
  const isMember = !!user.memberUntil && user.memberUntil > new Date()
  const nextFreeAt = isMember ? user.nextFreeAt : nextFreeAtFrom()
  await db.update(users).set({ nextFreeAt, invalidCount: 0 }).where(eq(users.id, userId))

  return c.json({
    ok: true,
    data: await buildResponse({
      articleId,
      userId,
      score,
      isConquered,
      isPersonalBest,
      previousBest,
      nextFreeAt,
      words: result.words,
    }),
  })
})

/** 组装返回 —— 正常提交与幂等重放共用，避免两处逻辑漂移 */
async function buildResponse(input: {
  articleId: number
  userId: number
  score: number
  isConquered: boolean
  isPersonalBest: boolean
  previousBest: number | null
  nextFreeAt: Date
  words?: WordScore[]
}): Promise<SubmitResponse> {
  const [rankInfo, leaderboard] = await Promise.all([
    getRank(input.articleId, input.userId),
    getLeaderboardAround(input.articleId, input.userId),
  ])
  return {
    score: input.score,
    rank: rankInfo.rank,
    participantCount: rankInfo.participantCount,
    gapToPrev: rankInfo.gapToPrev,
    beatenCount: rankInfo.beatenCount,
    isPersonalBest: input.isPersonalBest,
    isConquered: input.isConquered,
    previousBest: input.previousBest,
    nextFreeAt: input.nextFreeAt.toISOString(),
    leaderboard,
    words: input.words,
  }
}

/**
 * 取评分的参考文本。
 *
 * ⚠️ 正文在静态 JSON 里（articles.contentJson 是它的地址），所以这里要 fetch。
 *    这是「内容不入库」的必然代价：评分前多一次可缓存的 HTTPS 请求。
 *
 * ⚠️ 内容流水线还没建（tools/pipeline 是桩），所以：
 *    · contentJson 是 http(s) 地址 → fetch 并取 .text
 *    · 其它情况（相对路径 / 占位）→ 返回空串，让 mock 链路能跑通；
 *      词级数据要等真实内容接入后才有。
 */
async function articleRefText(article: typeof articles.$inferSelect): Promise<string> {
  const url = article.contentJson
  if (/^https?:\/\//.test(url)) {
    try {
      const res = await fetch(url)
      if (res.ok) {
        const data = (await res.json()) as { text?: string }
        if (typeof data.text === 'string' && data.text) return data.text
      }
      console.warn(`[submissions] 正文 JSON 无法解析：${url}`)
    } catch (err) {
      console.warn(`[submissions] 拉取正文失败 ${url}:`, (err as Error).message)
    }
  }
  return ''
}
