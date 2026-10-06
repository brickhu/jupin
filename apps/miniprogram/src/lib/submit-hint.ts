/**
 * ⭐⭐ **提交按钮下面那一行提示** —— 提交前唯一要说的那句话（用户 2026-10 定）。
 *
 * ⚠️ 它替代了早先的**弹窗**：信息在按提交**之前**就摆在那里，看得见、不用被弹窗打断。
 *    ⇒ 措辞是**建议**（"建议重试"），不是判决 —— 判决是提交之后云端那一次。
 *
 * 六种情形（用户给的原话顺序，即优先级）：
 *
 *   1. 朗读完整，点击提交 AI 检测并打分
 *   2. 漏读 N 个单词，建议重试
 *   3. 读错 N 个单词，建议重试
 *   4. 漏读 N 个单词，读错 M 个单词，建议重试
 *   5. 读得有点慢，建议重读一遍后提交
 *
 * ⚠️ "读得慢"排在漏读/读错**之后**：读得不全比读得慢更该先说，两个都占时只报前者。
 *
 * ⚠️ 单独放一个纯函数（而不是写在页面里）有两个理由：
 *    ① 措辞是**产品口径**，值得被单测钉住，不该散在页面逻辑中间；
 *    ② 它是纯的 —— 给定几个数字，输出永远一样，没有任何页面状态混进来。
 */

/** 判断"读得有点慢"的倍数 —— 用户给的口径是 2 倍 */
export const SLOW_RATIO = 2

/**
 * ⚠️ 标准音太短时不判"慢"：短句的比值**噪声太大** ——
 *    标准音 1.2 秒的句子，用户 2.5 秒读完就是 2 倍，可那完全正常。
 *    所以给一个绝对下限，低于它的句子不参与这个判断。
 */
export const MIN_STD_MS_FOR_SLOW = 2000

/**
 * ⚠️⚠️ 这个判断是**粗的**，别拿它当精确指标：`recordMs` 是"按下到松手"的时长，
 *    里面还含**开口前的停顿**和**松手缓冲期（600ms）**—— 插件不给逐词时间戳，
 *    拿不到真正的"开口时刻"，所以两者都去不掉。
 *    ⇒ 阈值只能往宽了取，"有点慢"是个提示，不是测量结论。
 */
export function isSlowReading(recordMs: number, stdMs: number): boolean {
  if (!Number.isFinite(stdMs) || stdMs < MIN_STD_MS_FOR_SLOW) return false
  return recordMs > stdMs * SLOW_RATIO
}

export interface SubmitHintInput {
  /** 漏读（没读到）几个词 */
  missed: number
  /** 读错（没读准）几个词 */
  misread: number
  /** 是不是读得明显偏慢（见 isSlowReading） */
  slow: boolean
}

/**
 * ⭐ 提示的**三个档** —— 它们同时决定**文案的颜色**和**提交按钮能不能按**。
 *
 * | level | 颜色 | 提交按钮 |
 * |---|---|---|
 * | `ok` | 绿 | 可按 |
 * | `warn` | 黄 | **可按**（只是建议，用户自己决定） |
 * | `block` | 红 | **禁用 + 变灰** |
 *
 * ⚠️⚠️ 三档和文案**一起返回**，不让界面自己再判一遍 ——
 *    各判一次会出现"文字是红的、按钮却能按"这种自相矛盾。
 */
export type SubmitHintLevel = 'ok' | 'warn' | 'block'

export interface SubmitHint {
  /** 那一行写什么 */
  text: string
  /** 这一句是什么性质（决定颜色与按钮可用性，见 SubmitHintLevel） */
  level: SubmitHintLevel
}

export function submitHintOf(input: SubmitHintInput): SubmitHint {
  const { missed, misread, slow } = input

  /**
   * ⚠️⚠️ **只有"漏读"拦提交**，所以只有它出 `block`。
   *    "读错"不可靠（ASR 听错占了很大一块，见 AlignmentDetail 的说明）——
   *    拿它拦人等于把"机器听错"变成"用户交不上去"。
   *
   * ⚠️ 拦的那两句说「**请重新朗读**」而不是「建议重试」：
   *    前者是"这一步过不去"，后者是"你可以考虑一下" —— 按钮都灰了，措辞不能还留着商量的余地。
   */
  if (missed > 0 && misread > 0) {
    return { text: '漏读 ' + missed + ' 个单词，读错 ' + misread + ' 个单词，请重新朗读', level: 'block' }
  }
  if (missed > 0) return { text: '漏读 ' + missed + ' 个单词，请重新朗读', level: 'block' }

  if (misread > 0) return { text: '读错 ' + misread + ' 个单词，建议重试', level: 'warn' }
  if (slow) return { text: '读得有点慢，建议重读一遍后提交', level: 'warn' }
  return { text: '朗读完整，点击提交 AI 检测并打分', level: 'ok' }
}
