/**
 * ⭐⭐ **呼吸群**（breath group）—— 朗读里"一口气能读完的一段"。
 *
 * ⚠️⚠️ 为什么需要它（用户 2026-09 的意见）：
 *    "句子长度"这条判据原来按**词数**定档（`<10 / 10–20 / 20–30 / 30–40 / >40 词`），
 *    但对**朗读**来说词数根本不是难点 —— 真正决定"读起来累不累"的是
 *    **要动多少下嘴（音节）** 和 **能不能一口气读完（呼吸群）**。
 *    真实对照（库里就有）：
 *      · 16 词 / 48 音节 / **1 个呼吸群** —— 「The precipitous proliferation of gratuitous…」
 *      ·  8 词 /  8 音节 / 2 个呼吸群   —— 「Don't count the days, make the days count.」
 *    按词数这两句都算"短句"（前者 16 词、后者 8 词，都在 L2 以下）；
 *    而前者一口气要读 48 拍 —— 那才是它的难。
 *
 * ⚠️ 口径（**全仓库只有这一处实现**）：按**停顿标点**切段，非空段算一个呼吸群。
 *    标点：`. , ; : ! ? … — –` 以及换行；括号/引号**不切**（它们不改停顿）。
 *    ⚠️ 别顺手把破折号两边的空格也算进去 —— 破折号本身就是停顿标记。
 */
const PAUSE = /[.,;:!?…—–]+/

/**
 * ⚠️ 括号 / 引号**里面**的标点不算停顿（插入语、引述都是"不停"的）：
 *    `He left (quietly, without a word), and she stayed.` ⇒ **2** 个呼吸群，不是 3。
 *    ⇒ 按括号深度把里层的标点先换成哨兵字符，切分后再换回来。
 *    （真实用例里的引号内逗号同理 —— 单测盯着这条。）
 * ⚠️ 已知取舍：被遮蔽的那个标点**在返回的段里会消失**（`…word),` → `…word)`）——
 *    它只用于"数呼吸群/数音节"，标点不是判据的一部分；要精确原文请用 `text` 那一列。
 */
/**
 * ⚠️ 哨兵用**私用区字符**（U+E000），不能用逗号之类：用逗号的话，
 *    括号内的原标点会被改写成逗号（切分后要还原成**原样** —— 它只是"不算停顿"，
 *    不是"变成逗号"）。私用区字符在真实文本里不会出现，且长度与标点相同 ⇒ 还原按位对齐。
 */
const MASK = '\ue000'
const OPEN = '(（[【"\u201c\u2018'
const CLOSE = ')）]】"\u201d\u2019'

/** 括号/引号内的标点 → 哨兵（保持**位置**，还原时按位换回原字符） */
function maskInsideBrackets(text: string): { masked: string; hidden: string[] } {
  let depth = 0
  let masked = ''
  const hidden: string[] = []
  for (const ch of text) {
    if (OPEN.includes(ch)) depth++
    else if (CLOSE.includes(ch)) depth = Math.max(0, depth - 1)
    if (depth > 0 && PAUSE.test(ch)) {
      masked += MASK
      hidden.push(ch)
    } else {
      masked += ch
    }
  }
  return { masked, hidden }
}

export function breathGroupsOf(text: string): string[] {
  const out: string[] = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const { masked, hidden } = maskInsideBrackets(line)
    let h = 0
    for (const seg of masked.split(PAUSE)) {
      /**
       * ⚠️ 还原哨兵：切分**不会**拆散哨兵（它不是停顿字符），所以按出现顺序逐个换回原标点。
       *    用回调而不是全局替换 —— 免得正则的 `$&` 之类特殊序列被解释。
       */
      const restored = seg.replace(new RegExp(MASK, 'g'), () => hidden[h++] ?? MASK)
      const clean = restored.replace(/\s+/g, ' ').trim()
      if (clean !== '') out.push(clean)
    }
  }
  return out
}

export function breathGroupCount(text: string): number {
  return breathGroupsOf(text).length
}

/**
 * ⭐ 一个呼吸群里有多少"拍"（音节）—— 用来抓"总量不多、但一口气读不完"的句子。
 *
 * ⚠️ 它需要逐词音节（`words[].syllables`，由 CMU 词典算出，见 tools/pipeline 的 word-info）。
 *    没有词表时退回**按空白切词、每词算 1 拍**的粗估 —— 宁可粗略也不要返回 0。
 */
export function syllablesPerBreathGroup(
  text: string,
  words?: Array<{ text: string; syllables?: string[] }>,
): number[] {
  const groups = breathGroupsOf(text)
  if (!words || words.length === 0) {
    return groups.map((g) => g.split(/\s+/).filter(Boolean).length)
  }
  const sylOf = new Map<string, number>()
  for (const w of words) {
    const n = (w.syllables?.length ?? 0) || 1
    const key = w.text.toLowerCase().replace(/[^a-z']/g, '')
    if (key) sylOf.set(key, n)
  }
  return groups.map((g) => {
    const tokens = g.split(/\s+/).filter(Boolean)
    let n = 0
    for (const t of tokens) {
      const key = t.toLowerCase().replace(/[^a-z']/g, '')
      n += sylOf.get(key) ?? (key ? Math.max(1, Math.ceil(key.length / 3)) : 0)
    }
    return n
  })
}

export function syllableCount(
  text: string,
  words?: Array<{ text: string; syllables?: string[] }>,
): number {
  return syllablesPerBreathGroup(text, words).reduce((a, b) => a + b, 0)
}
