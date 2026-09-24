/**
 * ⭐ 一句英文 → 译文 / 朗读难度 / 标签 —— **流水线步骤 ③ + ⑤ 的实现**。
 *
 * ⚠️ 为什么难度不能靠词汇表算：见 shared/difficulty.ts ——
 *    "She sells seashells by the seashore" 全是小学词，却是公认最难的绕口令。
 *    所以这一步只能让模型「读」这句话，判据是**读起来难不难**。
 *
 * ⚠️⚠️ 2026-09 决定：**难度全由 LLM 判** —— 连「脚本先算特征再交给模型」那条路也一并废弃。
 *    能算的那几个量（难音密度 / 连读点 / 弱读词数 / 音节数）都只是**代理指标**：
 *    绕口令全是小学词却最难，说明真正的难点在**音素序列的切换模式**，
 *    而算偏了会**误导**模型（把最难的绕口令算成最简单的一档）。
 *    锚点样本（人工已定级句）同样**暂未采用** —— 先看实测漂移（同一句多次定级稳不稳，
 *    见 plan.md 的 C6），不稳再加。理由与取舍写在 spec.md 第九节。
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

【判定基准】difficulty 是**朗读难度**。基准读者是**中国英语学习者**
（高中～大学，能看懂，但发音受中文影响），**不是英语母语者**。
要判的是：**这个人第一次看到这句、直接念出来，有多难念对**。

【四档】
  0 初级：都是常见词，且不含中国学习者常错的音；词与词之间不需要连读。
  1 中级：有少量稍难的词，或一两个常见易错音，放慢速度就能念对。
  2 高级：含下面的高频难点，或必须连读/弱读才自然，或有 3 个以上不常见的词。
  3 专家：难点密集且叠加 —— 绕口令式的音素反复切换，或长句里同时有大量连读、
          弱读与难音，念对需要专门练。

【中国学习者最常错的地方（出现即加难度）】
  · 中文里没有的音：/θ/ /ð/（think、this 常读成 s/z）、/v/（常读成 w）、/r/ 与 /l/ 不分
  · 长短元音对立：ship/sheep、full/fool、bit/beat
  · 词尾辅音丛：-sks、-sts、-cts、-lms、-nths（中文音节没有这种收尾）
  · 音素反复切换：/s/ 与 /ʃ/ 交替（she sells seashells）、/θ/ 与 /s/ 连续出现
  · 词与词的连接：辅音+元音连读、t/d 失爆、功能词弱读成 /ə/
    ⚠️ 中国学习者习惯一个词一个词字正腔圆地念 —— 需要连读才自然的地方就是难点
  · 不认识的词：不知道重音在哪，也不知道念什么

【两条禁止】
  ⚠️ 不要按词汇表 / CET 等级定档。反例："She sells seashells by the seashore"
     全是小学词，但 /s/ 与 /ʃ/ 反复切换 —— 它是 3（专家），不是 0。
  ⚠️ 不要因为它短、或主题是「名言 / 哲理」就判简单或判难 —— 只看念起来难不难。

【reason】一句话说清难点落在**哪些词、哪个音**（例："第 3 个词的 /r/ 容易读成 /l/"），
不要重复档位描述。判 2 或 3 档时**必须**指出具体难点。

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
