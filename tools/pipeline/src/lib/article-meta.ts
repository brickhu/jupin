/**
 * ⭐ 一段英文（可多段）→ **1–N 条朗读单元**（拆分 + 纠错 + 译文 + 两个档位 + reason + tags）
 *    —— **流水线步骤 ③ + ⑤ 的实现**，也是管理台「批量入库」的第一步。
 *
 * ⚠️⚠️ **难度是两条独立的轴**（2026-09 决定），各自 0–3，**不许合成一个加权分**：
 *    · vocabLevel 词汇难度：小学 / 高中 / 六级 / GRE 那套口径（含句式复杂度）
 *    · pronLevel  发音难度：中文母语者念出来有多难念（易错音 / 辅音丛 / 必须连读的地方）
 *    反例各占一边：
 *      "She sells seashells by the seashore"                         词汇 0 / 发音 3
 *      "The only thing we have to fear … paralyzes needed efforts."   词汇 1 / 发音 3
 *    任何单轴公式都必然牺牲其中一个（见 shared/level.ts 与 spec.md 第九节）。
 *
 * ⚠️ 判据**只由 LLM 给** —— 「脚本先算特征再交给模型」那条路已废弃（2026-09）。
 *    ⚠️ **锚点样本是必须的，别省**：实测踩过 —— 只给四档文字描述 + 易错音清单时，
 *    8 句重判有 7 句上移、5 句挤在「高级」（天花板效应）；加上每档一句参照样本才散开成
 *    初级 1 / 中级 2 / 高级 3 / 专家 2。实测数字与理由写在 spec.md 第九节。
 *
 * ⚠️⚠️ **纠错与 id**：id = sha256(text)，所以纠错**必须在生成之前定稿** ——
 *    这里返回的 text 就是最终正文；一旦生成完再改一个字，那就是另一条内容，
 *    音频与库行全部作废（所以管理台把候选列表给人工确认/手改）。
 *
 * ⚠️ 返回值一律过 shared 的 normalize* —— 模型给的是「建议」，能不能收下由我们说了算，
 *    认不出就是 null / []，**绝不补默认档位**（编出来的档位比没有档位更糟）。
 */

import { normalizeLevel, normalizeTags, splitParagraphs } from '@jushuo/shared'
import type { ArticleLevel } from '@jushuo/shared'
import { chatJson } from './llm'

/** 一条候选（还没落盘、还没生成音频）—— 管理台拿它渲染候选列表 */
export interface ArticleCandidate {
  /** ⭐ **纠错后的正文** —— 它会成为正文，并据此算 id（见文件头） */
  text: string
  translation: string
  /** 词汇难度（0–3） */
  vocabLevel: ArticleLevel | null
  /** 发音难度（0–3） */
  pronLevel: ArticleLevel | null
  tags: string[]
  /** 给用户看的一句话（格式见 SYSTEM）—— 进正文 JSON，detail 接口会返回 */
  reason: string
}

const SYSTEM = `你是「句拼」的英语朗读内容编辑。用户给你 N 段英文（**已经按空行拆好**，每段带编号【第 N 段】）。
你**不要切分、也不要合并** —— 一段就是一条朗读单元。你要为**每一段**产出：纠错后的正文、
译文、两个难度档位、标签，以及一句给用户看的「难在哪」。

【第一件事：纠错】⚠️ 输入可能有排版错误，顺手修掉，但**只修错、不改写**：
  · 缺空格：Frown at itand it frowns → Frown at it and it frowns
  · 明显的拼写错、重复的词、标点错位
  · ⚠️ 不要改措辞、不要换词、不要调语序；
  · ⚠️ 修完的 text 会**直接作为正文，并据此算 id** —— 所以每一处改动都必须是你确信的错。

【第二件事：⚠️ 不要切分、不要合并】
  · **一段就是一条**，即使某一段很长（超长句由人选文时把关，不由你切）；
  · 输出的每一条必须带 **index**（第几段，从 1 开始）—— index 用来对回输入段；
  · 段内如果有硬折行，**当作空格**处理（不要留换行）。

【第三件事：每段给出四项】——对**每一段**分别做：

═══ vocabLevel：词汇与句式相当于哪个水平 ═══
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

═══ pronLevel：中国学习者**念出来**有多难念对（与词汇无关）═══
  标尺（照着比，中间地带按「更像哪一句」判）：
    0  "I like coffee."                          全常见词、无难音、不需要连读
    1  "The early bird catches the worm."        只有一处稍难的音（bird 的 /ɜːr/）
    2  "Strengths and weaknesses are two sides of the same coin."
                                                 词尾辅音丛 /ŋθs/、实词的 /ð/、必须连读的地方
    3  "The sixth sick sheikh's sixth sheep is sick."
                                                 /s/ /ʃ/ /θ/ 在短句里反复切换，词尾还有 /ksθs/
  ⚠️ 反例："She sells seashells by the seashore" 全是小学词（vocabLevel 0），
     但 /s/ 与 /ʃ/ 反复切换 —— pronLevel 是 3。**两条轴必须分得开，各自判。**
  【怎么数难点】看**数量**，不是看有没有：
    A. 词尾辅音丛：-sks / -sts / -cts / -lms / -nths / -rld / -nz / -lz …
    B. 音素反复切换：/s/ 与 /ʃ/ 交替、/θ/ 与 /s/ 连续出现
    C. **实词**里的难音：/θ/ /ð/ /v/，以及 /r/ 与 /l/ 的对立（really、world）
    D. 必须连读 / 弱读 / 失爆才自然的地方（每处算一处）
    E. 不认识的词、重音难猜的多音节词（每个算一处）
    0 处 ⇒ 0；1–2 处 ⇒ 1；3–4 处 ⇒ 2；≥5 处或出现 B ⇒ 3
  ⚠️ **不算难点**：功能词 the / this / that 的 /ð/（英语句句都有，是基本功）、句子的短、
     主题是名言 / 哲理、单个的 /r/ 或 /l/（只有**两者对立**时才按 C 算）。

═══ reason：给用户看的**一句话**，固定格式，**45 字以内** ═══
    相当于<级别>水平，<发音难在哪>；<词汇与句式点评>
  · **「相当于」这三个字必须原样写在最前面**，然后是级别、然后是「水平、」
    （级别用考试口径：小学 / 初中 / 高中 / 大学四级 / 六级 / 考研 / 雅思 6.5 / GRE）
  · 前半句讲**发音**：要点到具体的词或音，可以写音标
  · 分号之后讲**词汇与句式**：哪几个词超纲、句子长不长
  例：「相当于大学4级水平，world 的 r 和 l 挨着念、结尾 -ngths 连读很别扭；词都比较常见，只有 sophistication 稍超纲。」
  例：「相当于小学水平，可 /s/ 和 /ʃ/ 要反复切换，连着念顺很难；词都很简单。」
  ⚠️ 说人话：可以用音标，**不要用语法行话**（"辅音丛""失爆""弱读"要换成说法）；
     不要贬低用户（"你读不准" → "这个音容易混"）；不要空洞（"这句有点难"等于没说）。
  ⚠️ 短是硬要求：只点**一两个**最要紧的难点；词汇那半句没什么可说就写短（"词都很常见"）。

═══ tags ═══
  2–4 个，中文，每个不超过 6 个字；先主题（名言 / 励志 / 口语 …）后特征（长句 / 难词 / 发音难点 …）。

【输出】只输出 JSON，不要任何解释。
⚠️ articles 的**条数必须等于输入段数**，每条带 index（第几段，从 1 开始）：
{
  "articles": [
    { "index": 1, "text": "纠错后的英文", "translation": "自然口语化的中文（别用直译腔）",
      "vocabLevel": 1, "pronLevel": 1, "tags": ["主题", "特征"], "reason": "相当于…水平，…；…" }
  ]
}`

/**
 * ⭐ **代码拆段 → LLM 纠错 + 定级**（一次调用覆盖 N 段）。
 *
 * ⚠️⚠️ **拆分不在这里**：由 shared 的 splitParagraphs 按空行**确定性地**做（2026-09 决定，
 *    见 paragraphs.ts）—— 段数 = 条数，所以 TTS 要跑几次也是可预期的。
 *    所以这个函数**永远返回 paragraphs.length 条**：模型漏了哪一段就用原文占位（档位 null），
 *    界面会标出来让人重试或手填 —— **绝不静默丢段**（丢一段 = 以为入库了 5 条其实只有 4 条）。
 *
 * ⚠️ 一次调用而不是每段一次：少 N−1 次往返，且同一条提示词只发一次。
 */
export async function gradeArticles(input: string): Promise<ArticleCandidate[]> {
  const paragraphs = splitParagraphs(input)
  if (paragraphs.length === 0) return []

  // 带上段号再交给模型 —— 回来的 index 是「对回哪一段」的唯一依据
  const numbered = paragraphs.map((p, i) => '【第 ' + (i + 1) + ' 段】' + p).join('\n\n')
  const raw = await chatJson<{ articles?: unknown }>([
    { role: 'system', content: SYSTEM },
    { role: 'user', content: numbered },
  ])
  const list = Array.isArray(raw.articles) ? raw.articles : []
  const byIndex = new Map<number, Record<string, unknown>>()
  for (const item of list) {
    const a = (item ?? {}) as Record<string, unknown>
    const idx = Number(a.index)
    if (Number.isInteger(idx) && idx >= 1 && idx <= paragraphs.length) byIndex.set(idx, a)
  }

  return paragraphs.map((p, i) => {
    const a = byIndex.get(i + 1)
    if (!a) {
      // ⚠️ 模型没给这一段 ⇒ 用原文占位（档位留空，界面会拦住不让生成）
      return { text: p, translation: '', pronLevel: null, vocabLevel: null, tags: [], reason: '' }
    }
    const text = String(a.text ?? '').trim()
    return {
      // ⚠️ 纠错后的 text 为空（模型抽风）就退回原文 —— 宁可没纠错，也不能丢这一条
      text: text === '' ? p : text,
      translation: String(a.translation ?? '').trim(),
      // ⚠️ 两条轴各读各的键 —— 绝不拿一个兜另一个
      vocabLevel: normalizeLevel(a.vocabLevel),
      pronLevel: normalizeLevel(a.pronLevel),
      tags: normalizeTags(a.tags),
      reason: String(a.reason ?? '').trim(),
    }
  })
}
