import { Hono } from 'hono'
import { and, eq } from 'drizzle-orm'
import { CONQUEST_THRESHOLD } from '@jushuo/shared'
import type { SubmitResponse } from '@jushuo/shared'
import { db } from '../db'
import { arenaEntries, arenas, users } from '../db/schema'
import { getEngine } from '../engines'
import { canSubmitFree, nextFreeAtFrom, trackInvalid } from '../services/cooldown'
import { getLeaderboardAround, getMyScore, getRank } from '../services/leaderboard'
import type { Variables } from '../middleware/auth'

export const submissionsRoutes = new Hono<{ Variables: Variables }>()

/**
 * ⭐ 提交检测 —— 全产品唯一花钱的地方。
 *
 * 流程：
 *   1. 冷却检查（会员不受限）
 *   2. 调用评分引擎（薄接口，只要一个 total）
 *   3. 写成绩（同场取最高分）、更新冷却
 *   4. 返回排名 / 差距 / 击败人数 / 是否刷新 / 是否征服
 */
submissionsRoutes.post('/', async (c) => {
  const userId = c.get('userId')
  const user = c.get('user')

  const form = await c.req.formData()
  const arenaId = Number(form.get('arenaId'))
  const audioFile = form.get('audio')

  if (!arenaId || !(audioFile instanceof File)) {
    return c.json({ ok: false, error: '缺少 arenaId 或 audio' }, 400)
  }

  // ---- 1. 冷却检查 ----
  const gate = canSubmitFree(user.nextFreeAt, user.subscriptionEnd)
  if (!gate.allowed) {
    return c.json(
      { ok: false, code: 'COOLDOWN', error: '挑战冷却中', nextFreeAt: user.nextFreeAt },
      429,
    )
  }

  const [arena] = await db.select().from(arenas).where(eq(arenas.id, arenaId)).limit(1)
  if (!arena) return c.json({ ok: false, error: '竞技场不存在' }, 404)

  // ---- 2. 评分 ----
  // ⚠️ 音频必须是裸 PCM（16k/16bit/单声道），WAV 要去掉头部，否则引擎会判「乱读」
  const raw = new Uint8Array(await audioFile.arrayBuffer())

  let result
  try {
    result = await getEngine().score({ refText: arena.content, audio: raw })
  } catch (err) {
    // 引擎侧判定无效（无有效语音 / 格式不符）→ 不消耗冷却，但计数防刷
    const today = new Date().toISOString().slice(0, 10)
    const { count, blocked } = trackInvalid(user.invalidCount, user.invalidDate, today)
    await db
      .update(users)
      .set({ invalidCount: count, invalidDate: today })
      .where(eq(users.id, userId))
    return c.json(
      { ok: false, error: (err as Error).message, blocked },
      blocked ? 429 : 400,
    )
  }

  const score = Math.round(result.total)
  const isConquered = score >= CONQUEST_THRESHOLD

  // ---- 3. 写成绩（同场取最高分） ----
  const previousBest = await getMyScore(arenaId, userId)
  const isPersonalBest = previousBest === null || score > previousBest

  if (isPersonalBest) {
    await db
      .insert(arenaEntries)
      .values({
        id: Date.now() * 1000 + Math.floor(Math.random() * 1000),
        arenaId,
        userId,
        score,
        isConquered,
        words: result.words ? JSON.stringify(result.words) : null,
      })
      .onConflictDoUpdate({
        target: [arenaEntries.arenaId, arenaEntries.userId],
        set: { score, isConquered, words: result.words ? JSON.stringify(result.words) : null },
      })
      .returning()

    await db
      .update(arenas)
      .set({ participantCount: arena.participantCount + (previousBest === null ? 1 : 0) })
      .where(eq(arenas.id, arenaId))
  }

  // ---- 4. 更新冷却（会员不变） ----
  const isMember = !!user.subscriptionEnd && user.subscriptionEnd > new Date()
  const nextFreeAt = isMember ? user.nextFreeAt : nextFreeAtFrom()
  await db.update(users).set({ nextFreeAt, invalidCount: 0 }).where(eq(users.id, userId))

  // ---- 5. 组装返回 ----
  const rankInfo = await getRank(arenaId, score)
  const leaderboard = await getLeaderboardAround(arenaId, userId)

  const payload: SubmitResponse = {
    score,
    rank: rankInfo.rank,
    participantCount: rankInfo.participantCount,
    gapToPrev: rankInfo.gapToPrev,
    beatenCount: rankInfo.beatenCount,
    isPersonalBest,
    isConquered,
    previousBest,
    nextFreeAt: nextFreeAt.toISOString(),
    leaderboard,
    words: result.words,
  }

  return c.json({ ok: true, data: payload })
})
