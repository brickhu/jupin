/**
 * ⭐ 多任务并行 —— **一个任务一个 worktree**（独立目录 + 独立分支）。
 *
 * 为什么需要它：并行任务最容易出的不是「合并冲突」，而是**互相覆盖**——
 * 两个任务在同一个目录里改文件，后保存的赢，而且**当场看不出来**（没有报错、没有冲突标记）。
 * worktree 把「编辑期冲突」推迟成「合并期冲突」，后者 git 会明确告诉你。
 *
 * ⚠️ 这个仓库有**四个**冲突面，worktree 只解决第一个：
 *   ① 工作区（文件互相覆盖）          → 本工具
 *   ② 迁移（序号 + journal + snapshot）→ **串行**：同一时刻只允许一条在飞，后合并的重跑 db:generate
 *   ③ 单一真相文件（shared 公共类型 / plan.md）→ 改公共面的任务**不与任何任务并行**
 *   ④ 运行时资源（MySQL :5544 / API :8899 / 容器名）→ 只有一条任务线跑 Docker，其余只跑 pnpm check
 *
 * 用法：
 *   pnpm task:start B9      开任务工作区（.worktrees/wt-B9，分支 feature/B9，基线 dev）
 *   pnpm task:list          列出所有工作区：分支 + 脏文件数
 *   pnpm task:remove B9     删掉工作区（分支保留；有未提交改动会拒绝）
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const run = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const MAIN = run(['rev-parse', '--show-toplevel'])
const REPO = basename(MAIN)
const [cmd, id] = process.argv.slice(2)

/** 任务 ID 就是 plan.md 里的 ID —— 分支名与目录名都由它派生，一眼能对上是哪条任务 */
const ID_RE = /^[A-C]\d+$/
const branchOf = (i) => 'feature/' + i
/**
 * ⚠️ 工作区**必须放在仓库内部**（`.worktrees/`，已 gitignore）：
 *    放同级目录（`../jushuo-wt-B9`）在受限沙箱里会被拒（sandbox: workspace-write），
 *    而且多出一个 git 管不到的目录更容易被误删。git 支持仓库内 worktree。
 */
const pathOf = (i) => join(MAIN, '.worktrees', 'wt-' + i)

function list() {
  const out = run(['worktree', 'list', '--porcelain'], MAIN).split('\n\n').filter(Boolean)
  console.log('工作区：')
  for (const block of out) {
    const lines = block.split('\n')
    const path = lines.find((l) => l.startsWith('worktree '))?.slice('worktree '.length)
    const branch = lines.find((l) => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? '(detached)'
    const dirty = path && existsSync(path) ? run(['status', '--porcelain'], path).split('\n').filter(Boolean).length : 0
    console.log('  ' + (path === MAIN ? '★ ' : '  ') + path)
    console.log('     分支 ' + branch + '   脏文件 ' + dirty)
  }
}

function start(i) {
  if (!ID_RE.test(i)) throw new Error('任务 ID 要形如 B9（与 plan.md 的 ID 一致）')
  const path = pathOf(i)
  const branch = branchOf(i)
  if (existsSync(path)) throw new Error('工作区已存在：' + path)
  const hasBranch = run(['branch', '--list', branch], MAIN) !== ''
  run(hasBranch ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, 'dev'], MAIN)
  console.log('✅ 任务工作区已建：' + path)
  console.log('   分支：' + branch + (hasBranch ? '（已存在，接上）' : '（从 dev 新建）'))
  console.log('')
  console.log('   开工：cd ' + path)
  console.log('   ⚠️ 端口/容器只有一个：不要在这里再跑 pnpm dev:docker ——')
  console.log('      需要真库时用另一套端口，或让**一条**任务线独占 Docker。')
  console.log('   ⚠️ 不要在任务分支跑 plan:sync（它整段重建 plan.md，合并必冲突）——')
  console.log('      合并进 dev 之后再跑一次。')
  console.log('   ⚠️ 改 shared 公共类型 / 迁移的任务**不要并行**（见 AGENT.md「多任务并行」）。')
  console.log('   收工：pnpm task:remove ' + i + '（分支还在，合进 dev 后再删）')
}

function remove(i) {
  if (!ID_RE.test(i)) throw new Error('任务 ID 要形如 B9')
  const path = pathOf(i)
  if (!existsSync(path)) throw new Error('没有这个工作区：' + path)
  const dirty = run(['status', '--porcelain'], path).split('\n').filter(Boolean).length
  if (dirty > 0 && !process.argv.includes('--force')) {
    throw new Error('工作区还有 ' + dirty + ' 个未提交改动 —— 先提交，或加 --force 丢弃')
  }
  run(['worktree', 'remove', path, ...(process.argv.includes('--force') ? ['--force'] : [])], MAIN)
  console.log('✅ 已删除工作区：' + path)
  console.log('   分支 ' + branchOf(i) + ' 仍在（合并进 dev 后用 git branch -d 删）')
}

try {
  if (cmd === 'start') start(id)
  else if (cmd === 'list' || cmd === undefined) list()
  else if (cmd === 'remove') remove(id)
  else {
    console.log('用法：pnpm task:start <ID> | pnpm task:list | pnpm task:remove <ID>')
    process.exit(1)
  }
} catch (err) {
  console.error('❌ ' + err.message)
  process.exit(1)
}
