import { seedArticles } from './seed-articles'

/**
 * 命令行灌种子：`pnpm seed`（本地）/ `pnpm seed:cloud`（云上，需临时开数据库外网地址）。
 *
 * ⚠️ 服务启动时也可能自动灌 —— 见 db/index.ts 的 SEED_ON_START。
 *    云上部署时开着它，就不用为了灌一次种子去控制台开「外网地址」。
 */
async function main(): Promise<void> {
  console.log('写入种子文章…')
  const n = await seedArticles()
  console.log(`✅ 完成，共 ${n} 篇`)
  process.exit(0)
}

void main()
