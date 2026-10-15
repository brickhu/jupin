/**
 * ⭐ AI 教练 —— 把引擎给的「病灶坐标」变成「处方」。
 *
 * 讯飞只回分数和错误码（见 docs/research/ise-response-fields.md 第七节），
 * **不给任何改进建议**。所以这一步是我们补的，输出两样东西：
 *
 *   ① comment —— 4–8 个字的点评，用于展示（结果页顶部、榜单卡片）
 *   ② advice  —— 给用户自己看的提升建议，必须**指到具体的词/音**
 *
 * ⚠️⚠️ 两条硬约束：
 *   1. **只喂事实，不让模型自由发挥**。输入是分数、最差的词、读错的音素 ——
 *      没有音频、只有参考文本（让它能指认「哪个词」）。
 *      不这么做的话，模型会写出「多加练习」这种正确但没用的废话。
 *   2. **失败必须静默降级**：模型超时/报错/返回非法 JSON 时返回 null，
 *      成绩照常出。一个锦上添花的点评不该拖垮主流程。
 *
 * ⚠️ 成本：每次提交一次调用（几百 token）。由 LLM_API_KEY 控制开关 ——
 *    没配就整个跳过，不产生任何费用。
 */

export interface CoachFacts {
  /** 总分与五个分项 */
  score: number
  parts: { prosody: number; weakness: number; accuracy: number; fluency: number; completeness: number }
  /** 参考文本（让模型能指认「哪个词」） */
  refText: string
  /**
   * ⭐ **这句的语境**（2026-10-15 加）—— 锐评要"有内味儿"就得知道这句在说什么。
   * ⚠️ 没有它，模型只能干巴巴地复述分数与错误（"发音准确 82 分"），
   *    而写不出"有硅谷高管内味儿"那种话（用户给的例子就是这么来的）。
   */
  translation?: string | null
  /** 标签（如 职场 / 科技）—— 同上，给"味道"提供依据 */
  tags?: string[]
  /** 读得最差的几个词 */
  weakWords: { word: string; score: number; dp?: string }[]
  /** 读错的音素（gwpp 明显为负），已去重 */
  badPhones: string[]
  /** 音节检错率 0–1（拿不到时 undefined） */
  syllableErrorRate?: number
  /** 词间长停顿次数 */
  longGapCount: number
  /** 是否被门槛压过（有漏读/替换） */
  gated: boolean
}

/**
 * ⭐⭐ **AI 锐评**（用户 2026-10-15 重新定义）。
 *
 * 一条 40–70 字、**有观点有画面**的点评（例：「这一句连读绝了，有硅谷高管内味儿，全场MVP！
 * 唯一的缺点就是 'accept' 吞音了，导致气势弱了半截。」）。
 *
 * ⚠️⚠️ **只有一段**：这里原来还有一个 `advice`（2-3 句练法）——
 *    用户 2026-10-15：「advice 坦白说讯飞反馈的那个报告本身就很全面了」
 *    ⇒ 我们再说一遍就是同一件事两处，那个字段连同生成一起删了。
 * ⚠️ 它不是"评分报告"：分数与五维由结果面板自己画，锐评只负责**观点**。
 */
export interface CoachFeedback {
  comment: string
}

/** 锐评的长度区间（汉字）—— 下限保证"有内容"，上限保证版位不爆（≈2 行） */
const COMMENT_MIN = 40
const COMMENT_MAX = 70

function dpText(dp: string): string {
  const m: Record<string, string> = {
    omission: '漏读',
    insertion: '多读了',
    repetition: '回读',
    mispronunciation: '读错',
  }
  return m[dp] ?? dp
}

function buildPrompt(f: CoachFacts): string {
  const weak = f.weakWords
    .map((w) => w.word + '(' + Math.round(w.score) + '分' + (w.dp && w.dp !== 'normal' ? '，' + dpText(w.dp) : '') + ')')
    .join('、')
  const lines = [
    '参考文本：' + f.refText,
    f.translation ? '译文（这句在说什么）：' + f.translation : '',
    f.tags && f.tags.length ? '标签：' + f.tags.join('、') : '',
    '总分：' + f.score + '/100',
    '分项（0-100）：韵律 ' + f.parts.prosody + '、发音短板 ' + f.parts.weakness + '、发音准确 ' + f.parts.accuracy + '、流利 ' + f.parts.fluency + '、完整 ' + f.parts.completeness,
    '读得最差的词：' + (weak || '（没有明显弱的词）'),
    f.badPhones.length ? '读错的音素（音标）：' + [...new Set(f.badPhones)].join('、') : '没有明显读错的音素',
    f.syllableErrorRate === undefined ? '' : '音节读错比例：' + Math.round(f.syllableErrorRate * 100) + '%',
    f.longGapCount > 0 ? '词间长停顿：' + f.longGapCount + ' 次' : '没有明显的长停顿',
    f.gated ? '注意：有词漏读或被读成别的词，分数已被封顶' : '',
  ].filter(Boolean)

  /**
   * ⚠️ 语气**跟分数走**（prd §7.2b）：高分吹爆 + 一个硬伤、中分肯定一处 + 点明短板、
   *    低分先给台阶。不按分数走的话，40 分与 95 分会拿到同一种腔调 —— 那是模板不是锐评。
   */
  const tone =
    f.score >= 85
      ? '这一把很好：**先放开夸**（夸具体的表现，比如连读、节奏、气势），再点出**唯一的那个硬伤**。'
      : f.score >= 60
        ? '这一把中等：**先肯定确实做对的一处**，再点明**最拖后腿的那一个**问题。'
        : '这一把偏弱：**先给个台阶**（别让人难堪），再用一个最该改的点收尾。'

  return [
    ...lines,
    '',
    '请基于以上数据输出 JSON（不要多余文字）：',
    '{"comment": "一条 40-70 字的锐评"}',
    '',
    '要求：',
    '1. comment 是一条**锐评**：像懂行的朋友在群里点评，**有观点、有画面、好玩**（例：「这一句连读绝了，有硅谷高管内味儿，全场MVP！唯一的缺点就是 accept 吞音了，导致气势弱了半截」）；',
    '2. ' + tone,
    '3. ⭐ **用上这句本身的语境**（内容 / 译文 / 标签）来说它"是什么味儿" —— 但**不要**复述整句原文；',
    '4. ⭐ **必须点名具体的词或音**（用上面给的证据），并说清**它毁了什么**（"吞音 ⇒ 气势弱半截"），不要只说"发音不准"；',
    '5. 可以是 1-2 句、可以用感叹号，但**不要**用引号包裹整段、不要换行；',
    '6. 不许：人身攻击、低俗、编造上面没提到的错误、"多加练习"这类空话、复述分数、**任何关于名次/全场排名的断言**（你看不到榜单，说了就是编）。',
  ].join('\n')
}

/**
 * 解析并**净化**模型返回。
 *
 * ⚠️ 净化不是洁癖：这句 comment 会直接展示在结果页上，
 *    带引号、带句号、超长都会让版面错乱，而这些模型经常犯。
 */
export function parseCoachReply(raw: string): CoachFeedback | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let obj: { comment?: unknown }
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as { comment?: unknown }
  } catch {
    return null
  }
  /**
   * ⚠️ 净化：**标点留着**（锐评本来就要感叹号），只去掉包裹用的引号与换行。
   *    原来这里把 `。，！？` 全删了 —— 那是给"4-8 字短语"用的口径，锐评照那样会被削成电报体。
   */
  const comment = String(obj.comment ?? '')
    .replace(/^[「『“"']+|[」』”"']+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, COMMENT_MAX)
  if (comment.length < COMMENT_MIN) return null
  return { comment }
}

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs?: number
}

/**
 * ⭐⭐ **模型通道**（OpenAI 兼容的 `/chat/completions`）—— 全服务端**只此一处**发请求。
 *
 * ⚠️ 谁要调模型都从这里走（现在两个调用方：`generateCoachFeedback` 的单次点评、
 *    `services/summary.ts` 的逐轮总结）—— 抄一份 fetch 就会分叉出两套超时/重试/日志，
 *    而"哪一套在生效"是查不出来的。
 *
 * @returns 失败、超时、返回不合法一律 null（见文件头的约束 2：失败必须静默降级）。
 */
export async function callLlm(
  cfg: LlmConfig,
  system: string,
  user: string,
  opts: { json?: boolean; temperature?: number } = {},
): Promise<string | null> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 12_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts.temperature ?? 0.4,
        /** ⚠️ 锐评要个性 ⇒ 调用方传 0.8（见 generateCoachFeedback） */
        /**
         * ⚠️⚠️ 2000 不是随手写的：deepseek-v4-flash 这类**带推理**的模型，
         *    推理内容（reasoning_content）也吃 max_tokens。
         *    给 400 时实测：推理用了 1316 token，**正文直接是空的**，
         *    于是我们拿到一段"合法但没内容"的响应（status 200）——
         *    表现为「AI 点评时有时无」，而日志里看不出谁错了。
         *    给 2000 之后正文正常返回（推理 512 + 正文 165）。
         */
        max_tokens: 2000,
        ...(opts.json === false ? {} : { response_format: { type: 'json_object' } }),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn('[coach] 模型返回 ' + res.status)
      return null
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[]
    }
    const msg = body.choices?.[0]?.message
    const text = msg?.content ?? ''
    /**
     * ⚠️ 正文为空、推理不为空 = 推理吃光了 max_tokens（见上面那段说明）。
     *    这种情况必须**单独报出来**，否则和一个"模型瞎回"的报错混在一起，
     *    下次还会再查一遍。
     */
    if (!text.trim() && msg?.reasoning_content) {
      console.warn('[coach] 模型只回了推理内容、没有正文 —— max_tokens 给太小了')
      return null
    }
    return text
  } catch (err) {
    console.warn('[coach] 调用失败：' + (err as Error).message)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 单次点评（结果页那两句话）。
 * @returns 失败一律 null（见文件头的约束 2）。
 */
export async function generateCoachFeedback(
  facts: CoachFacts,
  cfg: LlmConfig,
): Promise<CoachFeedback | null> {
  /**
   * ⚠️ 温度 **0.8**：锐评的价值在"有个性"，而 0.4 那档出来的是教科书腔
   *    （"发音准确，但流利度有待提高"）—— 那种话用户不会想读第二遍。
   *    仍然远低于 1.0，不至于胡说。
   */
  const text = await callLlm(cfg, '你是英语朗读教练，点评犀利、有画面感。只输出 JSON。', buildPrompt(facts), {
    json: true,
    temperature: 0.8,
  })
  if (!text) return null
  const parsed = parseCoachReply(text)
  if (!parsed) console.warn('[coach] 返回没法解析，本次不给建议')
  return parsed
}
