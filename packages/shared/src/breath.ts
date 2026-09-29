/**
 * ⭐ 呼吸群 / 音节 —— 朗读度量的小工具。
 *
 * ⚠️⚠️ **现状先说清**：这两组函数**目前不参与判据**。
 *    "句子长度"那一维最终定的是**按字符数**（见文件末尾的 `lengthLevelOf`）——
 *    用户 2026-09 的原话是"哎，麻烦。你直接按照句子长度算最好"。
 *    这里保留它们是因为它们**本身是对的**（音节来自 CMU 词典、呼吸群按停顿标点切），
 *    而且已经想过用它们替代词数（中间那一版）；将来若要更贴朗读难度，它们是现成的骨料。
 *
 * ⚠️ 别误用成"难度"：呼吸群数多**不等于**难（标点多的短句会被切得很碎）。
 *    要判难度用 `lengthLevelOf`（当前口径），不要拿这里的数直接定档。
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

/**
 * ⭐⭐ **"句子长度"这一维的定档**（1–5）—— **纯按长度算，不经过模型**。
 *
 * ⚠️⚠️ 三次口径的演进，别再来第四次：
 *    ① 最初：**数词数**（`<10 / 10–20 / 20–30 / 30–40 / >40 词`）—— 让模型判。
 *       用户 2026-09 指出不合理（"判断句子长度用的是单词数量"）。
 *    ② 中间：改成**呼吸群 + 音节**，把算好的数喂给模型让它定档 ——
 *       更贴朗读难度，但用户嫌麻烦（"哎，麻烦。你直接按照句子长度算最好"）。
 *    ③ **现在：就按字符数算，代码定档**，模型完全不参与这一维。
 *
 * ⚠️ 阈值取自库里 16 句的**真实长度分布**（42–210 字符），没有拍脑袋：
 *    42×2 · 51/65/83/86/87（5 句）· 97/120（2 句）· 143–179（4 句）· 189/210（2 句）。
 *    分界落在 50 / 90 / 140 / 190 —— 每档都有真实句子，且没有把同质句子切开。
 *
 * ⚠️ 计的是 `text.length`（含空格与标点）：最简单、最好解释、也最接近"看起来多长"。
 *    要改成"不含空格"或"音节"就改这里一处 —— 全端与全量重算都跟着变。
 */
export const LENGTH_CHAR_STEPS = [50, 90, 140, 190] as const

export function lengthLevelOf(text: string): number {
  const n = String(text ?? '').length
  let lv = 1
  for (const step of LENGTH_CHAR_STEPS) {
    if (n > step) lv++
  }
  return lv
}
