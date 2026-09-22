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
  const refNorm = refText
    .split(/\s+/)
    .filter(Boolean)
    .map(norm)
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
