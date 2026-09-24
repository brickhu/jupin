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
 *    ⚠️ **【参照样本】那四句是必须的，别省** —— 实测踩过：只给「四档文字描述 + 易错音清单」时，
 *    8 句重判里有 **7 句上移、5 句挤在「高级」**（天花板效应，等于四档退化成两档）；
 *    加上每档一句参照样本后才散开成 **初级 1 / 中级 2 / 高级 3 / 专家 2**。
 *    理由与实测数字写在 spec.md 第九节。
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

【参照样本】用这四句当标尺（都是中国学习者真会遇到的类型）：
  初级  "I like coffee."
        全常见词、无难音、词与词之间不需要连读。
  中级  "The early bird catches the worm."
        词都常见，只有一处稍难的音（bird 的 /ɜːr/）。
  高级  "Strengths and weaknesses are two sides of the same coin."
        词尾辅音丛 /ŋθs/、实词的 /ð/，还有必须连读才自然的地方。
  专家  "The sixth sick sheikh's sixth sheep is sick."
        /s/ /ʃ/ /θ/ 在这么短的句子里反复切换，词尾还有 /ksθs/。
  ⚠️ 中间地带按「更像上面哪一句」判，**不要自己另立标准**。

【怎么数难点】先数这句话里有**几处**真正的难点 —— 看**数量**，不是看「有没有」：
  A. 词尾辅音丛：-sks / -sts / -cts / -lms / -nths / -rld / -nz / -lz …
     （中文音节没有这种收尾，是中国人最容易漏掉的）
  B. 音素反复切换：/s/ 与 /ʃ/ 交替（she sells seashells）、/θ/ 与 /s/ 连续出现
  C. **实词**里的难音：/θ/ /ð/ /v/，以及 /r/ 与 /l/ 的对立（really、world）
  D. 必须连读 / 弱读 / 失爆才自然的地方（每处算一处）
     ⚠️ 中国学习者习惯一个词一个词字正腔圆地念 —— 这种地方正是难点所在
  E. 不认识的词，或重音难猜的多音节词（每个算一处）

⚠️ **不算难点的**（这条最关键 —— 不写清楚，每一句都会被判成高级）：
  · 功能词 the / this / that 的 /ð/ —— 英语里句句都有，是基本功，不是难点
  · 只是「句子有点短」或「主题是名言 / 哲理」 —— 与朗读难度无关
  · 单个的 /r/ 或 /l/ —— 只有**两者对立**时才按 C 算

【档位 = 难点处数】
  0 初级：0 处
  1 中级：1–2 处
  2 高级：3–4 处
  3 专家：≥5 处；或出现 B（音素反复切换）且总处数 ≥2

档位只看数出来的处数，**不要**为了「四档都好看」去调。

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
