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
const DASH = String.fromCharCode(45)
const LT = String.fromCharCode(60)
const BANG = String.fromCharCode(33)
const GT = String.fromCharCode(62)

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

/**
 * ⭐ **把注释换成等长空格**，保留行结构 —— 两个 lint 都要在"没有注释的文本"上判断。
 *
 * ⚠️⚠️ 不剥注释的话，**注释里举的反例会被当成真代码**（写 lint 时就被自己骗过一次）。
 * ⚠️ 两种风格都要认：WXSS 用块注释，WXML 用 HTML 注释。
 *    只认块注释的话，HTML 注释里的示例照样会被扫出来 —— 第一次就是这么挂的。
 * ⚠️ 用**等长空格**替换（不是删掉）：这样行号、行内偏移都不动，
 *    报出来的 line 就是源码里的真实行号。
 */
function stripComments(text) {
  const out = []
  let inBlock = false // wxss 那种块注释
  let inHtml = false // wxml 那种 HTML 注释
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    const next2 = text[i + 2]

    if (c === NEWLINE) {
      out.push(c)
      continue
    }
    if (inBlock) {
      if (c === STAR && next === SLASH) {
        inBlock = false
        out.push(' ', ' ')
        i += 1
      } else out.push(' ')
      continue
    }
    if (inHtml) {
      if (c === DASH && next === DASH && next2 === GT) {
        inHtml = false
        out.push(' ', ' ', ' ')
        i += 2
      } else out.push(' ')
      continue
    }
    if (c === SLASH && next === STAR) {
      inBlock = true
      out.push(' ', ' ')
      i += 1
      continue
    }
    if (c === LT && next === BANG && next2 === DASH) {
      inHtml = true
      out.push(' ', ' ', ' ')
      i += 2
      continue
    }
    out.push(c)
  }
  return out.join('')
}

/** ────────────────────────────────────────────────────────────────
 * ⭐ WXML 专有：**<text> 的内容必须紧贴标签**（第二种构建期查不出、上线才看见的坑）。
 *
 * ⚠️⚠️ 小程序的 <text> **会保留换行与空格**，所以这样写：
 *
 *       <text class="...">
 *         文案
 *       </text>
 *
 *    运行时渲染成「空行 + 缩进的文案 + 空行」，整块**白白高一截**。
 *    它极难排查：两边的 margin 明明一样，看着就是"间距不一致"；
 *    而且它不报错、不警告，只是**长得不对**。
 *    2026-10 全仓扫出 4 处（朗读页 1 + 评测弹窗 3），形状完全一样。
 *
 * ⚠️ 已知盲区：属性跨多行的 <text> 查不到（那时标签那行不以 > 结尾）。
 *    有这个盲区也比没有强 —— 它拦的是**手滑写成多行**这个最常见的形状。
 * ⚠️ 与 lintWxSource 分开：那条是逐字符扫结构，这条要按行看上下文。
 */
export function lintMultilineText(text) {
  const problems = []
  const lines = stripComments(text).split(NEWLINE)

  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].replace(/[ \t]+$/, '')
    if (t.indexOf('<text') < 0) continue
    if (!t.endsWith('>')) continue
    if (t.endsWith('/>')) continue // 自闭合的没有内容
    /**
     * ⚠️⚠️ **已经带了 </text> 的行要放行** —— 那是「内容紧贴」的**正确**写法，
     *    而它也以 > 结尾，只判 > 的话会把它误判成"标签独占一行"。
     *    写这条规则时就是这么误报了 pages/tags 里两行正确的 <text>，
     *    构建当场变红 —— 一条会误伤正确代码的检查比没有更糟。
     */
    if (t.indexOf('</text>') >= 0) continue

    const nextLine = (lines[i + 1] || '').trim()
    if (nextLine !== '' && nextLine.indexOf('</text>') !== 0) {
      problems.push({
        line: i + 1,
        what: '<text> 的内容另起了一行 —— <text> 保留换行，会白白多出一个空行（内容要紧贴标签）',
      })
    }
  }
  return problems
}

/**
 * ⭐⭐ **连续两行一模一样（且是"属性样"的行）** —— 几乎一定是编辑残留。
 *
 * ⚠️⚠️ 为什么值得单独一条：这种残留**不会报错**，它会变成页面上的**可见文字**。
 *    真实事故（2026-10）：改卡片那行 <view> 时，一次按行替换只覆盖了标签的**第一行**，
 *    第二行（`wx:if="…">`）留在了原地 —— 于是卡片顶上多出一行 `wx:if="true"` 之类的字样，
 *    而构建、类型检查、类名检查**全部通过**。
 *
 * ⚠️ 判据刻意收得很紧，只报「**连续两行完全相同 + 都含 ="**」：
 *    一开始试的是"连续重复行"，全仓 54 处命中、**全是 `</view>`**（正常嵌套）；
 *    加上"含 =" 之后是 0 处 —— 宁可漏，不要吵。
 */
export function lintDuplicateLine(text) {
  const problems = []
  const lines = stripComments(text).split(NEWLINE)
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1].trim()
    const cur = lines[i].trim()
    if (prev === '' || prev !== cur) continue
    if (prev.indexOf('="') < 0) continue // 闭合标签之类的正常重复，放行
    problems.push({ line: i + 1, what: '与上一行完全相同（编辑残留？它会被当成可见文字渲染出来）' })
  }
  return problems
}
