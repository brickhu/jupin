import { backfillMissingContent, seedArticles } from './seed-articles'

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

  /**
   * ⭐ **同一个入口里顺手补正文**（2026-09，见 backfillMissingContent 的说明）。
   *
   * ⚠️⚠️ 为什么放在这里而不是只放 db/index.ts：**有两条初始化路径** ——
   *    命令行（`pnpm seed`，本地容器 entrypoint 走这条）与
   *    服务启动时的 SEED_ON_START（云端走那条）。放在 `seedArticles` 的**调用方**这里，
   *    两条路都覆盖到；只挂在启动那条上，本地就永远不补（实测就是这么漏的）。
   */
  const b = await backfillMissingContent()
  console.log(`✅ 正文回填：补上 ${b.filled} 条 · 仍为空 ${b.stillEmpty} 条`)
  process.exit(0)
}

void main()
