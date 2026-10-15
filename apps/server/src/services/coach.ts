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
 *
 * ⭐⭐ **它写给"这一份成绩单"**（用户的比喻：**像考完试老师在卷子后面写的一句话**）——
 *    针对的就是**这一次录音**。之后如果这把**超越前高被采纳**，整份试卷（含这句批语）
 *    才写进战绩档案（`participations`，读法见 `ParticipationRecord.bestComment`）。
 */
export interface CoachFeedback {
  comment: string
}

/**
 * 锐评的长度区间（含标点）。
 * ⚠️ 下限 **24**：真机实测里模型偶尔写出一句很短的俏皮话（"accept 吞音，气势全泄。"），
 *    那**不是**敷衍，反而比硬凑 40 字好听 —— 原来定 40 会把它直接判成"没法解析"丢掉。
 *    （下限的作用只是挡住"发音很稳"这种不成句的碎片。）
 * ⚠️ 上限 **70**：版位≈2 行；超了在**句子边界**收，见 parseCoachReply。
 */
const COMMENT_MIN = 24
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
      ? '这一把很好：**先放开夸**（夸具体的表现，比如连读、节奏、气势），再点出**唯一的那个硬伤**。可以浮夸、可以吹。'
      : f.score >= 60
        ? '这一把中等：**先肯定确实做对的一处**，再点明**最拖后腿的那一个**问题。中间这档最适合毒舌：夸一半损一半。'
        : '这一把偏弱：**可以狠**（用户 2026-10-15 的那条就是纯损、一句没夸），' +
          '**也可以**先给个台阶再收 —— 由你判断哪种更好笑、更像人说话。' +
          '⚠️ 但毒舌要**冲着这一遍的发挥**去（"像在向 HR 申请离职"），' +
          '**不要**说"你不适合/你基础差"这类否定人的话。'

  return [
    ...lines,
    '',
    '请基于以上数据输出 JSON（不要多余文字）：',
    '{"comment": "一条 40-' + COMMENT_MAX + ' 字的锐评"}',
    '',
    '要求：',
    '1. comment 是一条**锐评**：像懂行的朋友在群里点评 —— ⭐⭐ **必须幽默、有梗、有画面**，**可以毒舌**（用户 2026-10-15：「关键是要写到幽默有趣，甚至可以毒舌」）；',
    '1b. ⚠️⚠️ **1–2 句**（每句都以句末标点收住），**' + COMMENT_MIN + '-' + COMMENT_MAX + ' 字** —— 先想好再落笔；宁可短、必须说完；',
    '2. ' + tone,
    '3. ⭐ **用上这句本身的语境**（内容 / 译文 / 标签）来说它"是什么味儿" —— 但**不要**复述整句原文；',
    '4. ⭐⭐ **必须具体到这一遍**：',
    '   · **夸**要夸到点子上 —— 可以**直接把句子里的词/短语引出来**',
    '     （例：「这一声 NEVER GIVE UP 能量拉满！」），或说到具体的技术点（升调 / 连读 / 收尾 / 节奏 / 气势）；',
    '   · **有硬伤就点出来**，并说清**它毁了什么**（"吞音 ⇒ 气势弱半截"）—— 用上面给的证据（哪个词、哪个音）；',
    '   · ⚠️ **夸满了就不必硬找缺点**（这一遍确实好，就纯夸，别为了"平衡"编一个不满意出来）；',
    '   · ⚠️ 不许只说"发音不准""有待提高"这种**没有落点**的话。',
    '   · ⭐ **对比梗特别好用**：把它听起来的**效果**和一个荒唐的场面并起来',
    '     （例：「听起来不像要设计未来，像是在被未来暴打」）—— 用好一次就够，别硬凑。',
    '5. ⚠️⚠️ **总长不超过 ' + COMMENT_MAX + ' 个字（含标点）**：先想好要说的那句话再落笔，**宁可短**；' +
      '而且**必须把话说完**（结尾要收住，不要写到一半断掉）—— 超了字数就删细节，不要硬塞；',
    '6. 可以是 1-2 句、可以用感叹号，但**不要**用引号包裹整段、不要换行；',
    '7. ⚠️⚠️ 不许：低俗、编造上面没提到的错误、"多加练习"这类空话、**任何关于名次/全场排名的断言**；',
    '   · ⚠️⚠️ **分数与百分比一个都不要出现**（含"XX 分不冤"这种）：',
    '     真机实测模型曾把 58 分写成「48 分不冤」—— **编错的数字比不说更糟**。感受用形容词说。',
    '   · ⭐ 但**上面给的事实计数可以说**（"歇了四回""这个词卡了两次"）—— 前提是**数字必须对**、且确实来自上面那几行；',
    '     ⚠️ 它们比"停顿较多"生动得多，但**编一个数就全毁了**。',
    '8. ⚠️⚠️ **毒舌的边界**：损**这一遍的发挥**（发音、节奏、气势、状态）—— 不许损**人**（能力、智商、外貌、口音出身），不许让读者觉得"我不行"；',
    '9. ⚠️ **不要正能量套话**（"继续加油""已经很棒了"）—— 那种话不是锐评，是敷衍。',
    '',
    '⭐ **风格示例**（只学时态与狠劲，**内容要换成这次的证据**）：',
    '· 高分：「这一句连读绝了，有硅谷高管内味儿，全场MVP！唯一的缺点就是 accept 吞音了，气势弱了半截。」',
    '· 高分（纯夸 · 引用句中的词 · 玩梗）：「这一声 NEVER GIVE UP 能量拉满！后半句的升调简直自带 BGM，感觉你现在就能去把老板打一顿！」',
    '· 高分毒舌：「th 咬得比催债电话还认真，可惜最后那个 tension 直接摆烂，白瞎了前面 90 分的铺垫。」',
    '· 中分：「开口像刚开机，中段突然上了高速 —— 节奏不错，就是 risk 的 r 卷得像在漱口。」',
    '· 低分：「这句英文被你读成了电报：词与词各自为政，well 更是直接离家出走。别慌，先把它当一句话说完。」',
    '· 低分（纯损 · 对比梗 · 一句没夸）：「你这句 I design the future 读得像是在向 HR 申请离职，毫无气场。听起来不像要设计未来，像是在被未来暴打。」',
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
  const cleaned = String(obj.comment ?? '')
    /**
     * ⚠️⚠️ **内部的引号也要清**（不只是首尾）：真机实测出现过
     *    「Actions」的 æ 被你读成了打嗝」—— 模型把示例里的「」学进了正文，
     *    夹在中间看着像排版错乱。锐评里本来就不该有引号（要强调就用原词本身）。
     */
    .replace(/[「」『』“”"]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length < COMMENT_MIN) return null

  /**
   * ⚠️⚠️ **超长要在句子边界收，不能从词中间切断**。
   *
   *    真机实测（2026-10-15，用真模型跑三条）：模型经常写到 ~100 字，
   *    而硬 `slice(0, 70)` 会切出「…等于主播念到关键处突」这种**半句话** ——
   *    锐评最值钱的就是最后那个包袱，切在那儿比不写还糟。
   *    ⇒ 先在边界（。！？；，）里找**最靠后的那个**，从那儿收；实在没有才硬切。
   */
  if (cleaned.length <= COMMENT_MAX) return { comment: cleaned }
  const head = cleaned.slice(0, COMMENT_MAX)

  /**
   * ⚠️⚠️ **强边界优先**：先找句末（。！？），实在没有才退到分句（；，）。
   *
   *    这是真机实测逼出来的第二版：只在逗号上收会得到「…æ 跑偏、p 直接蒸发，」
   *    这种**没说完**的半句（用户 2026-10-15 的样本上就是这样）——
   *    逗号收住的仍是半句，读起来像被掐断。
   *    ⇒ 有句末就在句末收；一句到底（没句末）才退到分句。
   */
  const strong = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'))
  const weak = Math.max(head.lastIndexOf('；'), head.lastIndexOf('，'))
  const cut = strong + 1 >= COMMENT_MIN ? strong : weak

  /** ⚠️ 边界太靠前（<下限）也不收 —— 那等于把话说没了，宁可硬切 */
  const comment = cut + 1 >= COMMENT_MIN ? head.slice(0, cut + 1) : head
  return { comment }
}

export interface LlmConfig {
  apiKey: string
  baseUrl: string
  model: string
  timeoutMs?: number
}

/**
 * ⭐⭐ **默认的模型与基址**（全服务端**唯一一份**）。
 *
 * ⚠️⚠️ 模型名**必须**是官方模型清单里还在的那个（[Models & Pricing]）：
 *    写错时我们的失败是**静默**的 —— 调用被拒 ⇒ 锐评整块不渲染、**不报错**，
 *    看起来就像"这次没生成"，能查很久。
 *    · `deepseek-flash` = DeepSeek-V4.1-Flash（**带 Vision**；也是最新一代的通用档 ✅）
 *    · ⚠️ 老名字（`deepseek-chat`）已不在清单里；`deepseek-v4-flash` 官方标注**已退役**
 *      （请求会被 V4.1-Flash 接走并按 Flash 计费），不要再写。
 */
export const LLM_BASE_URL_DEFAULT = 'https://api.deepseek.com'
export const LLM_MODEL_DEFAULT = 'deepseek-flash'

/**
 * ⭐ **从环境变量拼出调用配置** —— 调用方（单次点评 / 逐轮总结）都用它。
 *
 * ⚠️ 为什么要有这个函数：原来两个调用方各自写 `?? 'deepseek-chat'`，
 *    默认值、基址各写一遍 ⇒ 改模型名要记得改两处（漏一处就是静默不工作）。
 */
export function llmConfigOf(envLike: {
  LLM_API_KEY?: string | undefined
  LLM_BASE_URL?: string | undefined
  LLM_MODEL?: string | undefined
}): LlmConfig {
  return {
    apiKey: envLike.LLM_API_KEY ?? '',
    baseUrl: envLike.LLM_BASE_URL ?? LLM_BASE_URL_DEFAULT,
    model: envLike.LLM_MODEL ?? LLM_MODEL_DEFAULT,
  }
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
  const text = await callLlm(
    cfg,
    '你是一个毒舌但懂行的英文朗读陪练：点评要短、要狠、要好笑，但永远只损"这一遍的发挥"、不损人。只输出 JSON。',
    buildPrompt(facts),
    {
      json: true,
      temperature: 0.8,
    },
  )
  if (!text) return null
  const parsed = parseCoachReply(text)
  if (!parsed) console.warn('[coach] 返回没法解析，本次不给建议')
  return parsed
}
