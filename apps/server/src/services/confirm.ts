import { and, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'

import { getStorage } from '../storage'
import { db } from '../db'
import { participations, submissions } from '../db/schema'
import { claimCookies, readCookies } from './cookies'
import { syncParticipation } from './participations'
import type { CookieView } from '@jushuo/shared'

/**
 * ⭐⭐ **确认 —— 唯一真正的结算**（prd §7.2，用户 2026-10 定）。
 *
 * ## 为什么要有它
 *
 * 出分之后用户可以**忽略那个面板**（甚至关掉小程序）。那时这一把**不该算进战绩** ——
 * 所以「出分」与「算数」必须是两个时刻，中间那一步就是这里：
 *
 *   出分（settle，算好分数 + 饼干快照） ⇒ **用户确认** ⇒ 写 `confirmed_at` ⇒ 参与记录才更新
 *
 * ⚠️⚠️ **参与记录的口径不在这里** —— 判据是 `services/participations.ts` 的 `scoredOf()`
 *    里那一行 `isNotNull(submissions.confirmedAt)`（**只有那一处**）。
 *    本文件只负责"把这一列写上"，然后调那个唯一的写入方。
 *
 * ## 语音文件的生命周期（跟着参与记录走）
 *
 * ⭐ 全站**只保留"当前最高分那一份"语音**：
 *   · 新分 > 前高 ⇒ 它成为参与记录指向的那一份（旧的那份在本次清理里被删）
 *   · 新分 < 前高 ⇒ 它自己那份被删，参与记录不动
 *   ⇒ 两句话其实是同一条规则：**除"当前最好"以外的语音，全部删掉**。
 *
 * ⚠️ **清理只在确认这里发生**（不在出分时、也不在下次提交时）。
 * ⚠️ 用户**永不确认** ⇒ 那次语音**不清理**，状态永久停在 `scored`（prd §7.2 明写）。
 * ⚠️ **不能碰还在 `scoring` 的那些行**：它们的音频正在被引擎读，删了就打完分了。
 */

/** 这一列只表达"确认"，不表达"领饼干" —— 但两者是同一个用户动作，所以出口一起给 */
export interface ConfirmOutcome {
  /** 这一次真的把"确认"落库了吗（false = 还没出分） */
  confirmed: boolean
  /** 这一次真的发了多少饼干（重复确认是 0，见 claimCookies 的说明） */
  claimed: number
  cookies: CookieView
  /** 顺手清掉了几份语音（诊断用） */
  audioPurged: number
}

/**
 * 确认一把提交。
 *
 * ⭐ **幂等**：重复确认不会重复记账、不会刷新 `confirmed_at`、不会再发饼干。
 *
 * ⚠️ 不属于本人的一律当**不存在**（返回 null，路由回 404）——
 *    与状态接口同一条：不区分 403/404，那会泄露 id 是否存在。
 */
export async function confirmSubmission(
  userId: number,
  submissionId: string,
): Promise<ConfirmOutcome | null> {
  const [row] = await db
    .select({
      id: submissions.id,
      articleId: submissions.articleId,
      status: submissions.status,
    })
    .from(submissions)
    .where(and(eq(submissions.id, submissionId), eq(submissions.userId, userId)))
    .limit(1)

  if (!row) return null

  /**
   * ① 饼干：沿用现有实现（读结算时落下的快照 + 查重）。
   * ⚠️ 顺序在"标记确认"**之前**不是必需的（快照与参与记录无关），
   *    但放前面更贴合语义：确认这个动作本来就包含"把这一把的奖励入账"。
   */
  const granted = await claimCookies(userId, submissionId)

  // ② 还没出分 ⇒ 没有可确认的东西（饼干那边也已经返回 0）
  if (row.status !== 'scored') {
    return {
      confirmed: false,
      claimed: granted?.claimed ?? 0,
      cookies: granted?.cookies ?? (await readCookiesOnly(userId)),
      audioPurged: 0,
    }
  }

  /**
   * ③ 标记确认。
   * ⚠️ `confirmed_at IS NULL` 这个条件让它**幂等** —— 重复确认不会把时间往后推
   *    （"第一次确认为准"，与 claim 的重复领取同口径）。
   */
  await db
    .update(submissions)
    .set({ confirmedAt: new Date() })
    .where(and(eq(submissions.id, submissionId), isNull(submissions.confirmedAt)))

  /**
   * ④ 参与记录 —— **唯一写入方**（services/participations.ts）。
   * ⚠️ 必须在 ③ **之后**：它只聚合 `confirmed_at` 非空的行。
   * ⚠️ 它在出分那一刻也会被调一次（services/scoring.ts），那时这一条还没确认
   *    ⇒ 算出来的还是原来那一行（空操作）。口径自己就对了，不用去删那段。
   */
  await syncParticipation(userId, row.articleId)

  // ⑤ 语音清理：只留参与记录指着的那一份
  const audioPurged = await purgeSupersededAudio(userId, row.articleId)

  return {
    confirmed: true,
    claimed: granted?.claimed ?? 0,
    cookies: granted?.cookies ?? (await readCookiesOnly(userId)),
    audioPurged,
  }
}

/** 兜底读一次余额（granted 为空时才会走到；正常路径用不到）。
 *  ⚠️ 静态导入而不是动态 import：cookies.ts 不反向依赖本文件，没有环。 */
async function readCookiesOnly(userId: number): Promise<CookieView> {
  return readCookies(userId)
}

/**
 * ⭐ 语音清理：**除"当前参与记录指向的那一份"以外，全删**。
 *
 * ⚠️ 判据是参与记录上的 `best_submission_id`（它的口径见 participations.ts）——
 *    所以"新分有没有超越前高"这件事**不需要在这里再判一次**：
 *    参与记录已经是"确认后的最高分"，谁不在里面谁就该删。
 *    ⚠️ 这也是为什么必须先 `syncParticipation` 再清理。
 *
 * ⚠️⚠️ **排除 `scoring` 的行**：那些音频正在被引擎读，删了就打不出分了。
 * ⚠️ 删文件失败**不抛**（记 warn 继续）：清理是省存储的卫生动作，
 *    不该让一次已经成立的确认变成 500。
 * ⚠️ 就算文件删失败，也要把 `audio_key` 置空 —— 否则下一轮还会去删一次、
 *    而且界面上会留一个**指向已删文件**的播放按钮（那比没有更糟）。
 */
async function purgeSupersededAudio(userId: number, articleId: string): Promise<number> {
  const [p] = await db
    .select({ best: participations.bestSubmissionId })
    .from(participations)
    .where(and(eq(participations.userId, userId), eq(participations.articleId, articleId)))
    .limit(1)

  // 还没有参与记录（这一把没出分 / 没确认）⇒ 没有"该留哪一份"的依据，什么都不删
  if (!p?.best) return 0

  const losers = await db
    .select({ id: submissions.id, audioKey: submissions.audioKey })
    .from(submissions)
    .where(
      and(
        eq(submissions.userId, userId),
        eq(submissions.articleId, articleId),
        isNotNull(submissions.audioKey),
        ne(submissions.id, p.best),
        // ⚠️ 只清**终结态**的：scoring 的音频正在被引擎读
        inArray(submissions.status, ['scored', 'failed']),
      ),
    )

  if (losers.length === 0) return 0

  const storage = getStorage()
  let purged = 0
  for (const row of losers) {
    try {
      if (row.audioKey) await storage.remove(row.audioKey)
      purged += 1
    } catch (err) {
      console.warn(
        '[confirm] 语音没删掉（继续）id=' + row.id + '：' + (err as Error).message,
      )
    }
    // ⚠️ 不论删没删成功都置空：留着它等于留一个指向已删文件的播放按钮
    await db
      .update(submissions)
      .set({ audioKey: null, audioUrl: null })
      .where(eq(submissions.id, row.id))
  }
  return purged
}
