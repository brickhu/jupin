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
export function missingWordsOf(refText: string, engineWords: string[]): number[] {
  const refNorm = plainWordsOf(refText).map(norm)
  const engNorm = engineWords.map(norm)
  const n = refNorm.length
  const m = engNorm.length
  if (n === 0) return []
  // 一个字都没转写出来 ⇒ 整句都没读到（这是最强的信号，不是"没数据"）
  if (m === 0) return refNorm.map((_, i) => i)

  /** ⚠️ 这两个常数就是面那段注释描述的判据本身 —— 改它们等于改产品行为 */
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

  // 回溯：**先试替换**（它最便宜），只有实在配不上才记一个缺位
  const out: number[] = []
  let i = n
  let j = m
  while (i > 0 || j > 0) {
    const cur = (dp[i] as number[])[j] as number
    if (i > 0 && j > 0) {
      const same = refNorm[i - 1] === engNorm[j - 1]
      const sub = ((dp[i - 1] as number[])[j - 1] as number) + (same ? 0 : SUB)
      if (Math.abs(sub - cur) < 1e-9) {
        i--
        j--
        continue
      }
    }
    if (i > 0 && ((dp[i - 1] as number[])[j] as number) + GAP === cur) {
      out.push(i - 1)
      i--
      continue
    }
    j--
  }
  return out.reverse()
}
