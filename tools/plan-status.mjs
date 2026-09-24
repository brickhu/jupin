/**
 * ⭐ plan 状态 —— 「做完了没有」的**唯一权威答案是 git，不是人手写的清单**。
 *
 * 统一开发流程的第 4 步（见 AGENT.md「统一开发流程」）是：
 *   提交时闭环 —— commit 信息带 \`plan <ID>\`，再核对 plan 状态。
 * 这个脚本就是那一步的机械部分：把 plan.md 的 checkbox 与 git 历史对起来。
 *
 * 分工（元规则：一个事实只有一个地方能回答它）：
 *   · 「还没做 / 决定 / 优先级」→ plan.md 的 \`- [ ]\`
 *   · 「做完了没有」          → git（不可伪造、自带时间与 diff 证据）
 *   · 天生没有 commit 的完成项（真机实验 / 外部配置 / 决定）→ plan.md 的「已完成 · 无 commit」段
 *
 * ⭐ 所以 \`- [x]\` 不是手写的：\`--write\` 会按 git 把 \`- [ ]\` 改成 \`- [x]\` 并把整行**搬进**
 *    「## 已完成」段。它是一份**投影**，不是第二份真相。
 *
 * 用法：
 *   pnpm plan:status              打印每个任务的 git 证据 + 闭环检查
 *   pnpm plan:status --strict     额外把「ID 打错 / 勾了却没 commit」当错误（CI 与 pnpm check 用）
 *   pnpm plan:sync                按 git 回写 plan.md 的 checkbox（唯一会改文件的模式）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const strict = argv.includes('--strict')
const write = argv.includes('--write')

const PLAN_PATH = join(ROOT, 'plan.md')
const planText = readFileSync(PLAN_PATH, 'utf8')

/** 任务行：\`- [ ] **B1** 说明…\`（ID 必须在行首的粗体里 —— 避免把正文里的引用当成定义） */
const TASK_RE = /^- \[([ x])\] \*\*([A-C]\d+)\*\* /

/** 抽任务 ID → 它所在的节与当前勾选状态 */
function parseTasks(text) {
  const tasks = new Map()
  let section = '(未知)'
  for (const line of text.split('\n')) {
    const h = /^##+\s+(.+?)\s*$/.exec(line)
    if (h) section = h[1].trim()
    const m = TASK_RE.exec(line)
    if (m) tasks.set(m[2], { section, checked: m[1] === 'x', line })
  }
  return tasks
}

const tasks = parseTasks(planText)

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' })
const log = git(['log', '--format=%H%x09%ad%x09%s', '--date=short'])
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [sha, date, ...rest] = l.split('\t')
    return { sha, date, subject: rest.join('\t') }
  })

/**
 * ⭐⭐ 本地提交 ≠ 推送。两者是**不同性质的动作**：
 *   · \`git commit\` = 记账 —— 幂等、可回滚、不影响远程、不影响部署；
 *   · \`git push\`   = **发布** —— .github/workflows/deploy.yml 在 push 到 dev 时会
 *     真的部署到云托管（只有纯 .md / docs/ / apps/miniprogram/ 的改动不触发）。
 * 所以证据必须分「已推送 / 仅本地」：仅本地的 commit 只在**这台机器**上成立。
 */
let aheadSet = new Set()
let aheadKnown = false
try {
  git(['rev-parse', '--verify', '--quiet', 'origin/dev'])
  aheadSet = new Set(git(['rev-list', 'origin/dev..HEAD']).split('\n').filter(Boolean))
  aheadKnown = true
} catch {
  // 没有 origin/dev（还没 fetch）→ 不猜，标「推送状态未知」
}

/** commit 信息里的 ID：plan B1 / plan-B1 / (plan B1) 都认 */
const idOf = (subject) => {
  const m = /plan[\s-]*([A-C]\d+)\b/i.exec(subject)
  return m ? m[1].toUpperCase() : null
}

const byTask = new Map()
const untagged = []
const unknown = []
for (const c of log) {
  const id = idOf(c.subject)
  if (!id) {
    untagged.push(c)
    continue
  }
  if (!tasks.has(id)) unknown.push({ id, ...c })
  const list = byTask.get(id) ?? []
  list.push(c)
  byTask.set(id, list)
}
const hasCommit = (id) => (byTask.get(id) ?? []).length > 0

/**
 * ⭐ 闭环检查 —— 两个方向都要看：
 *   · 有 commit 但没勾 ⇒ 该跑 \`pnpm plan:sync\`（人忘了回写）
 *   · 勾了但没有 commit ⇒ 要么忘了提交，要么它该写进「已完成 · 无 commit」段
 */
const needCheck = [...tasks].filter(([id, t]) => !t.checked && hasCommit(id)).map(([id]) => id)
const falseCheck = [...tasks].filter(([id, t]) => t.checked && !hasCommit(id)).map(([id]) => id)

// ---------------------------------------------------------------- --write
if (write) {
  const done = new Set([...tasks.keys()].filter(hasCommit))
  const collected = []
  const kept = []
  for (const line of planText.split('\n')) {
    const m = TASK_RE.exec(line)
    if (m && (m[1] === 'x' || done.has(m[2]))) {
      collected.push(m[1] === 'x' ? line : '- [x] ' + line.slice(6))
      continue
    }
    kept.push(line)
  }
  collected.sort((a, b) => TASK_RE.exec(a)[2].localeCompare(TASK_RE.exec(b)[2]))
  const idx = kept.findIndex((l) => /^##\s+已完成/.test(l) && !/无 commit/.test(l))
  if (idx < 0) {
    console.error('❌ plan.md 里找不到「## 已完成」段，无法回写')
    process.exit(1)
  }
  /**
   * ⚠️ 整段**重建**而不是「插一行」—— 插入式写法每次运行都会多留一个空行
   *    （条目被移走一次、又被插回来一次），跑几次文件就烂了。
   *    重建的形态是确定的：标题 / 空行 / banner / 空行 / 条目 / 空行 / 下一个标题。
   */
  const end = kept.findIndex((l, i) => i > idx && /^##\s/.test(l))
  const sectionEnd = end < 0 ? kept.length : end
  let b = idx + 1
  while (b < sectionEnd && kept[b].trim() === '') b++
  const banner = []
  while (b < sectionEnd && /^>/.test(kept[b])) banner.push(kept[b++])
  const body = ['', ...banner, '', ...collected, '']
  kept.splice(idx + 1, sectionEnd - (idx + 1), ...body)
  const next = kept.join('\n')
  if (next === planText) {
    console.log('plan:sync —— 已经是同步的，plan.md 未改动')
    process.exit(0)
  }
  writeFileSync(PLAN_PATH, next, 'utf8')
  console.log('plan:sync —— 已按 git 勾选并归档 ' + collected.length + ' 条：' + collected.map((l) => TASK_RE.exec(l)[2]).join(' '))
  console.log('（plan.md 已改；记得提交它）')
  process.exit(0)
}

// ---------------------------------------------------------------- 报表
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)))

console.log('plan 任务 vs git 证据（提交信息里的 \`plan <ID>\`）')
console.log('')
console.log('  ' + pad('ID', 6) + pad('checkbox', 12) + pad('状态（git）', 22) + pad('在 plan 的哪一节', 28) + '最近一次')
console.log('  ' + '-'.repeat(96))
for (const [id, t] of tasks) {
  const hits = byTask.get(id) ?? []
  const last = hits[0]
  const local = aheadKnown ? hits.filter((c) => aheadSet.has(c.sha)).length : 0
  const pushed = hits.length - local
  let state
  if (hits.length === 0) state = '未提交'
  else if (!aheadKnown) state = '✓ ' + hits.length + ' 个 commit'
  else if (local === 0) state = '✓ 已推送 ' + pushed
  else state = '◐ 推送 ' + pushed + ' / 本地 ' + local
  console.log(
    '  ' + pad(id, 6) + pad(t.checked ? '[x]' : '[ ]', 12) + pad(state, 22) + pad(t.section, 28) +
      (last ? last.date + '  ' + last.sha.slice(0, 8) : '—'),
  )
}

const done = [...tasks.keys()].filter(hasCommit)
console.log('')
console.log('  ' + tasks.size + ' 条任务；有 git 证据的 ' + done.length + ' 条')
if (aheadKnown) {
  const aheadTagged = log.filter((c) => aheadSet.has(c.sha) && idOf(c.subject)).length
  console.log(
    aheadSet.size === 0
      ? '  本地与 origin/dev 同步（记录是共享的）'
      : '  ⚠️ 本地领先 origin/dev ' + aheadSet.size + ' 个 commit（其中带 plan ID 的 ' + aheadTagged + ' 个）——' +
        '这些「已完成」目前**只在这台机器上成立**，换机器/CI 看不到',
  )
}

if (needCheck.length > 0) console.log('\n  🔲 有 commit 但没勾：' + needCheck.join(' ') + ' → 跑 \`pnpm plan:sync\`')
if (falseCheck.length > 0) console.log('\n  ⚠️ 勾了却没有 commit：' + falseCheck.join(' ') + ' —— 要么还没提交，要么它该写进「已完成 · 无 commit」段')

if (unknown.length > 0) {
  console.log('')
  console.log((strict ? '❌' : '⚠️ ') + ' commit 里的 ID 在 plan.md 里不存在（打错字了？）')
  for (const u of unknown) console.log('   · ' + u.id + '  ' + u.date + '  ' + u.subject.slice(0, 70))
}

if (untagged.length > 0) {
  console.log('')
  console.log('  ℹ️ 没挂 ID 的 commit：' + untagged.length + ' 个（多数是新流程之前的历史提交）')
  for (const u of untagged.slice(0, 3)) console.log('   · ' + u.date + '  ' + u.subject.slice(0, 70))
  if (untagged.length > 3) console.log('   · …还有 ' + (untagged.length - 3) + ' 个')
}

console.log('')
console.log('  记法：提交信息写成 \`feat(plan B1): …\`；回写勾选跑 \`pnpm plan:sync\`。')
if (strict && (unknown.length > 0 || falseCheck.length > 0)) process.exit(1)
