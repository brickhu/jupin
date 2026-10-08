/**
 * ⭐ 文档的机械检查 —— 把「文档腐烂」变成一条会红的命令。
 *
 * 背景：项目定了四条文档真相原则（见 AGENT.md 的「文档与真相来源」）：
 *   代码及注释 = 真相 · prd.md = 业务唯一来源 · plan.md = 任务唯一来源 ·
 *   AGENT.md = 工程索引。元规则是「重复即错误」。
 *
 * 原则靠自觉是保不住的 —— 已经出过一次：AGENT.md 与 prd.md 都还写着「等级徽章」，
 * 而代码里它早已整体废除。这个脚本只做三件**便宜且不会误报**的事：
 *
 *   ① 文档里的 markdown 链接（相对路径）必须存在；
 *   ② 文档里以仓库根目录开头（apps/ packages/ tools/ docs/ content/）的反引号路径必须存在；
 *   ③ spec.md 里不许出现 DDL（表结构是代码的事，抄一份就是第二份真相）。
 *
 * ⚠️ 刻意**不做**的事：不检查 basename（`schema.ts:54` 这种指向哪个 schema.ts 有歧义）、
 *    不检查 docs/archive（那是历史，本来就该过时）。宁可漏，不可误报 ——
 *    一条会误报的检查很快就会被无视，那就等于没有。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 检查哪些文件（docs/archive 明确排除：历史就该过时） */
const DOCS = [
  'AGENT.md',
  'prd.md',
  'spec.md',
  'plan.md',
  'docs/README.md',
  'docs/design/growth-and-energy.md',
  'docs/design/reward-system.md',
  'docs/design/payment-and-purchase.md',
]

/**
 * 例外：**故意提到「已经删掉的东西」**的地方（记历史是文档的职责）。
 * 每加一条都要写清为什么 —— 这个表不该长，长了说明文档在拿它当垃圾桶。
 */
const ALLOW_GONE = new Map([
  ['tools/jushuo-admin.ts', 'plan.md 的「已完成」里记的是「旧脚本已删除」这件事本身'],
])

/** 通配符路径无法逐个校验，跳过（如 content/articles/*.json） */
const isGlob = (p) => p.includes('*')

const problems = []

for (const rel of DOCS) {
  const abs = join(ROOT, rel)
  if (!existsSync(abs)) {
    problems.push(rel + '：文件不存在')
    continue
  }
  const text = readFileSync(abs, 'utf8')
  const baseDir = dirname(abs)

  // ---- ① markdown 链接 ----
  for (const m of text.matchAll(/\]\(([^)\s]+)\)/g)) {
    const target = m[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    const path = target.split('#')[0]
    if (!path) continue
    if (!existsSync(resolve(baseDir, path))) {
      problems.push(rel + '：链接指向的文件不存在 → ' + target)
    }
  }

  /**
   * ⭐⭐ **被 .gitignore 排除的路径不算"不存在"** ✗（2026-10-08 修）
   *
   * ⚠️ 起因：CI 的「文档检查」挂了 6 条 ✗ —— 全是 `content/` 与 `apps/server/dist` ✓
   *    而**本机是过的** ✓ —— 因为这两样在我机器上都有：
   *      · `content/`   ⇒ 内容产物（句子 json / 标准音 / seed 素材 ✓ 刻意不进 git ✓）
   *      · `apps/server/dist` ⇒ 构建产物（跑过 build 才有 ✓）
   *    ⇒ ⭐ **"不在仓库里"和"不存在"是两件事** ✗ 而原来的裸 `existsSync` 把两者混了 ✓
   *
   * ⭐ 用 `git check-ignore` 精确判断（不是"没被跟踪就放过"✗）：
   *    没被跟踪但**也没被忽略**的路径（比如写错的 `apps/server/typo.ts`）
   *    仍然会被抓出来 ✓ —— 那才是这个检查真正的价值 ✓
   */
  function isGitIgnored(p) {
    /**
     * ⚠️⚠️ **必须同时试"带尾斜杠"的形式** ✗ —— 踩过：
     *
     * `.gitignore` 里的 `dist/` **带尾斜杠 = 只匹配目录** ✓
     * ⚠️ 而目录**不存在**时，git 无从判断 `apps/server/dist` 是不是目录 ⇒ **匹配失败** ✗
     *    ⇒ ⭐ 于是 CI（干净 checkout，`dist/` 本来就不存在）仍然报"路径不存在" ✗✗
     *    ⚠️ 而我本机测试时目录还在 ⇒ 匹配成功 ⇒ **假绿** ✓（同一个坑踩了两次 ✓）
     *
     * ⭐ 加一个 `p + '/'` 的形式：尾斜杠强制按目录解释 ✓ 不依赖文件系统 ✓
     */
    for (const cand of [p, p + '/']) {
      try {
        execFileSync('git', ['check-ignore', '-q', cand], { cwd: ROOT, stdio: 'ignore' })
        return true // exit 0 ⇒ 被忽略 ✓
      } catch {
        /* 换个形式再试 ✓ */
      }
    }
    return false // 两种形式都不匹配 ⇒ 没被忽略 ✓
  }

  // ---- ② 反引号里的仓库根路径 ----
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim()
    if (!/^(apps|packages|tools|docs|content)\//.test(raw)) continue
    // 去掉可能的尾部说明（如 `apps/x.ts` 的注释）与行号
    const path = raw.replace(/:\d+(-\d+)?$/, '').replace(/[，。、）)]$/, '')
    if (isGlob(path) || ALLOW_GONE.has(path)) continue
    // ⚠️ 被 gitignore 的（内容产物 / 构建产物）"不在仓库里"是设计如此 ✓ 不算问题 ✓
    if (!existsSync(join(ROOT, path)) && !isGitIgnored(path)) {
      problems.push(rel + '：引用的路径不存在 → ' + raw)
    }
  }

  // ---- ③ spec.md 不许出现 DDL ----
  if (rel === 'spec.md') {
    for (const m of text.matchAll(/^.*\b(CREATE TABLE|ALTER TABLE|DROP COLUMN|varchar\()/gm)) {
      problems.push('spec.md：出现了 DDL（表结构属于 schema.ts）→ ' + m[0].trim().slice(0, 80))
    }
  }
}

if (problems.length > 0) {
  console.error('❌ 文档检查未通过（' + problems.length + ' 条）：')
  for (const p of problems) console.error('  · ' + p)
  console.error('')
  console.error('修法：把过时的引用改成真实路径，或指向代码 / plan.md。')
  process.exit(1)
}

console.log('✅ 文档检查通过（' + DOCS.length + ' 份：链接、仓库路径、spec 无 DDL）')
