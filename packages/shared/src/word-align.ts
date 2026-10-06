/**
 * ⭐ 把引擎的逐词结果**对齐**到参考原文的词上。
 *
 * ⚠️⚠️ 为什么必须对齐、不能按下标硬套：
 *    引擎返回的词表与参考原文**不保证一一对应** —— 实测有一条：
 *
 *      原文: The best way to predict the future is to invent it.   （11 个词）
 *      引擎: the best way to predict fil the future is to invent it（12 个词）
 *                                      ↑ 多出来一个 fil —— 读成了别的音，被当成插入词
 *
 *    按下标套的话，从那个插入词往后**每一个词的颜色都是错的**（第 6 个词的分数
 *    套在第 7 个词上）。而界面上完全看不出来：每个词都有颜色，只是张冠李戴。
 *    ⇒ 用词本身对齐（LCS）：插入的词直接忽略、漏读的词留空（不上色）。
 *
 * ⚠️ 比较前先**归一化**（小写 + 去掉标点）：引擎给的是 the，原文里是 The / it.，
 *    不归一化会把每个带标点的词都当成对不上。
 */

import { plainWordsOf } from './tokenize'

/** 归一化：小写 + 只留字母数字和撇号（it. → it；The → the） */
function norm(w: string): string {
  return w.toLowerCase().replace(/[^a-z0-9']/g, '')
}

/**
 * 对齐。返回**逐个原文词**对应的引擎词下标（对不上就是 null）。
 *
 * ⚠️ 用最长公共子序列（LCS）而不是「按顺序贪心」：贪心遇到重复词
 *    （原句里的 the / to 各出现两次）会把后面的匹配位置整体带偏。
 * ⚠️ 词量是几十个量级，O(n·m) 完全够用 —— 不要为此引任何库。
 */
export function alignWordScores(refText: string, engineWords: string[]): (number | null)[] {
  // ⚠️ 切词走唯一实现（plainWordsOf）—— 这里的下标就是客户端点词的下标
  const refNorm = plainWordsOf(refText).map(norm)
  const engNorm = engineWords.map(norm)
  const n = refNorm.length
  const m = engNorm.length
  const out: (number | null)[] = new Array(n).fill(null)
  if (n === 0 || m === 0) return out

  // dp[i][j] = refNorm[i..] 与 engNorm[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = dp[i] as number[]
      const next = dp[i + 1] as number[]
      row[j] =
        refNorm[i] === engNorm[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number)
    }
  }

  // 回溯：相等就配对，否则往大的那边走
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (refNorm[i] === engNorm[j]) {
      out[i] = j
      i++
      j++
      continue
    }
    const down = (dp[i + 1] as number[])[j] as number
    const right = (dp[i] as number[])[j + 1] as number
    if (down >= right) i++
    else j++
  }
  return out
}

/**
 * ⭐ 只报「**没读到**」的参考词下标 —— 给「漏读预检」用，与 alignWordScores 的差别是
 *    **替换（读错）一律不算**。
 *
 * ⚠️⚠️ 为什么不能直接用上面那个 alignWordScores（它在做 LCS，只认「完全相等」）：
 *    2026-10 实测（9 段真人录音，转写用 ASR）—— 用 LCS 判漏读的**假阳性是 50%**：
 *    学习者把 `simpler` 读得让 ASR 听成 `similar` / `as simple` / `by the seminar`，
 *    这些**替换**在 LCS 里一律表现为「这个参考词没对上」⇒ 全被判成漏读。
 *    但用户明明读了 —— 那一位上是有东西的。
 *
 * ⭐ 所以这里换成**带代价的序列对齐**，并让**替换明显便宜于缺位**：
 *
 *     match = 0 · substitution = 1 · deletion / insertion = 3
 *
 *    ⇒ 对齐器会把「词对不上」**优先解释成读错**（替换），
 *      只有**整段位置空着**才解释成没读到（缺位）。
 *      换成这套判据之后，同一批数据的假阳性降到 **0/8**。
 *
 * ⭐ 为什么这个错误方向是对的：门禁的代价**不对称** ——
 *    「漏放」（真漏读没抓到）只是维持现状（照常提交、由讯飞判，代价是那一次评测费）；
 *    「误拦」（明明读了却交不上去）会直接毁掉这个功能。
 *
 * ⚠️ 已知边界（实测，别指望它超出这个范围）：
 *    · **单个词的漏读抓不到** —— ASR 会顺着上下文把它「脑补」出来
 *      （实测把剪掉的 `simple` 补成 `as soon` / `as long` / `as as`），转写里根本不缺位；
 *    · 抓得到的是**连续多词的缺失**（实测剪掉连续 3 个词：5/5 检出）。
 *
 * @returns 参考词里「没有任何转写词与之对应」的那些下标（升序）
 */
/**
 * ⭐ 对齐的**唯一实现** —— 把参考词逐个对到转写词上；对不上就是 `null`。
 *
 * ⚠️ 两个出口共用它，别再写第二份：
 *    · `missingWordsOf`（定稿用）—— 所有 null 都是「没读到」；
 *    · `wordProgressOf`（流式用）—— 还要按"最后一个匹配上的词"把 null 切成
 *      「已越过的漏读」与「还没读到的」两段。
 *
 * ⭐ 代价模型：`match 0 · substitution 1 · deletion/insertion 3`。
 *    **替换必须明显便宜于缺位** —— 否则每个 ASR 听错的词都会被算成缺位
 *    （B40 实测：用 LCS 那种只认"完全相等"的算法，假阳性 50%；
 *      换成这套代价之后降到 0/8）。
 *
 * @param refNorm 归一化后的参考词
 * @param engNorm 归一化后的转写词
 * @returns 长度 = 参考词数；`out[i]` 是第 i 个参考词对到的转写下标，对不上是 null
 */
function alignRefToSpoken(refNorm: string[], engNorm: string[]): (number | null)[] {
  const n = refNorm.length
  const m = engNorm.length
  const out: (number | null)[] = new Array<number | null>(n).fill(null)
  if (n === 0 || m === 0) return out

  /** ⚠️ 这两个常数就是判据本身 —— 改它们等于改产品行为 */
  const SUB = 1
  const GAP = 3

  // dp[i][j] = refNorm 前 i 个 与 engNorm 前 j 个 的最小对齐代价
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = 1; i <= n; i++) (dp[i] as number[])[0] = i * GAP
  for (let j = 1; j <= m; j++) (dp[0] as number[])[j] = j * GAP
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const same = refNorm[i - 1] === engNorm[j - 1]
      const row = dp[i] as number[]
      const prev = dp[i - 1] as number[]
      row[j] = Math.min(
        (prev[j - 1] as number) + (same ? 0 : SUB),
        (prev[j] as number) + GAP,
        (row[j - 1] as number) + GAP,
      )
    }
  }

  /**
   * 回溯：**并列时先试缺位**。
   *
   * ⚠️⚠️ 为什么顺序要紧：参考句里**重复词**很常见（`…as simple as possible…` 里两个 `as`），
   *    流式听到 `…made as possible` 时存在**两条同价路径** ——
   *      · 前一个 `as` 对上、`simple` 与后一个 `as` 缺位   ← 我们要的
   *      · 前一个 `as` 缺位、后一个 `as` 对上、`simple` 缺位
   *    先试缺位 ⇒ 匹配落在**靠前**的那个词上，于是被跳过的是 `simple` 和**后一个** `as` ——
   *    这与人的直觉一致（先读到的 `as` 就是你读的那个）。
   *    ⚠️ 对**流式**还多一层好处：进度推进得更晚 = 更保守（宁可不标"已读"）。
   *
   * ⚠️ 只在**代价完全相等**时才有影响；不等价时仍由代价决定，判据本身没变。
   */
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const cur = (dp[i] as number[])[j] as number
    if (i > 0 && ((dp[i - 1] as number[])[j] as number) + GAP === cur) {
      i-- // 这个参考词缺位 —— out[i-1] 保持 null
      continue
    }
    if (i > 0 && j > 0) {
      const same = refNorm[i - 1] === engNorm[j - 1]
      const sub = ((dp[i - 1] as number[])[j - 1] as number) + (same ? 0 : SUB)
      if (Math.abs(sub - cur) < 1e-9) {
        out[i - 1] = j - 1 // ⭐ 对上了（相等或替换 —— 替换也算"读到了"）
        i--
        j--
        continue
      }
    }
    j--
  }
  return out
}

/** 参考文本 + 转写词 → 两边都归一化后对齐（唯一入口，避免各处各归一化一次） */
function alignText(refText: string, spokenWords: string[]): (number | null)[] {
  return alignRefToSpoken(plainWordsOf(refText).map(norm), spokenWords.map(norm))
}

/**
 * ⭐ 只报「**没读到**」的参考词下标 —— 给**定稿**用（漏读门禁），与 alignWordScores
 *    的差别是**替换（读错）一律不算**。
 *
 * ⚠️⚠️ 为什么不能直接用上面那个 alignWordScores（它在做 LCS，只认「完全相等」）：
 *    2026-10 实测（9 段真人录音，转写用 ASR）—— 用 LCS 判漏读的**假阳性是 50%**：
 *    学习者把 `simpler` 读得让 ASR 听成 `similar` / `as simple` / `by the seminar`，
 *    这些**替换**在 LCS 里一律表现为「这个参考词没对上」⇒ 全被判成漏读。
 *    但用户明明读了 —— 那一位上是有东西的。
 *    换成带代价的对齐（见 `alignRefToSpoken`）之后，同一批数据的假阳性降到 **0/8**。
 *
 * ⭐ 为什么这个错误方向是对的：门禁的代价**不对称** ——
 *    「漏放」（真漏读没抓到）只是维持现状（照常提交、由讯飞判，代价是那一次评测费）；
 *    「误拦」（明明读了却交不上去）会直接毁掉这个功能。
 *
 * ⚠️ 已知边界（实测，别指望它超出这个范围）：
 *    · **单个词的漏读抓不到** —— ASR 会顺着上下文把它「脑补」出来
 *      （实测把剪掉的 `simple` 补成 `as soon` / `as long` / `as as`），转写里根本不缺位；
 *    · 抓得到的是**连续多词的缺失**（实测剪掉连续 3 个词：5/5 检出）。
 *
 * ⚠️ **流式中间结果不能直接用它** —— 用户读到一半时，后半句还没读到，用它会**全报成漏读**。
 *    那种场合要用 `wordProgressOf`。
 *
 * @returns 参考词里「没有任何转写词与之对应」的那些下标（升序）
 */
/** ⭐ 一次对齐能给出的**两种不同的"没读好"** */
export interface AlignmentDetail {
  /**
   * ⭐ **没读到** —— 转写里**完全没有**这个词的对应物（缺位）。
   * 这是最确定的一种：那一位上什么都没有。
   */
  missing: number[]
  /**
   * ⭐ **没读准** —— 对上了，但**转写里那个词跟原文不一样**（替换）。
   *
   * ⚠️⚠️ 拿它当"用户读错了"的证据**要非常小心**：替换的成因里混着
   *    「真的读错了」和「ASR 听错了」两种，而从转写里**分不出来**。
   *    2026-10 实测就是这个：学习者把 `simpler` 正常读出来，ASR 却听成
   *    `similar` / `as simple` / `by the seminar` 都出现过。
   *    ⇒ 所以措辞必须是「**识别到的是 X**」（机器听到了什么），
   *      **不能**写成「你读错了 X」。
   */
  substituted: { at: number; heard: string }[]
}

/**
 * ⭐⭐ **对齐的完整结果** —— 同时给出「没读到」与「没读准」，给提交前的提示用。
 *
 * ⚠️ 与 `missingWordsOf` 的关系：后者只要"没读到"（门禁只需要它，因为替换不可靠）。
 *    这里是**超集**，多给一列"识别到的是什么"。
 */
export function alignmentDetailOf(refText: string, spokenWords: string[]): AlignmentDetail {
  const refNorm = plainWordsOf(refText).map(norm)
  const engNorm = spokenWords.map(norm)
  const aligned = alignRefToSpoken(refNorm, engNorm)

  const missing: number[] = []
  const substituted: { at: number; heard: string }[] = []
  for (let i = 0; i < aligned.length; i++) {
    // ⚠️ `noUncheckedIndexedAccess` 让 aligned[i] 多带一个 undefined —— 一起挡掉
    const j = aligned[i]
    if (j === null || j === undefined) {
      missing.push(i)
      continue
    }
    // ⚠️ 报的是**转写里的原词**（不是归一化后的），因为那是要给人看的
    if (refNorm[i] !== engNorm[j]) substituted.push({ at: i, heard: spokenWords[j] ?? '' })
  }
  return { missing, substituted }
}

export function missingWordsOf(refText: string, engineWords: string[]): number[] {
  // ⭐ 与 alignmentDetailOf 共用同一次对齐，不再各写一遍（"重复即错误"）
  return alignmentDetailOf(refText, engineWords).missing
}

/** 流式过程中，一个参考词的三种处境 */
export interface WordProgress {
  /** ⭐ **已经越过、确实漏掉的**（最后一个匹配位置**之前**的缺位）—— 这是真的漏读，红 */
  missed: number[]
  /** ⭐ **还没读到的**（最后一个匹配位置**之后**）—— 灰，不是错，别标红 */
  pending: number[]
  /** 最后一个匹配上的参考词下标；`-1` = 一个词都还没对上 */
  lastMatched: number
}

/**
 * ⭐⭐ **流式进度** —— 「边读文字边变色」的判据（用户 2026-10 定）。
 *
 * ⚠️⚠️ 为什么不能拿 `missingWordsOf` 顶替：它是**定稿**判据，
 *    把「所有对不上的参考词」都算成漏读。而流式过程中用户**还没读到后半句** ——
 *    那时候用它会**把后半句整片标红**，看起来像"你漏了一大半"。
 *
 * ⭐ 所以这里**以最后一个匹配上的参考词为界切一刀**：
 *
 *     参考 [a b c d]，流式听到 [a c] ⇒ 对齐 a↔a · b→空 · c↔c · d→空
 *       · b 在最后一个匹配（c）**之前** ⇒ **missed**（越过去了没读）🔴
 *       · d 在**之后**                     ⇒ **pending**（还没读到）⚪
 *
 * ⚠️ 定稿（`onStop`）之后不再有 pending —— 那时剩下的缺位全是漏读，门槛回到 `missingWordsOf`。
 * ⚠️ 门禁**只对定稿生效**：流式过程中的红只是提示，不能拦提交（那时候句子本来就没读完）。
 */
export function wordProgressOf(refText: string, spokenWords: string[]): WordProgress {
  const aligned = alignText(refText, spokenWords)

  let lastMatched = -1
  for (let i = 0; i < aligned.length; i++) if (aligned[i] !== null) lastMatched = i

  const missed: number[] = []
  const pending: number[] = []
  for (let i = 0; i < aligned.length; i++) {
    if (aligned[i] !== null) continue
    if (i < lastMatched) missed.push(i)
    else pending.push(i)
  }
  return { missed, pending, lastMatched }
}
