/**
 * 内容生产流水线 CLI。
 *
 * ⭐ 设计要点：**可重复、可断点续跑**。
 *    内容会持续生产，改第 ⑦ 步不该重跑 ①–⑥。
 *    每一步的产物落盘到 data/drafts/{passageId}/，重跑时若已存在则跳过（除非 --force）。
 *
 * 用法：
 *   pnpm pipeline run --from 01 --to 09
 *   pnpm pipeline run --only 04 --force
 */
import { loadEnv } from '../../env.mjs'
import { listSteps } from './steps/index'

/**
 * ⚠️ 必须在这里加载 —— 内容生产是**本机动作**，FISH_* 凭据都在 .env.local。
 *    以前没这一步，直接 `pnpm pipeline run` 会报「缺少 FISH_API_KEY」，
 *    只有手动 export 到 shell 里才跑得起来（那不是一个能交给别人的入口）。
 */
loadEnv('local')

interface Args {
  command: 'run' | 'list'
  from?: string
  to?: string
  only?: string
  force: boolean
}

function parseArgs(argv: string[]): Args {
  const [command = 'list'] = argv
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  return {
    command: command as Args['command'],
    from: get('--from'),
    to: get('--to'),
    only: get('--only'),
    force: argv.includes('--force'),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const steps = listSteps()

  if (args.command === 'list') {
    console.log('可用步骤：')
    for (const s of steps) console.log(`  ${s.id}  ${s.title}`)
    return
  }

  const selected = args.only
    ? steps.filter((s) => s.id === args.only)
    : steps.filter((s) => (!args.from || s.id >= args.from!) && (!args.to || s.id <= args.to!))

  if (selected.length === 0) {
    console.error('没有匹配的步骤')
    process.exit(1)
  }

  console.log(`\n将执行 ${selected.length} 个步骤：${selected.map((s) => s.id).join(', ')}\n`)

  for (const s of selected) {
    console.log(`▶ ${s.id}  ${s.title}`)
    try {
      await s.run({ force: args.force })
      console.log(`  ✅ 完成\n`)
    } catch (err) {
      console.error(`  ❌ 失败：${(err as Error).message}\n`)
      process.exit(1)
    }
  }

  console.log('全部完成。')
}

void main()
