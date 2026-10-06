/**
 * ⭐⭐ 提交前那道提示的**正文** —— 把「没读到」和「没读准」分开说（用户 2026-10 定）。
 *
 * ⚠️⚠️ 两件事**必须分开说**，因为它们对学习者的含义完全不同：
 *    · **没读到** —— 那一位上什么都没有（跳过了 / 那句没跟上）；
 *    · **没读准** —— 读到了，但**机器听到的是另一个词**。
 *
 * ⚠️⚠️ 而"没读准"那行的措辞**只能是「识别成 X」**，绝不能写成「你读错了 X」：
 *    那是在陈述**机器听到了什么**，不是在判定用户读错了。
 *    原因：替换的成因里混着「真的读错了」和「ASR 听错了」两种，**从转写里分不出来** ——
 *    2026-10 实测，学习者正常读出 `simpler`，ASR 听成 `similar` / `as simple` /
 *    `by the seminar` 都出现过。写成"你读错了"就是把机器的错算到用户头上。
 *
 * ⚠️ 单独放一个纯函数（而不是写在页面里）有两个理由：
 *    ① 措辞是**产品口径**，值得被单测钉住，不该散在页面逻辑中间；
 *    ② 它是纯的 —— 给定两个数组，输出永远一样，没有任何页面状态混进来。
 */

/** 没读准的一条：原文词 + 识别到的那个词 */
export interface MisreadPair {
  ref: string
  heard: string
}

/** 最多列几个词 —— 再多弹窗就变成一堵墙了，超出只说个数 */
const MAX_LISTED = 6

function listWords(words: string[]): string {
  if (words.length <= MAX_LISTED) return words.join('、')
  return words.slice(0, MAX_LISTED).join('、') + ' 等 ' + words.length + ' 个'
}

export function gateMessage(missed: string[], misread: MisreadPair[]): string {
  const lines: string[] = []

  if (missed.length > 0) {
    lines.push('没读到 ' + missed.length + ' 个：' + listWords(missed))
  }

  if (misread.length > 0) {
    const pairs = misread.map((p) => p.ref + '（识别成 ' + p.heard + '）')
    lines.push('没读准 ' + misread.length + ' 个：' + listWords(pairs))
  }

  // ⚠️ 两个都空时不该被调用（没有可说的就不弹窗）；真被调到了就返回空串，
  //    让调用方看得见"没内容"，而不是弹出一个空白弹窗
  return lines.join('\n')
}
