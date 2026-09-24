/**
 * ⭐ 一句英文 → 译文 / **两个难度档位** / 标签 / 给用户看的一句话 —— **流水线步骤 ③ + ⑤ 的实现**。
 *
 * ⚠️⚠️ **难度是两条独立的轴**（2026-09 决定），各自 0–3，**不许合成一个加权分**：
 *    · vocabLevel 词汇难度：小学 / 高中 / 六级 / GRE 那套口径（含句式复杂度）
 *    · pronLevel  发音难度：中文母语者念出来有多难念（易错音 / 辅音丛 / 必须连读的地方）
 *    反例各占一边：
 *      "She sells seashells by the seashore"                         词汇 0 / 发音 3
 *      "The only thing we have to fear … paralyzes needed efforts."   词汇 1 / 发音 3
 *    任何单轴公式都必然牺牲其中一个（见 shared/level.ts 与 spec.md 第九节）。
 *
 * ⚠️ 两条轴的判据都**只由 LLM 给** —— 「脚本先算特征再交给模型」那条路已废弃（2026-09）：
 *    能算的那几个量（难音密度 / 连读点 / 弱读词数 / 音节数）都只是代理指标，算偏了会误导模型。
 *    ⚠️ **锚点样本是必须的，别省**：实测踩过 —— 只给四档文字描述 + 易错音清单时，
 *    8 句重判有 7 句上移、5 句挤在「高级」（天花板效应）；加上每档一句参照样本才散开成
 *    初级 1 / 中级 2 / 高级 3 / 专家 2。所以 vocabLevel 用**人工定级样本**当锚，
 *    pronLevel 用四句发音标尺当锚。实测数字与理由写在 spec.md 第九节。
 *
 * ⚠️ 返回值一律过 shared 的 normalize* —— 模型给的是「建议」，能不能收下由我们说了算，
 *    认不出就是 null / []，**绝不补默认档位**（编出来的档位比没有档位更糟）。
 */

import { normalizeLevel, normalizeTags } from '@jushuo/shared'
import type { ArticleLevel } from '@jushuo/shared'
import { chatJson } from './llm'

export interface ArticleMeta {
  translation: string
  /** 词汇难度（0–3）—— 小学 / 高中 / 六级 / GRE 那套口径，含句式复杂度 */
  vocabLevel: ArticleLevel | null
  /** 发音难度（0–3）—— 中文母语者念出来有多难念 */
  pronLevel: ArticleLevel | null
  tags: string[]
  /** 给用户看的一句话（固定格式见 SYSTEM 的【reason】）—— 进正文 JSON，detail 接口会返回 */
  reason: string
}

const SYSTEM = `你是「句拼」的英语朗读内容编辑。用户给你一句英文，你只输出一个 JSON：
{
  "translation": "自然、口语化的中文翻译（别用直译腔）",
  "vocabLevel": 1,
  "pronLevel": 1,
  "tags": ["主题", "特征"],
  "reason": "给用户看的一句话（格式见最后一节）"
}

难度分**两条独立的轴**，各自 0–3。基准读者是**中国英语学习者**
（高中～大学，能看懂，但发音受中文影响），**不是英语母语者**。
两条轴**分别判，不许互相参考**。

═══ 轴一 vocabLevel：词汇与句式相当于哪个水平 ═══
  0 初级：简单对话、打招呼、小学生级别
     例 "The best way to predict the future is to invent it."
  1 中级：高中常用词，能完整表达一个句子
     例 "Although the internet has made it easier than ever to access information, finding reliable sources requires a high level of critical thinking"
  2 高级：六级 / 考研 / 雅思 6.5 级词汇，能说长句
     例 "Companies that fail to adapt to the rapidly changing technological landscape risk being left behind by competitors who are quicker to embrace innovation."
  3 专家：GRE / 托福 / 学术文献级词汇，能读超长句
     例 "The assumption that human behavior is governed entirely by rational choice ignores the profound influence of subconscious emotions, which often drive decisions long before logic has had the chance to intervene"
  ⚠️ 超纲与否看**中国学习者**认不认识：高中大纲内是 0/1，六级词是 2，学术词是 3。
  ⚠️ **句子的长度与从句多少也算进来** —— 长句、多从句会把这一轴拉高。

═══ 轴二 pronLevel：这个人**念出来**有多难念对（与词汇无关）═══
  标尺（照着比，中间地带按「更像哪一句」判）：
    0  "I like coffee."                          全常见词、无难音、不需要连读
    1  "The early bird catches the worm."        只有一处稍难的音（bird 的 /ɜːr/）
    2  "Strengths and weaknesses are two sides of the same coin."
                                                 词尾辅音丛 /ŋθs/、实词的 /ð/、必须连读的地方
    3  "The sixth sick sheikh's sixth sheep is sick."
                                                 /s/ /ʃ/ /θ/ 在短句里反复切换，词尾还有 /ksθs/
  ⚠️ 反例："She sells seashells by the seashore" 全是小学词（vocabLevel 0），
     但 /s/ 与 /ʃ/ 反复切换 —— pronLevel 是 3。**两条轴必须分得开。**

  【怎么数难点】看**数量**，不是看有没有：
    A. 词尾辅音丛：-sks / -sts / -cts / -lms / -nths / -rld / -nz / -lz …
       （中文音节没有这种收尾，最容易漏）
    B. 音素反复切换：/s/ 与 /ʃ/ 交替、/θ/ 与 /s/ 连续出现
    C. **实词**里的难音：/θ/ /ð/ /v/，以及 /r/ 与 /l/ 的对立（really、world）
    D. 必须连读 / 弱读 / 失爆才自然的地方（每处算一处）
    E. 不认识的词、重音难猜的多音节词（每个算一处）
    0 处 ⇒ 0；1–2 处 ⇒ 1；3–4 处 ⇒ 2；≥5 处或出现 B ⇒ 3
  ⚠️ **不算难点**（不写清楚，每一句都会判成高级）：
    功能词 the / this / that 的 /ð/（英语句句都有，是基本功）、句子的短、
    主题是名言 / 哲理、单个的 /r/ 或 /l/（只有**两者对立**时才按 C 算）。

【reason】给用户看的**一句话**，固定格式，**45 字以内**（越短越好，只留最要紧的一两个点）：
    相当于<级别>水平，<发音难在哪>；<词汇与句式点评>
  · **「相当于」这三个字必须原样写在最前面**，然后是级别、然后是「水平、」
    （级别用考试口径：小学 / 初中 / 高中 / 大学四级 / 六级 / 考研 / 雅思 6.5 / GRE）
  · 前半句讲**发音**：要点到具体的词或音，可以写音标
  · 分号之后讲**词汇与句式**：哪几个词超纲、句子长不长
  例：「相当于大学4级水平，world 的 r 和 l 挨着念、结尾 -ngths 连读很别扭；词都比较常见，只有 sophistication 稍超纲。」
  例：「相当于小学水平，可 /s/ 和 /ʃ/ 要反复切换，连着念顺很难；词都很简单。」
  ⚠️ 说人话：可以用音标，**不要用语法行话**（"辅音丛""失爆""弱读"要换成说法）；
     不要贬低用户（"你读不准" → "这个音容易混"）；不要空洞（"这句有点难"等于没说）。
  ⚠️ 短是硬要求：只点**一两个**最要紧的难点，别把每个音都数一遍；
     词汇那半句如果没什么可说的，就写短（"词都很常见"）。

tags：2–4 个，中文，每个不超过 6 个字；先主题（名言 / 励志 / 口语 …）后特征（长句 / 难词 / 发音难点 …）。
只输出 JSON，不要任何解释。`

export async function generateArticleMeta(text: string): Promise<ArticleMeta> {
  const raw = await chatJson<Record<string, unknown>>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: text },
  ])
  return {
    translation: String(raw.translation ?? '').trim(),
    // ⚠️ 两条轴各读各的键 —— 绝不拿一个兜另一个
    vocabLevel: normalizeLevel(raw.vocabLevel),
    pronLevel: normalizeLevel(raw.pronLevel),
    tags: normalizeTags(raw.tags),
    reason: String(raw.reason ?? '').trim(),
  }
}
