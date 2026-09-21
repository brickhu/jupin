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

export interface CoachFeedback {
  comment: string
  advice: string
}

/** 点评最多 8 个字 —— 长了就不是「短语」，展示位上会换行 */
const COMMENT_MAX = 8

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
    '总分：' + f.score + '/100',
    '分项（0-100）：韵律 ' + f.parts.prosody + '、发音短板 ' + f.parts.weakness + '、发音准确 ' + f.parts.accuracy + '、流利 ' + f.parts.fluency + '、完整 ' + f.parts.completeness,
    '读得最差的词：' + (weak || '（没有明显弱的词）'),
    f.badPhones.length ? '读错的音素（音标）：' + [...new Set(f.badPhones)].join('、') : '没有明显读错的音素',
    f.syllableErrorRate === undefined ? '' : '音节读错比例：' + Math.round(f.syllableErrorRate * 100) + '%',
    f.longGapCount > 0 ? '词间长停顿：' + f.longGapCount + ' 次' : '没有明显的长停顿',
    f.gated ? '注意：有词漏读或被读成别的词，分数已被封顶' : '',
  ].filter(Boolean)

  return [
    ...lines,
    '',
    '请基于以上数据输出 JSON（不要多余文字）：',
    '{"comment": "4-8 个汉字的点评", "advice": "2-3 句提升建议"}',
    '',
    '要求：',
    '1. comment 必须是 4-8 个汉字，像一句评价（例：语调偏平、几个词卡壳、发音很稳），不带标点、不带引号；',
    '2. advice 必须指名道姓：说清是哪个词、哪个音的问题，并给一个能马上照做的练法；',
    '3. 不要客套话、不要「多加练习」这类空话，不要重复分数；',
    '4. 只依据上面给的证据，不要编造没有提到的错误。',
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
  let obj: { comment?: unknown; advice?: unknown }
  try {
    obj = JSON.parse(raw.slice(start, end + 1)) as { comment?: unknown; advice?: unknown }
  } catch {
    return null
  }
  const comment = String(obj.comment ?? '')
    .replace(/[「」“”"'。，,.!！?？\s]/g, '')
    .slice(0, COMMENT_MAX)
  const advice = String(obj.advice ?? '').trim().slice(0, 220)
  if (!comment || !advice) return null
  return { comment, advice }
}

/**
 * 调一次模型（OpenAI 兼容的 /chat/completions）。
 *
 * @returns 失败一律返回 null（见文件头的约束 2）。
 */
export async function generateCoachFeedback(
  facts: CoachFacts,
  cfg: { apiKey: string; baseUrl: string; model: string; timeoutMs?: number },
): Promise<CoachFeedback | null> {
  const url = cfg.baseUrl.replace(/\/+$/, '') + '/chat/completions'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 12_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.4,
        /**
         * ⚠️⚠️ 2000 不是随手写的：deepseek-v4-flash 这类**带推理**的模型，
         *    推理内容（reasoning_content）也吃 max_tokens。
         *    给 400 时实测：推理用了 1316 token，**正文直接是空的**，
         *    于是我们拿到一段"合法但没内容"的响应（status 200）——
         *    表现为「AI 点评时有时无」，而日志里看不出谁错了。
         *    给 2000 之后正文正常返回（推理 512 + 正文 165）。
         */
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: '你是英语朗读教练。只输出 JSON。' },
          { role: 'user', content: buildPrompt(facts) },
        ],
      }),
      signal: controller.signal,
    })
    if (!res.ok) {
      console.warn('[coach] 模型返回 ' + res.status + '（本次不给建议）')
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
    const parsed = parseCoachReply(text)
    if (!parsed) console.warn('[coach] 返回没法解析，本次不给建议')
    return parsed
  } catch (err) {
    console.warn('[coach] 调用失败（本次不给建议）：' + (err as Error).message)
    return null
  } finally {
    clearTimeout(timer)
  }
}
