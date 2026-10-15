import { eq, and } from 'drizzle-orm'

import { env } from '../env'
import { db } from '../db'
import { participations } from '../db/schema'
import { callLlm, llmConfigOf, type LlmConfig } from './coach'
import { loadArticleRefText } from './content'
import { saveAiSummary } from './participations'
import type { WeakPoint } from '@jushuo/shared'

/**
 * ⭐⭐ **AI 总结（逐轮更新）** —— 竞技档案上那段人话（prd §7.2，用户 2026-10-15 定）。
 *
 * ## 三条纪律
 *
 * ① **只喂聚合后的事实，不喂原始历史**（plan A18 定的）：
 *    输入是「上一版总结 + 累计薄弱词 + 这一次的五维/参考文本」，不是把 N 次提交塞给模型。
 *    模型没有音频、只有文本 ⇒ 必须给它"哪个词、错了几次"这种**指得出来的**输入，
 *    否则它会写"多加练习"这种正确但没用的废话（同 coach.ts 的约束）。
 *
 * ② **失败静默降级**：写 `summary_state = 'failed'`，**绝不让"确认"失败** ——
 *    分数/次数/薄弱词在那之前就已经定下来了，总结只是文案。
 *    复用 `coach.ts` 的同一条通道与同一条纪律（没配 LLM_API_KEY 就整个跳过、不花钱）。
 *
 * ③ **它不可复现** ⇒ 这张表不再是"整表重建前后一模一样"的纯派生表。
 *    这是用户明确接受的破例（见 plan A18 / schema.ts 的注释）。
 */

/** 总结输入里的薄弱词最多几个（再多就不是"最近该练的"了） */
const MAX_WEAK = 8
/** 总结的长度上限 —— 它是档案上的一段话，不是一篇文章 */
const SUMMARY_MAX = 200

/**
 * ⭐ **这个功能开了吗**（没配 `LLM_API_KEY` 就是没开）。
 * ⚠️ 调用方要它来决定 `summary_state` 写不写 `pending` ——
 *    没开功能却写个 `pending`，界面会一直显示"生成中"（**假的进行中**，比没有更糟）。
 */
export function summaryEnabled(): boolean {
  return !!env.LLM_API_KEY
}

function configOf(): LlmConfig | null {
  if (!env.LLM_API_KEY) return null
  /** ⚠️ 配置只有一处来源（见 services/coach.ts）；这里只加自己的超时 */
  return { ...llmConfigOf(env), timeoutMs: 15_000 }
}

function buildPrompt(input: {
  refText: string
  weak: WeakPoint[]
  previous: string | null
  score: number | null
}): string {
  const weak =
    input.weak.length === 0
      ? '（没有明显薄弱的词）'
      : input.weak
          .slice(0, MAX_WEAK)
          .map((w) => w.word + '（' + w.count + '次偏低，最低' + Math.round(w.lowest) + '分' + (w.dp ? '，' + w.dp : '') + '）')
          .join('、')
  return [
    '句子：' + input.refText,
    '我在这句上读过的分：' + (input.score === null ? '（没有）' : Math.round(input.score)),
    '累计读得不好的词：' + weak,
    '上一版总结：' + (input.previous ?? '（还没有）'),
    '',
    '请更新这份「这句子上我该怎么读」的总结：',
    '· 只用中文，' + SUMMARY_MAX + ' 字以内；',
    '· **必须指到具体的词**（说出哪个词、问题是什么），不要"多练习"这种空话；',
    '· 如果上一版总结已经说对了，就保留它的判断、只补新东西（这是**逐轮累积**的总结，不是重写）。',
    '只输出 JSON：{"summary":"..."}',
  ].join('\n')
}

/**
 * 重算一段竞技档案的 AI 总结并写回。
 *
 * ⚠️ **调用方不要 await 它的失败**（见 confirm.ts）：确认已经成功了，这个是"补文案"。
 */
export async function refreshParticipationSummary(userId: number, articleId: string): Promise<void> {
  const cfg = configOf()
  if (!cfg) {
    /** 没配密钥 ⇒ 什么都没发生（不写 failed，免得把一个"没开的功能"显示成出错了） */
    return
  }

  const [row] = await db
    .select({
      weakPoints: participations.weakPoints,
      aiSummary: participations.aiSummary,
      bestScore: participations.bestScore,
    })
    .from(participations)
    .where(and(eq(participations.userId, userId), eq(participations.articleId, articleId)))
    .limit(1)
  if (!row) return

  const refText = await loadArticleRefText(articleId).catch(() => '')
  const text = await callLlm(
    cfg,
    '你是英语朗读教练，正在维护一份"这个人在这一句上该怎么读"的总结。只输出 JSON。',
    buildPrompt({
      refText,
      weak: (row.weakPoints ?? []) as WeakPoint[],
      previous: row.aiSummary ?? null,
      score: row.bestScore === null ? null : Number(row.bestScore),
    }),
  )

  /** ⚠️ 落库走唯一写入方（`participations` 归 services/participations.ts 管） */
  await saveAiSummary(userId, articleId, text ? extractSummary(text) : null)
}

/** 从模型回复里抠出 `summary`（抠不到就 null —— 绝不把模型的原话整段塞进库里） */
function extractSummary(raw: string): string | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const obj = JSON.parse(raw.slice(start, end + 1)) as { summary?: unknown }
    const text = String(obj.summary ?? '').trim().slice(0, SUMMARY_MAX)
    return text || null
  } catch {
    return null
  }
}
