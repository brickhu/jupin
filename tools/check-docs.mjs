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

  // ---- ② 反引号里的仓库根路径 ----
  for (const m of text.matchAll(/`([^`\n]+)`/g)) {
    const raw = m[1].trim()
    if (!/^(apps|packages|tools|docs|content)\//.test(raw)) continue
    // 去掉可能的尾部说明（如 `apps/x.ts` 的注释）与行号
    const path = raw.replace(/:\d+(-\d+)?$/, '').replace(/[，。、）)]$/, '')
    if (isGlob(path) || ALLOW_GONE.has(path)) continue
    if (!existsSync(join(ROOT, path))) {
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
