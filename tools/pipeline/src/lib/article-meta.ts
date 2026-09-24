/**
 * ⭐ 一段英文（可多段）→ **1–N 条朗读单元**（纠错 + 译文 + **一个难度档位** + reason + tags）
 *    —— **流水线步骤 ③ + ⑤ 的实现**，也是管理台「批量入库」的第一步。
 *
 * ⚠️⚠️ **难度只有一个档位**（2026-09 用户纠正）：词汇 / 发音 / 长度是**三个判据**，
 *    不是给用户的三个量 —— 用户看到的是一枚徽章 + 一句「难在哪」。
 *    但**判据分要记进正文 JSON（scores）**（2026-09 用户补充）：这样档位能被代码验算。
 *
 * ⚠️ **算术归代码**：模型给三个 1–5 的分，`difficultyFromScores`（shared/level.ts）
 *    按 (5a+4b+c)/10 算档位。模型也输出 difficulty，但**代码算的说了算** ——
 *    让 LLM 自己算加权，它总有几个算错，而错了以后正文里的档位就和它自己给的分对不上，
 *    这种「静默算错」除了一个较真的测试没人会发现。
 *
 * ⚠️ 词表数据（ECDICT）**作为工具**给模型（dict_lookup），不在代码里预先算 ——
 *    见 ecdict.ts 里那段「为什么是工具而不是先算好」。
 *
 * ⚠️ 判据**只由 LLM 给** —— 「脚本先算特征再交给模型」那条路已废弃（2026-09）。
 *    ⚠️ **锚点样本是必须的，别省**：实测踩过 —— 只给四档文字描述时，8 句重判有 7 句上移、
 *    5 句挤在「高级」（天花板效应）；加上每档一句参照样本才散开。
 *
 * ⚠️⚠️ **纠错与 id**：id = sha256(text)，所以纠错**必须在生成之前定稿** ——
 *    这里返回的 text 就是最终正文；一旦生成完再改一个字，那就是另一条内容，
 *    音频与库行全部作废（所以管理台把候选列表给人工确认/手改）。
 *
 * ⚠️ 返回值一律过 shared 的 normalize* —— 模型给的是「建议」，能不能收下由我们说了算，
 *    认不出就是 null / []，**绝不补默认档位**（编出来的档位比没有档位更糟）。
 */

import { difficultyFromScores, normalizeLevel, normalizeScores, normalizeTags, splitParagraphs } from '@jushuo/shared'
import type { ArticleLevel, ArticleWordItem, DifficultyScores } from '@jushuo/shared'
import { buildWordInfo } from './word-info'
import { DICT_TOOL } from './ecdict'
import { chatJsonWithTools } from './llm'

/** 一条候选（还没落盘、还没生成音频）—— 管理台拿它渲染候选列表 */
export interface ArticleCandidate {
  /** ⭐ **纠错后的正文** —— 它会成为正文，并据此算 id（见文件头） */
  text: string
  translation: string
  /** ⭐ 朗读难度档位（0 初级 / 1 中级 / 2 高级 / 3 专家）—— 由 scores 按公式算出，不是模型报的 */
  difficulty: ArticleLevel | null
  /**
   * ⭐ 三个判据分 [词汇, 发音, 长度] —— 与 difficulty 一起进正文 JSON。
   *    ⚠️ 存它是为了「能验算」：difficulty 必须等于 difficultyFromScores(scores)。
   */
  scores: DifficultyScores | null
  /**
   * ⭐ 词表（朗读页逐词显示与点按要的全部数据）—— 见 types/content.ts 的 ArticleWordItem。
   * ⚠️ 与 links 一起由 `buildWordInfo` 产出（音节 / 音标 / 句重音 / 技巧 / 句中释义）。
   */
  words: ArticleWordItem[]
  /** ⭐ 词间连读标注（长度 = words.length - 1；空串 = 不连） */
  links: string[]
  tags: string[]
  /** 给用户看的一句话（格式见 SYSTEM）—— 进正文 JSON，detail 接口会返回 */
  reason: string
}

const SYSTEM = `你是「句拼」的英语朗读内容编辑。用户给你 N 段英文（**已经按空行拆好**，每段带编号【第 N 段】）。
**一段就是一条朗读单元：不要切分、不要合并。** 你要为每一段产出：纠错后的正文、译文、
三个判据分与合成出来的**一个**难度档位、一句给用户看的「难在哪」、标签。

【第一件事：纠错】⚠️ 输入可能有排版错误，顺手修掉，但**只修错、不改写**：
  · 缺空格：Frown at itand it frowns → Frown at it and it frowns
  · 明显的拼写错、重复的词、标点错位
  · ⚠️ 不要改措辞、不要换词、不要调语序
  · ⚠️ 修完的 text 会**直接作为正文并据此算 id** —— 每一处改动都必须是你确信的错。
  · 提示：dict_lookup 查不到的词，往往就是拼错/粘错的词。

【第二件事：定难度】先给三个判据各打 1–5 分（词拿不准就用 dict_lookup 查），
再按公式合成**一个档位**。⚠️ 三个分和那个档位**都要写进 JSON**（见最后的【输出】）——
分是你的判据，档位是结论，两者会一起被记下来核对。

① 词汇及句式复杂度（权重 5）
   L1 小学词汇　L2 初高中词汇　L3 大学四级　L4 六级·考研·雅思6.5　L5 GRE·托福·学术

   ⚠️⚠️ **算法（别只凭印象拍一个数）**：把句子里的**实词**逐个定档（跳过 the / of / it
   这类功能词），再取**平均分上取整** —— **不是**取最难的那个词，**也不是**取中位数。
   例：5 个实词 = 3/1/1/1/1 ⇒ 平均 1.4 ⇒ **2 分**；= 4/4/4/2/3 ⇒ 平均 3.4 ⇒ **4 分**。

   ⚠️⚠️ **逐词定档以你自己的词汇判断为准** —— 你比词表更懂「这个词对中文学习者难不难」。
   （实测过：让词典的 tag / 词频来定档，反而更不准 —— 它的高档位噪声很大，
     shells 一路标到 gre、seashore 只标 toefl，可初中生都认识这两个词。）

   ⚠️ **dict_lookup 只是核实工具，不是判档依据**：
     · 只在你**真的不确定**一个词、或怀疑它是生僻 / 超纲词时才查；
     · 查回来**别拿 tag 当档位**，collins / bnc 同理 —— **词频高 ≠ 中国人觉得它简单**；
     · **你认识的词就是简单词**，哪怕词典给它 gre；你不认识、觉得晦涩的才往 4–5 放。
   ⚠️ 两个容易看走眼的方向：
     · **别被长相骗**：unreasoning / unjustified / nameless 是 un- / -less 加常见词，
       构词透明 —— 但也**不能因此把整句压到 1**，它们确实让这句话读起来更重；
     · **别看漏真正的硬词**：paralyze（生僻）、sophistication（长而抽象）这类，
       一眼扫过去很容易当成普通词。（拿不准就查一下，但**档位由你定**。）

   ⚠️ 参考（这一维的 1–5 长什么样，定完逐词档后回头比一眼）：
     1–2：**全是常用词** —— "I like coffee." / "Don't count the days, make the days count."
     3  ：混着几个四级词，但都常见 —— access / reliable / requires / critical
     4  ：**一串**六级·考研词 —— adapt / technological / landscape / competitors / embrace / innovation
     5  ：**一串** GRE·托福·学术词 —— assumption / rational / profound / subconscious / intervene
     ⚠️ 平均分**天然**照顾了「难词占多大比例」这件事，**别再手动往高或往低偏**：
       满句常用词、只夹一个生僻词的**长句**（FDR 那句），平均下来仍在 2；
       而**只有三个实词**、其中一个还是 GRE 词的短句，平均就会被顶到 4。
       ⇒ 逐词定档之后**老实取平均**，不要因为「只有一个难词」就手下留情。
   ⚠️ 但**一个词就足以让句子卡住** —— 这是朗读产品：卡住用户的那个词要写进 reason。

② 发音难度（权重 3）——中国学习者**念出来**有多难念对，与词汇无关
   照着比，中间地带按「更像哪一句」判：
     L1  "I like coffee."                                    全常见词、无难音、不需要连读
     L2  "The early bird catches the worm."                   只有一处稍难的音（bird 的 /ɜːr/）
     L3  "Strengths and weaknesses are two sides of the same coin."
                                                            词尾辅音丛 /ŋθs/、实词的 /ð/、必须连读
     L4  "The world is like a mirror: Frown at it and it frowns at you; smile, and it smiles too."
                                                            词尾辅音丛密集（/rld/ /nz/ /lz/）+ r 与 l 相邻
     L5  "The sixth sick sheikh's sixth sheep is sick."       /s/ /ʃ/ /θ/ 在短句里反复切换（绕口令式）
   数难点的口径（看**数量**，不是看有没有）：
     A 词尾辅音丛：-sks / -sts / -cts / -lms / -nths / -rld / -nz / -lz …
     B 音素反复切换：/s/ 与 /ʃ/ 交替、/θ/ 与 /s/ 连续出现
     C 实词里的难音：/θ/ /ð/ /v/，以及 /r/ 与 /l/ 的对立（really、world）
     D 必须连读 / 弱读 / 失爆才自然的地方（每处算一处）
     E 不认识的词、重音难猜的多音节词（每个算一处）
     0 处 ⇒ L1；1–2 处 ⇒ L2；3–4 处 ⇒ L3；5–6 处 ⇒ L4；≥7 处或出现 B ⇒ L5
   ⚠️ **不算难点**：功能词 the / this / that 的 /ð/（英语句句都有，是基本功）、句子短、
     主题是名言哲理、单个的 /r/ 或 /l/（只有两者对立时才按 C 算）。

③ 句子长度（权重 2）——数词数
   L1 <10 词　L2 10–20 词　L3 20–30 词　L4 30–40 词　L5 >40 词

【定档锚点】⭐ 判完之后把你的结果和下面这几句**比一比** —— 它们是**基准**：
如果三个分算出来的档位和这张表不一致，就**回头调三个分**（**以这张表为准**，
它比你的算术更权威）。同一档的最终 difficulty 必须一致：
  0 初级：「The best way to predict the future is to invent it.」　　　　　（词汇 2）
          「Don't count the days, make the days count.」　　　　　　　　　（词汇 1）
  1 中级：「Although the internet has made it easier than ever to access information,
            finding reliable sources requires a high level of critical thinking.」（词汇 3）
          「The only thing we have to fear is fear itself, nameless, unreasoning,
            unjustified terror which paralyzes needed efforts.」　　　　　　（词汇 3）
  2 高级：「Companies that fail to adapt to the rapidly changing technological landscape
            risk being left behind by competitors who are quicker to embrace innovation.」（词汇 4）
  3 专家：「The assumption that human behavior is governed entirely by rational choice ignores
            the profound influence of subconscious emotions, which often drive decisions long
            before logic has had the chance to intervene.」　　　　　　　　（词汇 5）
  ⚠️ 括号里给的是**词汇档**（发音与长度你按自己的口径判），三个分算出来的档位必须落对上。
  ⚠️ FDR 那句（中级的第二句）：**词汇别给 5** —— unreasoning / unjustified 是 un- + 常用词，
     构词透明；但也**别压到 1–2**：nameless / unreasoning / unjustified / paralyzes 叠在一起，
     确实比「The world is like a mirror…」那种句子重 —— **词汇 3**，最后落中级。

【合成档位】把三个分**原样写进 scores**（顺序固定：词汇、发音、长度），再写难度：
   score = (5 × 词汇 + 3 × 发音 + 2 × 长度) / 10   （落在 1–5）
   ⚠️ 档位 = 把 score **四舍五入到整数**，然后：1–2 → 初级 │ 3 → 中级 │ 4 → 高级 │ 5 → 专家
      （切分点是 2.5 / 3.5 / 4.5。⚠️ 别记成「3 分就是高级」——
       词汇 2（高中）的句子，光靠发音 5 顶多到 3.2 → 还是**中级**，这是用户定的口径。）
   ⚠️ scores **三个都要给**，各是 1–5 的整数 —— 它是你的判据，会被记下来核对。
      给不出某个分就说明你还没想清楚：回头再看一遍那一维的口径。

【两个必须避开的典型错判】
  · **词汇简单但极难念**（绕口令 "She sells seashells by the seashore…"）：
    ① 只有 L1，但 ② 是 L5 ⇒ 不能因为词简单就判初级。
  · **词汇很难但念起来顺**（"The utilization of sophisticated methodologies…"）：
    别被长词骗成「专家」—— ② 不高时，档位主要由 ① 决定。

【reason】给用户看的**一句话**，**总长不超过 45 个字（含标点）**，固定格式：
    相当于<级别>水平，<发音难在哪>；<词汇与句式点评>
  · **「相当于」三个字必须原样写在最前面**，然后级别、然后「水平，」
  · ⚠️⚠️ 这个级别是**对整句的总评**，必须与上面算出的 difficulty **一致**
    （考试口径，别按词汇那一维写 —— 词汇判 2 但发音很容易、合成成初级时，
     写「高中水平」就和初级的徽章自相矛盾了）：
      初级 → 小学 / 初中　　中级 → 高中　　高级 → 大学四级 / 六级　　专家 → GRE / 学术
  · 前半句讲**发音**：点到具体的词或音，可以写音标
  · 分号之后讲**词汇与句式**：哪几个词超纲、句子长不长
  例：「相当于大学4级水平，world 的 r 和 l 挨着念、结尾 -ngths 连读很别扭；词都比较常见，只有 sophistication 稍超纲。」
  例：「相当于高中水平，sells / seashells 里 /s/ 和 /ʃ/ 要反复切换，连着念很难顺；词都很简单。」
  ⚠️ 说人话：可以用音标，**不要用语法行话**（"辅音丛""失爆""弱读"要换成说法）；
     不要贬低用户（"你读不准" → "这个音容易混"）；不要空洞（"这句有点难"等于没说）。
  ⚠️ 只点**一两个**最要紧的难点；词汇那半句没什么可说就写短（"词都很常见"）。
  ⚠️⚠️ **45 字是硬上限**：写完**自己数一遍**（发音那半句 + 词汇那半句合起来）。
     超了就先删词汇那半句的细节（只留"词都很常见"），再删发音里次要的那个难点。
     宁可少说一个难点，也不要写成两句半的长句 —— 它是卡片上的一行小字。

【tags】2–4 个，中文，每个不超过 6 个字。**只写主题与体裁**，它是给人「按话题找句子」用的：
  名言 / 哲理 / 励志 / 口语 / 演讲 / 绕口令 / 科普 / 幽默 / 时间 / 成长 / 自然 / 爱情 …
  ⚠️ 第一个放最主要的主题，后面的可以更细。
  ⚠️⚠️ **不要写难度或发音相关的元描述**：发音难点 / 难词 / 长词 / 短句 / 难句 / 拗口 / 简单 ——
     难度已经由档位徽章和那句「难在哪」表达，"哪个词难念"也已经由词表里的发音技巧表达；
     再把它当一个标签，就是**重复的内部黑话**（用户 2026-09 直接指出来了）。
     ⚠️ 例外：「绕口令」是**体裁**，可以留（它说的是"这是绕口令"，不是"这句难"）。

【句中释义】⚠️ 另外给每个**实词**一句**在这个句子里**的中文释义（用 words 字段交回来）：
  · **跳过功能词**（the / of / and / it / is / to / a …）—— 它们不需要释义；
  · 只写这个词**在这句里的那个意思**，**别罗列词典义项**（用户点词是想知道"这里是什么意思"）；
  · 6–14 个字，说人话，不要「释义：」这种前缀；
  · 同一个词在一段里出现两次只写一条（按词形给，不按位置）。

【输出】只输出 JSON，不要任何解释。
⚠️ articles 的**条数必须等于输入段数**，每条带 index（第几段，从 1 开始）。
⚠️ **不要写 scores 的解释、不要写其他字段**（多写的会被丢掉）：
{
  "articles": [
    { "index": 1, "text": "纠错后的英文", "translation": "自然口语化的中文（别用直译腔）",
      "scores": [4, 2, 3], "difficulty": 2, "tags": ["主题", "特征"], "reason": "相当于…水平，…；…",
      "words": [ { "w": "sophistication", "m": "精致、考究（此句指格调）" } ] }
  ]
}`


/**
 * ⭐ **代码拆段 → LLM 纠错 + 定级**（一次调用覆盖 N 段，带 dict_lookup 工具）。
 *
 * ⚠️⚠️ **拆分不在这里**：由 shared 的 splitParagraphs 按空行**确定性地**做 ——
 *    段数 = 条数，所以 TTS 要跑几次也是可预期的。这个函数**永远返回 paragraphs.length 条**，
 *    模型漏了哪一段就用原文占位（档位 null），界面会标出来让人重试或手填，**绝不静默丢段**。
 *
 * ⚠️ **词汇维度的数据靠工具拿，不在代码里预先算**：模型觉得哪个词拿不准就 dict_lookup 一下。
 *    ECDICT 的字段不完整也不好直接当结论（高级词表也收基础词、屈折形常常没填），
 *    所以工具只给**原始字段**，权衡留给模型 —— 这就是 tool-call 的意义（见 ecdict.ts）。
 */
/**
 * 模型交回来的 `words: [{w, m}]` → 词形（小写、去标点）→ 中文释义。
 * ⚠️ 按**词形**对齐而不是按下标：让模型数下标一定会数错；同一个词出现两次意思也一样。
 * ⚠️ 空的 / 认不出的条目直接丢掉（宁可没有释义，也不要一条错位的）。
 */
function meaningsOf(raw: unknown): Map<string, string> {
  const out = new Map<string, string>()
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>
    const w = String(o.w ?? '').toLowerCase().replace(/[^a-z'’]/g, '')
    const m = String(o.m ?? '').trim()
    if (w !== '' && m !== '') out.set(w, m)
  }
  return out
}

export async function gradeArticles(input: string): Promise<ArticleCandidate[]> {
  const paragraphs = splitParagraphs(input)
  if (paragraphs.length === 0) return []

  // 带上段号再交给模型 —— 回来的 index 是「对回哪一段」的唯一依据
  const numbered = paragraphs.map((p, i) => '【第 ' + (i + 1) + ' 段】' + p).join('\n\n')
  const raw = await chatJsonWithTools<{ articles?: unknown }>(
    [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: numbered },
    ],
    [DICT_TOOL],
  )
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
      //    ⚠️ words/links 仍然按**原文**算出来（音节/音标/重音与纠错无关）——
      //       这样界面上至少能看到这一段的词表，而不是一片空白。
      const fallback = buildWordInfo({ text: p })
      return {
        text: p,
        translation: '',
        difficulty: null,
        scores: null,
        words: fallback.words,
        links: fallback.links,
        tags: [],
        reason: '',
      }
    }
    const text = String(a.text ?? '').trim()
    // ⭐ 判据分 → 档位：**代码算的说了算**（模型自己算加权总有几个错的）。
    //    scores 认不出时才退回模型报的 difficulty —— 那说明这次判据没给全，
    //    留一个「有档位没判据」的记录，总比整条丢掉强（正文校验会盯住这种）。
    const scores = normalizeScores(a.scores)
    // ⚠️ 纠错后的 text 为空（模型抽风）就退回原文 —— 宁可没纠错，也不能丢这一条
    const corrected = text === '' ? p : text
    /**
     * ⭐ 词表按**纠错之后**的正文算 —— 它必须和最终写进 JSON 的 text 是同一个字符串，
     *    否则下标会和评分引擎的逐词分数错位（"点这个词、看那个词的诊断"）。
     * ⚠️ 句中释义按**词形**对齐（不是按下标）：模型数下标一定会数错，
     *    而同一个词在句子里出现两次意思也一样。
     */
    const info = buildWordInfo({ text: corrected, meanings: meaningsOf(a.words) })
    return {
      text: corrected,
      translation: String(a.translation ?? '').trim(),
      difficulty: difficultyFromScores(scores) ?? normalizeLevel(a.difficulty),
      scores,
      words: info.words,
      links: info.links,
      tags: normalizeTags(a.tags),
      reason: String(a.reason ?? '').trim(),
    }
  })
}
