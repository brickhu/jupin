import { and, eq, isNull, lt, or, sql } from 'drizzle-orm'
import { scoreSentence, speechGaps } from '@jushuo/shared'
import type { StreakDelta } from '@jushuo/shared'
import { db } from '../db'
import { articles, submissions, users } from '../db/schema'
import { env } from '../env'
import { getEngine } from '../engines'
import { EngineRejectedError } from '../engines/types'
import { getStorage } from '../storage'
import { trackInvalid } from './submission'
import { releaseChallengeEnergy } from './energy'
import { settle } from './settle'
import { generateCoachFeedback, llmConfigOf } from './coach'
import type { CoachFacts } from './coach'
import { loadArticleRefText } from './content'
import { getMyBest } from './leaderboard'
import { syncParticipation } from './participations'
import { normalizeAudio, PCM_BYTES_PER_SEC } from './audio'
import { archiveRecording } from './recording'

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
  /**
   * ⭐ 分段计时 —— 这条链路是用户能感觉到的"慢"的唯一来源，而它的各段（读音频 /
   *    归一化 / 讯飞 / 落库）差着数量级，靠猜必然猜错（见本文件头的耗时说明）。
   *    一行为一次打分，日志里直接能读出是谁在花时间。
   */
  const mark = { start: Date.now(), audioRead: 0, normalized: 0, engineDone: 0 }
  try {
    const [row] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
    // 已被别的请求打完 / 判失败 —— 什么都不做
    if (!row || row.status !== 'scoring') return

    const { userId, articleId, audioKey, audioUrl } = row

    const [article] = await db.select().from(articles).where(eq(articles.id, articleId)).limit(1)
    /** ⚠️ 句子不在库里是**我们的问题** ⇒ infra（不扣用户） */
    if (!article) return fail(submissionId, '文章不存在', 'infra')

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
    if (!audio) return fail(submissionId, `读取音频失败: ${readError}`, 'infra')
    mark.audioRead = Date.now()

    // ---- 归一化 + 评测 ----
    let audioBytes = audio.byteLength
    let audioDurationMs = Math.round((audio.byteLength / PCM_BYTES_PER_SEC) * 1000)
    /** 归一化后的 16k PCM —— 打分用它，打完之后再拿它编一份 mp3 存档 */
    let pcmForArchive: Uint8Array | null = null
    let result

    try {
      // ⭐⭐ 归一化 —— 客户端传上来的**不一定是裸 PCM**：同一份代码，
      //    开发者工具直出 WebM/Opus 容器（实测 8.82 秒、过零率 0.156 = 标准语音），
      //    真机直出无头裸 PCM。设备产出什么格式，客户端说了不算，
      //    所以只能在服务端（唯一装得起解码器的地方）统一。
      const normalized = await normalizeAudio(audio)
      // ⭐ 留着给打完分之后存档用（见下面 archiveRecording）——
      //    编 mp3 要用**解码后的** PCM，而不是上传上来的那份原始字节。
      pcmForArchive = normalized.pcm
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
      mark.normalized = Date.now()

      const refText = await loadArticleRefText(article.id)
      result = await getEngine().score({ refText, audio: normalized.pcm })
      mark.engineDone = Date.now()
    } catch (err) {
      /**
       * ⭐⭐ **计费分界就在这里**（用户 2026-10-15 定：「成功调用了讯飞检测 ⇒
       *    不管它反馈什么，都扣除；事务失败 ⇒ 回退」）。
       *
       *    · `EngineRejectedError` = 引擎**答了**（说这段音频没读出有效语音）
       *      ⇒ `invalid` ⇒ **扣**（我们真的调了引擎、也真的付了钱）
       *    · 其它（音频归一化失败 / 读正文失败 / 网络 / 引擎格式异常）
       *      ⇒ `infra` ⇒ **退回**（这一把等于没发生）
       *
       * ⚠️⚠️ 这个 try 里**混着两种性质**的失败，所以判据必须是**类型**，不能是文案
       *    （按文案匹配的话，改一个字规则就静默失效 —— 见 fail() 上那段说明）。
       */
      const kind = err instanceof EngineRejectedError ? 'invalid' : 'infra'
      return fail(submissionId, (err as Error).message, kind)
    }

    /**
     * ⭐ 总分按**校准后的权重**算（见 @jushuo/shared 的 scoring.ts 与
     *    docs/research/scoring-standard.md）—— 权重来自「母语级 TTS vs 真实录音」的实测差距，
     *    不是拍的：韵律 0.35 / 发音短板 0.30 / 准确 0.15 / 流利 0.15 / 完整 0.05。
     *
     * ⚠️ 词级数据缺失时退回引擎总分，而不是记 0 分：
     *    「这次没拿到词级数据」和「我读了一整句全错」是两件事，
     *    后者会让用户莫名其妙丢一次机会。
     */
    const words = result.words ?? []
    const gaps = speechGaps(words)
    const breakdown = scoreSentence(words, {
      ...(result.dimensions ?? {}),
      ...(result.syllableErrorRate === undefined ? {} : { syllableErrorRate: result.syllableErrorRate }),
      longGapCount: gaps.longGapCount,
      longestGapMs: gaps.longestGapMs,
    })
    const score = breakdown?.score ?? Math.round(result.total)
    if (!breakdown) {
      console.warn('[scoring] 这次返回没有词级数据，退回引擎总分 ' + score + ' id=' + submissionId)
    } else if (breakdown.gates.length > 0) {
      console.log('[scoring] id=' + submissionId + ' 触发门槛：' + breakdown.gates.join('；'))
    }

    /**
     * ⭐ **AI 锐评不在关键路径上**（prd §7.2b · 用户 2026-10-16 的口径：分数先出）。
     *
     * ⚠️⚠️ 原来这里是 `const coach = await generateCoachFeedback(...)`，**在翻 `scored` 之前** ——
     *    于是用户必须多等一次模型调用（本机实测 1.3–4.4 秒，超时上限 12 秒），
     *    而它只是锦上添花的批语。现在：**先把分数落库并翻状态**，
     *    紧接着 `void attachCoachRemark(...)` 在后台生成、**二次 UPDATE 补写**
     *    （形状与 confirm.ts 的 AI 总结一致 —— 那里也是 `void` + `.catch()`）。
     *
     * ⚠️ 代价（明确接受）：容器若在写完分数的瞬间被回收，这次就没有批语 ——
     *    和"模型调用失败"是同一种结果（`ai_comment` 为 null，端侧整块不渲染）。
     */

    /**
     * ⚠️⚠️ 这里曾经写一个 submissions.is_conquered 标记，并用它数出
     *    「这个用户在这条句子上是不是第一次拿到分」，再据此累加 articles 上的
     *    participant_count / conquered_count 两个冗余计数。**三样都删了**：
     *
     *      · is_conquered 与 status='scored' **同义**，而老数据那一列是按已废除的
     *        85 分线写的（false）—— 任何读它的统计都会漏掉真实的攻克。
     *        全仓库别处早改成读 status 了（见 services/conquest.ts），只剩这里还在读它。
     *      · 两个冗余计数**没有任何代码在读**：竞技口径一律**从 submissions 派生**
     *        （当时是 services/leaderboard.ts 的 COUNT(DISTINCT user_id)；
     *         2026-09 起改由参与记录 participations 承担 —— 同样是「从 submissions 派生」，
     *         只是把派生结果物化成一人一行，见 services/participations.ts）。
     *        留着不但会漂移，而且这段「对齐」逻辑本身就在用那个不可靠的列。
     *
     *    ⇒ 「几个人参与 / 几个人攻克」只有一个**真相**：**submissions 表**；
     *      participations 只是它的派生索引。攻克的口径只有一条：status = 'scored'。
     */

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
        // ⭐ 能量**结算**：打分成功 → 受理时锁住的那 2 点变成实扣
        energyState: 'charged',
        // ⚠️ DECIMAL 列要字符串（见 schema 里的说明）；数值本身是一位小数
        score: score.toFixed(1),
        // ⚠️ 归一化后字节数/时长变了，必须一起写回来
        audioBytes,
        audioDurationMs,
        wordScores: result.words ? JSON.stringify(result.words) : null,
        dimensions: result.dimensions ? JSON.stringify(result.dimensions) : null,
        /**
         * ⭐⭐ **AI 锐评**（prd §7.2b）—— 40–70 字、有观点有画面的那一条。
         * ⚠️ 这里是**先留空**：分数一落库就翻 scored（用户立刻能看到分），
         *    锐评由下面的 `attachCoachRemark` 写好之后二次 UPDATE 补进来。
         * ⚠️ 只有这一个字段：原来的 `ai_advice`（2-3 句练法）已删 ——
         *    讯飞自己的反馈报告已经很全面（用户 2026-10-15），我们再说一遍是同一件事两处。
         */
        aiComment: null,
        /** ⭐ 海报标签（≤6 字）—— 分享卡用；缺了不影响锐评 */
        aiTag: null,
        // 分项明细 —— 结果页要靠它解释「这分是怎么来的」（见 schema 里的说明）
        scoreParts: breakdown ? JSON.stringify(breakdown) : null,
        scoredAt: new Date(),
      })
      .where(and(eq(submissions.id, submissionId), eq(submissions.status, 'scoring')))
    if ((header as unknown as { affectedRows?: number })?.affectedRows !== 1) {
      console.warn(`[scoring] 结果未写入（状态已变）id=${submissionId}`)
      return
    }

    /**
     * ⭐ **分段耗时**（唯一一处"这次为什么慢"的证据）—— 讯飞那一段是花钱的，
     *   所以它单独一格；读音频/归一化在云上是两趟网 + 一个 ffmpeg。
     * ⚠️ 这一行**必须在翻 scored 之后**：它就是"用户等到分数"的那一刻。
     */
    console.log(
      '[scoring] 耗时 id=' + submissionId +
        ' 读音频=' + (mark.audioRead - mark.start) + 'ms' +
        ' 归一化=' + (mark.normalized - mark.audioRead) + 'ms' +
        ' 讯飞=' + (mark.engineDone - mark.normalized) + 'ms' +
        ' 落库=' + (Date.now() - mark.engineDone) + 'ms' +
        '（锐评不计入：已移出关键路径）',
    )

    /**
     * ⭐⭐ **AI 锐评现在才生成** —— 不 await（见上面那段说明）。
     *
     * ⚠️ 用 `void` + 自带 catch：它跑在后台，抛出去就是 unhandledRejection，会把容器带崩；
     *    而"没有批语"是这里唯一允许的失败形态。
     */
    if (breakdown) {
      const facts = {
        score,
        parts: breakdown,
        refText: await loadArticleRefText(article.id),
        /**
         * ⭐ **句子语境**（2026-10-15 加）：锐评要"有内味儿"就得知道这句在说什么，
         *    否则模型只能干巴巴复述分数与错误（"发音准确 82 分"）。
         */
        translation: article.translation,
        tags: article.tags ?? [],
        weakWords: [...words]
          .sort((a, b) => a.score - b.score)
          .slice(0, 3)
          .map((w) => ({ word: w.word, score: w.score, dp: w.dp })),
        badPhones: words.flatMap((w) => w.badPhones ?? []),
        ...(result.syllableErrorRate === undefined
          ? {}
          : { syllableErrorRate: result.syllableErrorRate }),
        longGapCount: gaps.longGapCount,
        gated: breakdown.gates.length > 0,
      }
      void attachCoachRemark(submissionId, facts)
    }

    /**
     * ⭐⭐ **参与记录跟着结算一起更新**（唯一写入方见 services/participations.ts）。
     *
     * ⚠️ 位置：分数已经落库**之后**。它是派生索引 —— 这一步失败不该让一条已经成立的
     *    成绩变成 failed（所以整块 try 住、只 warn），对账/重建能把它补回来。
     * ⚠️ 传的是 (userId, articleId)：参与的单位是**句子**（一句 = 一个竞技场），
     *    不是"这次提交"—— 一次挑战只更新那一行参与。
     */
    try {
      await syncParticipation(userId, articleId)
    } catch (err) {
      console.warn(
        '[scoring] 参与记录没跟上（可重建）id=' + submissionId + '：' + (err as Error).message,
      )
    }

    /**
     * ⭐⭐ 存档：把这次录音转成 mp3 存下来，删掉原件。
     *
     * ⚠️ 位置在「分数已经落库」**之后**：存档是省存储的动作，
     *    它失败不该影响任何一条已经成立的成绩（所以整块 try 住、只 warn）。
     * ⚠️ 用**归一化后的 PCM** 编码（上传上来的可能是 PCM、也可能是 WebM）。
     * ⚠️ 重跑时会重新读一次 audioKey —— 那时它已经指向 mp3 了，
     *    解码出来照样能打分（只会有极微小的差别，而这种情况极少发生）。
     * ⚠️ 换 key 之后 audioUrl（客户端上传时给的签名地址）就作废了，一并清掉：
     *    留着它，下次重跑会先去试那个已经指向**被删掉的原件**的地址。
     */
    if (pcmForArchive) {
      try {
        const stored = await archiveRecording(audioKey ?? '', pcmForArchive)
        if (stored) {
          await db
            .update(submissions)
            .set({ audioKey: stored, audioUrl: null })
            .where(eq(submissions.id, submissionId))
        }
      } catch (err) {
        console.warn(
          '[scoring] 录音存档失败（保留原件）id=' + submissionId + '：' + (err as Error).message,
        )
      }
    }

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
    // ⭐⭐ 打分成功之后的**唯一结算入口**：streak + 三个成长指标 + 奖励规则，
  //    全在 services/settle.ts 里（轮询 / 重放 / 接管都不结算）。
  //    ⚠️ 位置必须在「分数已经落库」之后 —— 成长值要拿这个分去跟历史比。
  const settled = await settle(userId, submissionId)
  if (settled) {
    console.log(
      '[scoring] 结算 id=' + submissionId +
        ' streak=' + settled.streakDays +
        ' cookies=' + settled.cookies.earned + '(line ' + settled.cookies.passLine + ')' +
        ' rewards=' + settled.rewards.length,
    )
  }

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
  /**
   * ⚠️⚠️ **kind 必须是 `'infra'`**（2026-09 定，别退回默认值）：
   *    能走到这里只有两种情形 —— 进程崩了留下悬空行（sweep 判死）、或重跑次数用尽。
   *    两种都**没有得到任何结论**（引擎从没返回过）⇒ 按"没触达"处理：
   *    **整行删掉 + 退能量**，不给序号、不进历史。
   *    ⚠️ 用默认的 `'invalid'` 会给这种行分配序号并显示成「未出分」——
   *      那是在编造一个不存在的结论（而且白占一个号）。
   */
  return fail(submissionId, reason, 'infra')
}

/** 判失败：写状态、删音频（音频只在失败时删；成功永久保留） */
/**
 * @param kind `'invalid'` = **引擎判无效**（音频里没读出有效语音）；
 *             `'infra'`   = **我们这边的问题**（读音频失败 / 网络 / 解析异常）。
 *
 * ⚠️⚠️ 为什么要这个参数：原来靠 `/读取音频失败/` **匹配 reason 文案**来判断
 *    该不该计入防刷 —— 业务规则挂在文案上，改一个字（比如去掉"的"）防刷就
 *    **静默失效**，而且没有任何测试会发现。现在由**抛错的地方**显式说明它是哪一种。
 */
  async function fail(submissionId: string, reason: string, kind: 'invalid' | 'infra' = 'invalid'): Promise<void> {
    console.warn(`[scoring] 失败 id=${submissionId}: ${reason}`)

    /**
     * ⚠️ 先把行读出来：分配序号需要 `(userId, articleId)`，而它们只有行上有。
     *    ⚠️ 顺序**必须**是"先读 → 算序号 → 再更新"：
     *      序号要在同一句 `UPDATE` 里写进去（否则会出现"改了状态但没号"的中间态）。
     */
    const [before] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)
    if (!before) return

    /**
     * ⚠️ 只写状态与原因 —— **序号已经不存在了**（"第几次"改成读的时候现算，见
     *    `attemptNoOf`）。所以这里不会再有"给不给号"的分支，也不会再撞唯一键。
     */
    const [row] = await db
      .update(submissions)
      .set({ status: 'failed', failReason: reason.slice(0, 255) })
      .where(and(eq(submissions.id, submissionId), eq(submissions.status, 'scoring')))
    if ((row as unknown as { affectedRows?: number })?.affectedRows !== 1) return
    const [failed] = await db.select().from(submissions).where(eq(submissions.id, submissionId)).limit(1)

  /**
   * ⭐ 能量**结算**：失败就退回受理时锁住的那 2 点。
   *
   * ⚠️ 用户可见的说法是「这次检测没通过，**能量已退回**」——
   *    讯飞那边失败也可能计费，那是我们承担的成本，不转嫁给用户。
   * ⚠️ 整块 try 住：退回失败不能影响"判定 failed"这件已经成立的事，
   *    但它也**不能静默** —— 那会变成"能量凭空少了"。
   */
  if (failed) {
    try {
      /**
       * ⭐⭐ **只有 `infra` 退能量**（用户 2026-10-15 定「成功调用即计费」）。
       *
       * ⚠️⚠️ 口径换过一次，以这条为准：
       *    · `invalid`（引擎**答了**：判这段音频无效）⇒ **不退**，那 2 点就是花掉的 ——
       *      我们确实调了引擎、也确实付了钱。把 energyState 记成 `charged`（与成功同值），
       *      于是"这一把的能量到底怎么了"在任何一条路上都读得出来。
       *    · `infra`（**没触达到**引擎）⇒ **退**，这一把等于没发生（这一行随后还会被删掉）。
       *
       * ⚠️ 旧口径是"失败一律退回，成本我们承担"。改掉的理由：那条规则要求
       *    **两条失败路径都记得退**，而漏一条的症状是"用户提交失败、账上却在掉"
       *    （2026-10-15 真机上就是这样漏的，见 routes/submissions.ts 的事务说明）——
       *    判据越少、越贴着"钱到底花没花"，越不会漏。
       */
      if (kind === 'infra') {
        if (await releaseChallengeEnergy(failed.userId, submissionId)) {
          await db
            .update(submissions)
            .set({ energyState: 'released' })
            .where(eq(submissions.id, submissionId))
        }
      } else {
        await db
          .update(submissions)
          .set({ energyState: 'charged' })
          .where(eq(submissions.id, submissionId))
      }
    } catch (err) {
      console.warn('[scoring] 能量结算没做完 id=' + submissionId + '：' + (err as Error).message)
    }
  }

    /**
     * ⭐⭐ **按失败的性质分流**（用户 2026-09 定的收尾口径）——
     *
     *    · `invalid`（**引擎判无效**，例如"未检测到有效语音"）⇒
     *      **保留这一行**（"这次不算"就是给用户的结论）+ 退能量；
     *      它**算一次挑战**，会出现在历史列表里（按「未出分」显示）。
     *
     *    · `infra`（**我们这边的问题**：音频读不出来 / 网络 / 解析异常）⇒
     *      **整行删掉 + 退能量** —— 用户那句话说得对："音频都删了，重新检测有什么用"。
     *      留着它没有任何补救价值：音频没了、检测也没跑成，只会在历史里多一条
     *      假的「未出分」并白占一个序号。⚠️ 删掉后序号也空出来，用户重录一次
     *      就是**干干净净的一次新挑战**（不需要"重试同一段音频"那套机制）。
     */
    if (failed) {
      try {
        if (kind === 'infra') {
          await db.delete(submissions).where(eq(submissions.id, submissionId))
          console.warn('[scoring] 没触达（' + reason + '）⇒ 已删掉这一行，让用户重录')
        } else {
          await syncParticipation(failed.userId, failed.articleId)
        }
      } catch (err) {
        console.warn('[scoring] 失败收尾没做完 id=' + submissionId + '：' + (err as Error).message)
      }
    }

  if (failed?.audioKey) {
    await getStorage()
      .remove(failed.audioKey)
      .catch((e: Error) => console.warn('[scoring] 删除无效音频失败:', e.message))
  }

  // ⭐ 无效提交计数（防刷）—— 复用原来同步版本的行为：
  //    连续读不出有效语音就当天封停，否则「随便传个静音」是免费的。
  //    ⚠️ 只在**引擎判无效**时计，读音频失败（网络/对象存储）不计 ——
  //       那是我们的问题，不该罚用户。
  if (failed && kind === 'invalid') {
    const [u] = await db.select().from(users).where(eq(users.id, failed.userId)).limit(1)
    if (u) {
      const day = new Date().toISOString().slice(0, 10)
      const { count, blocked } = trackInvalid(u.invalidCount, u.invalidDate, day)
      await db.update(users).set({ invalidCount: count, invalidDate: day }).where(eq(users.id, u.id))
      if (blocked) console.warn(`[scoring] 当日无效提交超限 user=${u.id}`)
    }
  }
}

/**
 * ⭐ 把 **AI 锐评**补写进那一行（prd §7.2b）。
 *
 * ⚠️⚠️ 前提是**分数已经落库、状态已经是 `scored`** —— 这个函数的全部意义就是
 *    "让用户先拿到分，批语晚几秒到"（见 runScoring 里那段说明）。
 *    ⇒ 它**永远不抛**：失败只是"这次没有批语"（端侧整块不渲染），
 *      绝不能让它把一条已经成立的成绩搞成 failed。
 * ⚠️ 二次 UPDATE 只碰这两列 —— 别在这里顺手改分数/状态。
 */
async function attachCoachRemark(submissionId: string, facts: CoachFacts): Promise<void> {
  try {
    const coach = await generateCoachFeedback(
      facts,
      /** ⚠️ 配置只有一处来源（默认模型/基址见 services/coach.ts 的说明） */
      llmConfigOf(env),
    )
    if (!coach) return
    await db
      .update(submissions)
      .set({ aiComment: coach.comment, aiTag: coach.tag || null })
      .where(eq(submissions.id, submissionId))
    console.log('[scoring] 锐评已补上 id=' + submissionId + '（' + coach.comment.length + ' 字）')
  } catch (err) {
    console.warn(
      '[scoring] 锐评没补上（成绩不受影响）id=' + submissionId + '：' + (err as Error).message,
    )
  }
}

/** 按带签名地址下载音频（地址的有效性已在提交时校验过） */
async function downloadSigned(audioUrl: string): Promise<Uint8Array> {
  const res = await fetch(audioUrl)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return new Uint8Array(await res.arrayBuffer())
}
