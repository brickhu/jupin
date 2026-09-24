/**
 * ⭐ plan 状态 —— 「做完了没有」的**唯一权威答案是 git，不是人手写的清单**。
 *
 * 统一开发流程的第 4 步（见 AGENT.md「统一开发流程」）是：
 *   提交时闭环 —— commit 信息带 `plan <ID>`，并核对 plan 状态。
 * 这个脚本就是那一步的机械部分：把 plan.md 里的任务 ID 与 git 历史对起来。
 *
 * 分工（元规则：一个事实只有一个地方能回答它）：
 *   · 「还没做 / 决定 / 优先级」→ plan.md（只有文件能承载不存在的东西）
 *   · 「做完了没有」          → git（不可伪造、自带时间与 diff 证据）
 *   · 天生没有 commit 的完成项（真机实验 / 外部配置 / 决定）→ plan.md 手写一行并标 [无 commit]
 *
 * 用法：
 *   pnpm plan:status            打印每个任务的 git 证据
 *   pnpm plan:status --strict   额外把「commit 里写了不存在的 ID」当错误（防手滑打字）
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolveRoot()
function resolveRoot() {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

const strict = process.argv.includes('--strict')

const plan = readFileSync(join(ROOT, 'plan.md'), 'utf8')

/**
 * 从 plan.md 抽任务 ID 与它所在的节。
 * 只认**表格行首**的 ID（| B1 | …），不认正文里顺口提到的 —— 避免把引用当成定义。
 */
const tasks = new Map()
let section = '(未知)'
let archived = false
for (const line of plan.split('\n')) {
  const h = /^##+\s+(.+?)\s*$/.exec(line)
  if (h) {
    section = h[1].trim()
    archived = /已完成|归档/.test(section)
  }
  const m = /^\|\s*\*{0,2}([A-C]\d)\*{0,2}\s*\|/.exec(line)
  if (m) {
    tasks.set(m[1], section)
    continue
  }
  /**
   * ⭐ 已完成任务的 **ID 归档**（只列 ID，不写状态与日期 —— 那些从 git 派生）。
   * 为什么必须有：任务做完就从「待办」里删掉，它的 ID 也就消失了 ——
   * 那样提交信息里的 ID 会被本脚本当成「打错字」，`--strict` 会在**每次正常收尾时误报**。
   * 归档只承担两件事：① 校验 ID 拼写；② 保证 ID 不复用。
   */
  if (archived) for (const t of line.matchAll(/([A-C]\d)\b/g)) tasks.set(t[1], section)
}

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
 *   · `git commit` = 记账 —— 幂等、可回滚、不影响远程、不影响部署；
 *   · `git push`   = **发布** —— 本仓库的 .github/workflows/deploy.yml 在 push 到 dev 时
 *     会**真的部署到云托管 dev 环境**（只有纯 .md / docs/ / apps/miniprogram/ 的改动不触发）。
 *
 * 所以「已完成」的证据必须分「已推送 / 仅本地」：
 * 仅本地的 commit 只在**这台机器**上成立，换一台机器就是另一个答案。
 */
let aheadSet = new Set()
let aheadKnown = false
try {
  git(['rev-parse', '--verify', '--quiet', 'origin/dev'])
  aheadSet = new Set(git(['rev-list', 'origin/dev..HEAD']).split('\n').filter(Boolean))
  aheadKnown = true
} catch {
  // 没有 origin/dev（比如还没 fetch）→ 就不猜，标「推送状态未知」
}

/** commit 信息里的 ID：plan B1 / plan-B1 / (plan B1) 都认 */
const idOf = (subject) => {
  const m = /plan[\s-]*([A-C]\d)\b/i.exec(subject)
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

const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 127 ? 2 : 1), 0)))

console.log('plan 任务 vs git 证据（提交信息里的 `plan <ID>`）')
console.log('')
console.log('  ' + pad('ID', 6) + pad('状态（git）', 16) + pad('在 plan 的哪一节', 30) + '最近一次')
console.log('  ' + '-'.repeat(84))
for (const [id, sec] of tasks) {
  const hits = byTask.get(id) ?? []
  const last = hits[0]
  const local = aheadKnown ? hits.filter((c) => aheadSet.has(c.sha)).length : 0
  const pushed = hits.length - local
  let state
  if (hits.length === 0) state = '未提交'
  else if (!aheadKnown) state = '✓ ' + hits.length + ' 个 commit'
  else if (local === 0) state = '✓ 已推送 ' + pushed
  else state = '◐ 推送 ' + pushed + ' / 本地 ' + local
  console.log('  ' + pad(id, 6) + pad(state, 22) + pad(sec, 28) + (last ? last.date + '  ' + last.sha.slice(0, 8) : '—'))
}

const done = [...tasks.keys()].filter((id) => (byTask.get(id) ?? []).length > 0)
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

if (unknown.length > 0) {
  console.log('')
  console.log((strict ? '❌' : '⚠️ ') + ' commit 里出现的 ID 在 plan.md 里不存在（打错字了？）：')
  for (const u of unknown) console.log('   · ' + u.id + '  ' + u.date + '  ' + u.subject.slice(0, 70))
  if (strict) process.exit(1)
}

if (untagged.length > 0) {
  const shown = untagged.slice(0, 5)
  console.log('')
  console.log('  ℹ️ 没挂 ID 的 commit：' + untagged.length + ' 个（多数是新流程之前的历史提交）')
  for (const u of shown) console.log('   · ' + u.date + '  ' + u.subject.slice(0, 70))
  if (untagged.length > 5) console.log('   · …还有 ' + (untagged.length - 5) + ' 个')
}

console.log('')
console.log('  记法：提交信息写成 `feat(plan B1): …`，这个脚本就能把它算成 B1 的证据。')
