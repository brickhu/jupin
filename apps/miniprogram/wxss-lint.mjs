/**
 * ⭐ WXSS / WXML 源码的静态检查（构建期 + 单测共用一份）。
 *
 * ⚠️⚠️ 为什么需要它：tsc 和 esbuild 都不碰 wxss，
 *    所以这类错误在构建期完全看不出来，只有微信开发者工具才会炸 ——
 *    而那时人已经在看页面了。两次真实事故：
 *
 *   ① 注释里写了个反引号（原文是说明 UnoCSS 的 bg-warn/10 这种写法）
 *      报错：[ WXSS 文件编译错误] energy.wxss(17:4): unexpected 反引号
 *   ② 一次编辑把注释块的开头吃掉了，留下一行孤立的星号
 *      同样是 wxss 编译错误，而构建依旧打印「完成」
 *
 * ⇒ 这里做三件不需要理解 CSS 语义就能查的事：
 *    ① 反引号（wxss 编译器不认它，哪怕在注释里）
 *    ② 注释配平（孤立的注释结尾就是 ② 那种事故的指纹）
 *    ③ 花括号配平（截断 / 漏改的另一种指纹）
 *
 * ⚠️ 刻意不去解析 CSS：postcss 对这两种写法都是**静默通过**的（实测过），
 *    真正能识别的只有微信的编译器。所以只查结构，不查语义。
 *
 * ⚠️⚠️ 本文件里刻意不出现三种字面量：反引号、反斜杠转义、以及注释结尾符号。
 *    理由是实测踩出来的：字面反引号会让 vite 的 import 分析直接报错，
 *    而把注释结尾写进注释里会把注释提前闭合 ——
 *    「检查注释配平的模块」自己先被这两个问题干掉，那就太讽刺了。
 */

const BACKTICK = String.fromCharCode(96)
const NEWLINE = String.fromCharCode(10)
const STAR = String.fromCharCode(42)
const SLASH = String.fromCharCode(47)

export function lintWxSource(text) {
  const problems = []
  let inComment = false
  let depth = 0
  let line = 1
  let commentStartLine = 0

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === NEWLINE) {
      line += 1
      continue
    }
    if (c === BACKTICK) problems.push({ line, what: '反引号（wxss 编译器不认这个字符）' })

    if (inComment) {
      if (c === STAR && next === SLASH) {
        inComment = false
        i += 1
      }
      continue
    }
    if (c === SLASH && next === STAR) {
      inComment = true
      commentStartLine = line
      i += 1
      continue
    }
    if (c === STAR && next === SLASH) {
      problems.push({ line, what: '孤立的注释结尾（注释块的开头大概被吃掉了）' })
      i += 1
      continue
    }
    if (c === '{') depth += 1
    if (c === '}') {
      depth -= 1
      if (depth < 0) {
        problems.push({ line, what: '多余的右花括号' })
        depth = 0
      }
    }
  }

  if (inComment) problems.push({ line: commentStartLine, what: '注释没有闭合（缺结尾）' })
  if (depth > 0) problems.push({ line, what: '有 ' + depth + ' 个左花括号没有闭合' })
  return problems
}
