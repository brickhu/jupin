/**
 * ⭐ 一句英文 → 译文 / 朗读难度 / 标签 —— **流水线步骤 ③ + ⑤ 的实现**。
 *
 * ⚠️ 为什么难度不能靠词汇表算：见 shared/difficulty.ts ——
 *    "She sells seashells by the seashore" 全是小学词，却是公认最难的绕口令。
 *    所以这一步只能让模型「读」这句话，判据是**读起来难不难**。
 * ⚠️ 返回值一律过 shared 的 normalize* —— 模型给的是「建议」，能不能收下由我们说了算，
 *    认不出就是 null / []，**绝不补默认档位**（编出来的难度比没有难度更糟）。
 */

import { normalizeDifficulty, normalizeTags } from '@jushuo/shared'
import type { ArticleDifficulty } from '@jushuo/shared'
import { chatJson } from './llm'

export interface ArticleMeta {
  translation: string
  difficulty: ArticleDifficulty | null
  tags: string[]
  /** 定档理由 —— 只给审核看，**不进正文 JSON**（同 spec 第九节） */
  reason: string
}

const SYSTEM = `你是「句拼」的英语朗读内容编辑。用户给你一句英文，你只输出一个 JSON：
{
  "translation": "自然、口语化的中文翻译（别用直译腔）",
  "difficulty": 0,
  "tags": ["主题", "特征"],
  "reason": "为什么定这一档（一句话，给审核看的）"
}

difficulty 是**朗读难度**，不是阅读难度：
  0 初级：常见词、短、没有难音
  1 中级：普通句子，偶有连读
  2 高级：长句，或密集的连读/弱读，或含少量难音
  3 专家：难音密集（绕口令式），或长且结构复杂

⚠️ 判据是「**读起来**难不难」。反例：
   "She sells seashells by the seashore" 词汇全是小学词，但 /s/ 与 /ʃ/ 反复切换 ——
   它是 3（专家），不是 0。按词汇定级会严重低估。

tags：2–4 个，中文，每个不超过 6 个字；先主题（名言 / 励志 / 口语 …）后特征（长句 / 难词 / 发音难点 …）。
只输出 JSON，不要任何解释。`

export async function generateArticleMeta(text: string): Promise<ArticleMeta> {
  const raw = await chatJson<Record<string, unknown>>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: text },
  ])
  return {
    translation: String(raw.translation ?? '').trim(),
    difficulty: normalizeDifficulty(raw.difficulty),
    tags: normalizeTags(raw.tags),
    reason: String(raw.reason ?? '').trim(),
  }
}
