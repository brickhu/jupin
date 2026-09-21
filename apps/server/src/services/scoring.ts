import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { CONQUEST_THRESHOLD, dayKey, latestBadge } from '@jushuo/shared'
import type { StreakDelta } from '@jushuo/shared'
import { db } from '../db'
import { articles, submissions, users } from '../db/schema'
import { getEngine } from '../engines'
import { getStorage } from '../storage'
import { trackInvalid } from './quota'
import { loadArticleRefText } from './content'
import { getMyBest } from './leaderboard'
import { normalizeAudio, PCM_BYTES_PER_SEC } from './audio'
import { recordRead } from './streak'

/**
 * ⭐ 打分任务 —— 全产品唯一花钱的地方，也是唯一「慢」的地方。
 *
 * ══════════════════════════════════════════════════════════════════
 * ⚠️⚠️ 为什么打分必须和「提交」这个请求**解耦**：
 *
 *   一次讯飞评测实测 **9.8 秒**（8.8 秒音频），长句要 15 秒以上。
 *   而云托管 callContainer 的**单次超时上限是 15 秒**（硬限制，写多大都无效）。
 *   ⇒ 一个请求**装不下**一次打分，这不是调参能解决的。
 *
 *   曾经的做法是「请求里同步等打分，客户端超时后重试」，
 *   于是被迫设一个「总预算 50 秒」之类的固定上限 —— 那等于**给句子长度设了上限**：
 *   更长的句子、更慢的引擎，迟早会撞上去，而撞上去的表现是用户永远拿不到分。
 *
 *   ⇒ 正确形态：**受理与打分分开**。
 *       POST  受理 → 立刻返回 submissionId（202）
 *       后台  跑评测，边跑边刷心跳
 *       GET   轮询状态 → scoring / scored / failed
 *
 *   这样链路上**没有任何「打分最多能跑多久」的假设**。
 *   唯一的判据是**心跳**：那个进程还活着吗？
 *   跑 60 秒也行，只要它每几秒证明一次自己还在。
 * ══════════════════════════════════════════════════════════════════
 */

/** 打分进程刷新心跳的间隔 */
const HEARTBEAT_INTERVAL_MS = 5_000

/**
 * 心跳多久没刷新就认为「那个进程已经死了」。
 *
 * ⚠️ 这是**存活判据**，不是时长上限：它限制的是「多久没动静」，
 *    而不是「打分最多跑多久」。一个跑了 5 分钟但一直在心跳的任务完全正常。
 *    取 30 秒 = 心跳间隔的 6 倍，容忍几次数据库抖动。
 */
const HEARTBEAT_TIMEOUT_MS = 30_000

/**
 * 同一条音频最多被尝试打分几次。
 * ⚠️ 同样是防死循环的闸，不是时长限制：接管只在心跳超时后发生。
 */
export const MAX_SCORING_ATTEMPTS = 3

/**
 * ⭐ 原子地「认领」一个心跳已停的打分任务。
 *
 * ⚠️ 必须是一条**带条件的 UPDATE**，不能先查后写：
 *    并发轮询会有多个请求同时发现「它死了」，先查后写会让它们全都去跑评测
 *    —— 重复计费，而且后写的那个会把先写的分数覆盖掉。
 *    UPDATE ... WHERE 由数据库保证只有一个请求的 affectedRows 是 1。
 *
 * @returns true = 本次调用认领成功，调用方负责把它跑完
 */
export async function claimStaleScoring(submissionId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - HEARTBEAT_TIMEOUT_MS)
  const [header] = await db
    .update(submissions)
    .set({
      heartbeatAt: new Date(),
      attempts: sql`${submissions.attempts} + 1`,
    })
    .where(
      and(
        eq(submissions.id, submissionId),
        eq(submissions.status, 'scoring'),
        lt(submissions.attempts, MAX_SCORING_ATTEMPTS),
        or(isNull(submissions.heartbeatAt), lt(submissions.heartbeatAt, staleBefore)),
      ),
    )
  return (header as unknown as { affectedRows?: number })?.affectedRows === 1
}

/**
 * 在打分期间持续刷心跳，直到返回的 stop() 被调用。
 *
 * ⚠️ 必须 unref()：否则这个定时器会拖住 Node 进程不退出，
 *    而它在容器里是常驻的 —— 会让优雅关闭永远等下去。
 */
function startHeartbeat(submissionId: string): () => void {
  const timer = setInterval(() => {
    db.update(submissions)
      .set({ heartbeatAt: new Date() })
      .where(and(eq(submissions.id, submissionId), eq(submissions.status, 'scoring')))
      .catch((err: Error) => console.warn('[scoring] 心跳失败:', err.message))
  }, HEARTBEAT_INTERVAL_MS)
  timer.unref?.()
  return () => clearInterval(timer)
}

/**
 * 执行一次打分。**幂等**：只有状态还是 scoring 时才干活，被打完的直接返回。
 *
 * ⚠️ 这个函数**永远不抛**：它跑在后台（POST 不 await 它），
 *    抛出去就是 unhandledRejection，会直接把容器带崩。
 *    所有失败都落进 status='failed' + fail_reason。
 */
export async function runScoring(submissionId: string): Promise<void> {
  const stop = startHeartbeat(submissionId)
  try {
    const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
    // 已被别的请求打完 / 判失败 —— 什么都不做
    if (!row || row.status !== 'scoring') return

    const { userId, articleId, audioKey, seq, audioUrl } = row

    const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1)
    if (!article) return fail(submissionId, '文章不存在')

    // ---- 读音频 ----
    // ⚠️ 顺序：先试客户端给的带签名地址，再退回对象存储。
    //    签名地址会过期，所以**两条都要试**，只试一条会在大约一小时后突然开始失败。
    let audio: Uint8Array | null = null
    let readError = ''
    if (audioUrl) {
      try {
        audio = await downloadSigned(audioUrl)
      } catch (err) {
        readError = (err as Error).message
      }
    }
    if (!audio) {
      try {
        audio = await getStorage().get(audioKey ?? '')
      } catch (err) {
        readError = readError ? `${readError}；对象存储：${(err as Error).message}` : (err as Error).message
      }
    }
    if (!audio) return fail(submissionId, `读取音频失败: ${readError}`)

    // ---- 归一化 + 评测 ----
    let audioBytes = audio.byteLength
    let audioDurationMs = Math.round((audio.byteLength / PCM_BYTES_PER_SEC) * 1000)
    let result

    try {
      // ⭐⭐ 归一化 —— 客户端传上来的**不一定是裸 PCM**：同一份代码，
      //    开发者工具直出 WebM/Opus 容器（实测 8.82 秒、过零率 0.156 = 标准语音），
      //    真机直出无头裸 PCM。设备产出什么格式，客户端说了不算，
      //    所以只能在服务端（唯一装得起解码器的地方）统一。
      const normalized = await normalizeAudio(audio)
      if (normalized.transcoded) {
        console.log(
          `[scoring] 音频归一化 id=${submissionId} ${normalized.container} ${audio.byteLength} 字节` +
            ` → 16k PCM ${normalized.pcm.byteLength} 字节`,
        )
      }
      // ⚠️ 归一化后字节数变了，这两个字段必须**一起**改：
      //    WebM 8.8 秒才 143KB，解码成 PCM 是 282KB —— 只改一个就会让时长与字节数互相矛盾。
      audioBytes = normalized.pcm.byteLength
      audioDurationMs = Math.round((normalized.pcm.byteLength / PCM_BYTES_PER_SEC) * 1000)

      const refText = await loadArticleRefText(article.contentJson)
      result = await getEngine().score({ refText, audio: normalized.pcm })
    } catch (err) {
      return fail(submissionId, (err as Error).message)
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

    // ⚠️ 这里只是**打日志**用的。结果页要的 previousBest / isPersonalBest
    //   由 describe() 现算 —— 轮询会反复调用它，那些字段必须是幂等的
    //   （见 routes/submissions.ts 的说明）。
    //    ⚠️ 按**句子**算：句子就是竞技场，日期只是首页列表上的一个格子。
    const previousBest = await getMyBest(articleId, userId)
void previousBest

    // ⚠️ 带 status='scoring' 条件：如果这条已经被接管者打完（理论上不会，
    //    认领是原子的），这里就不该覆盖别人的结果。
    const [header] = await db
      .update(submissions)
      .set({
        status: 'scored',
        score,
        isConquered,
        // ⚠️ 归一化后字节数/时长变了，必须一起写回来
        audioBytes,
        audioDurationMs,
        wordScores: result.words ? JSON.stringify(result.words) : null,
        dimensions: result.dimensions ? JSON.stringify(result.dimensions) : null,
        scoredAt: new Date(),
      })
      .where(and(eq(submissions.id, submissionId), eq(submissions.status, 'scoring')))
    if ((header as unknown as { affectedRows?: number })?.affectedRows !== 1) {
      console.warn(`[scoring] 结果未写入（状态已变）id=${submissionId}`)
      return
    }

    // ---- 文章的参与/征服计数 ----
    await db
      .update(articles)
      .set({
        participantCount: sql`${articles.participantCount} + ${isFirstSubmission ? 1 : 0}`,
        conqueredCount: sql`${articles.conqueredCount} + ${isFirstConquer ? 1 : 0}`,
      })
      .where(eq(articles.id, articleId))

    // ---- 无效提交计数归零 ----
    //
    // ⚠️ 原来这里还顺手写 next_free_at（24 小时滚动冷却）。
    //    冷却已经下线，改成「每句额度 + 固定间隔」—— 额度是**从 submissions 现算**的，
    //    不需要在 users 上再存一个会漂移的副本（那正是原来那套的两个真相）。
    //    这里只剩「这次是有效提交，把无效计数清零」。
    await db.update(users).set({ invalidCount: 0 }).where(eq(users.id, userId))

    // ---- ⭐ Streak：今天读了一句 ----
    //
    // ⚠️ 位置很关键：**必须在「真实打分成功」之后**。
    //    放到受理那一步会让「音频读不出来 / 引擎拒绝」也算作今天读过 ——
    //    streak 一旦能靠失败拿到，它就不再代表任何东西。
    //
    // ⚠️⚠️ 而「是哪一天」用的是 **submissions.created_at（受理那一刻）**，
    //    不是打分完成的时刻，也**不是** challenge_date：
    //
    //      · challenge_date 是「首页那张列表上的哪一格」，用户可以对**往日**的挑战
    //        点「再次挑战」，那时它是个过去的日期 —— 拿它记 streak，
    //        等于允许用户回到过去补签，或者反过来把今天的读记成上周的。
    //        **streak 与首页的日期列表无关。**
    //
    //      · 也不能用「此刻」（today()）：受理和打分完成之间隔着 10–20 秒，
    //        跨零点时会把一次 23:59 的提交记到第二天；
    //        更糟的是打分被接管重跑时，可能已经过去好几个小时、甚至跨天。
    //        用户「实际提交的时间」是受理那一刻，它不随时间流逝而改变。
    const read = await recordRead(userId, dayKey(row.createdAt))

    // ⚠️ streak 的变化量必须**落库**：结果由轮询取回，
    //    而「+1 / 用掉几张冻结卡 / 解锁了哪个徽章」只在 recordRead 这一刻算得出来。
    //    不存下来，结果页就只剩一个光秃秃的天数 ——
    //    用户根本不知道冻结卡刚刚救了他一次。
    await db
      .update(submissions)
      .set({
        streakDelta: JSON.stringify({
          streakDays: read.state.streakDays,
          streakBest: read.state.streakBest,
          freezeCount: read.state.freezeCount,
          counted: read.counted,
          delta: read.delta,
          freezeUsed: read.freezeUsed,
          freezeEarned: read.freezeEarned,
          newBadges: read.newBadges,
          badge: latestBadge(read.state.streakBest),
        } satisfies StreakDelta),
      })
      .where(eq(submissions.id, submissionId))

    console.log(`[scoring] 完成 id=${submissionId} score=${score}`)
  } catch (err) {
    // ⚠️ 兜底：后台任务抛出去就是 unhandledRejection，会把容器带崩
    console.error(`[scoring] 未预期异常 id=${submissionId}:`, (err as Error).message)
    await fail(submissionId, (err as Error).message)
  } finally {
    stop()
  }
}

/**
 * 判失败：写状态、删音频（音频只在失败时删；成功永久保留）。
 * ⚠️ 导出给路由用 —— 「重跑次数用尽」是路由发现的，但它得走同一套收尾逻辑。
 */
export async function markScoringFailed(submissionId: string, reason: string): Promise<void> {
  return fail(submissionId, reason)
}

/** 判失败：写状态、删音频（音频只在失败时删；成功永久保留） */
async function fail(submissionId: string, reason: string): Promise<void> {
  console.warn(`[scoring] 失败 id=${submissionId}: ${reason}`)
  const [row] = await db
    .update(submissions)
    .set({ status: 'failed', failReason: reason.slice(0, 255) })
    .where(and(eq(submissions.id, submissionId), eq(submissions.status, 'scoring')))
  if ((row as unknown as { affectedRows?: number })?.affectedRows !== 1) return

  const [failed] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
  if (failed?.audioKey) {
    await getStorage()
      .remove(failed.audioKey)
      .catch((e: Error) => console.warn('[scoring] 删除无效音频失败:', e.message))
  }

  // ⭐ 无效提交计数（防刷）—— 复用原来同步版本的行为：
  //    连续读不出有效语音就当天封停，否则「随便传个静音」是免费的。
  //    ⚠️ 只在**引擎判无效**时计，读音频失败（网络/对象存储）不计 ——
  //       那是我们的问题，不该罚用户。
  if (failed && !/读取音频失败/.test(reason)) {
    const [u] = await db.select().from(users).where(eq(users.id, failed.userId)).limit(1)
    if (u) {
      const day = new Date().toISOString().slice(0, 10)
      const { count, blocked } = trackInvalid(u.invalidCount, u.invalidDate, day)
      await db.update(users).set({ invalidCount: count, invalidDate: day }).where(eq(users.id, u.id))
      if (blocked) console.warn(`[scoring] 当日无效提交超限 user=${u.id}`)
    }
  }
}

/** 按带签名地址下载音频（地址的有效性已在提交时校验过） */
async function downloadSigned(audioUrl: string): Promise<Uint8Array> {
  const res = await fetch(audioUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
