/**
 * wxss-lint.mjs 的类型声明。
 *
 * ⚠️ 为什么需要单独一个 .d.mts：lint 是给 build.mjs（纯 node）用的 .mjs，
 *    而单测是 .ts —— 没有声明文件的话 tsc 报 TS7016（隐式 any 模块），
 *    于是「检查配置的模块」自己过不了类型检查。
 */
export interface WxProblem {
  /** 1 起的行号 */
  line: number
  /** 人话描述（反引号 / 孤立的注释结尾 / 花括号不配平…） */
  what: string
}

export function lintWxSource(text: string): WxProblem[]
