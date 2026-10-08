/**
 * ⭐ 把 **KWS 模型**（端侧逐词标注用）抓到 `content/kws/`。
 *
 * ## ⚠️⚠️ 为什么是"抓"而不是"提交进仓库"
 *
 * 模型 4.4MB ✗ —— 而且它是**第三方产物**（sherpa-onnx 的预训练模型 ✓ Apache-2.0 ✓）
 * ⇒ 放进 git 既臃肿、又和"模型可以换"这件事冲突 ✓
 * ⇒ **构建时拉一次** ✓（Dockerfile 里也会调它 ✓）
 *
 * ## 为什么落在 content/kws/
 *
 * ⭐ 因为 `services/content.ts` 的 `readStaticFile` **已经**把"内容根在哪、怎么防越界"
 *    解决完了 ✓ —— 复用它是**本仓库明确写过的一条教训**（不要两处各自解析路径 ✗）
 * ⇒ 路由只要 `readStaticFile('kws/xxx.onnx')` ✓
 *
 * ## 用法
 *
 *     node apps/server/scripts/fetch-kws-model.mjs          # 缺什么下什么
 *     node apps/server/scripts/fetch-kws-model.mjs --force  # 重下
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** ⚠️ 从脚本位置往上推仓库根，不要依赖 cwd（Docker 与本地 dev 的 cwd 不同 ✗） */
const REPO = resolve(HERE, '../../..')
const OUT_DIR = resolve(REPO, 'content/kws')

const RELEASE = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20'
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/${RELEASE}.tar.bz2`

/**
 * ⚠️ 现在只要 **encoder**（探针只验"能不能加载" ✓）
 *    真做功能时要补齐 decoder / joiner / tokens / en.phone ✓（约 8.5MB）
 */
const WANTED = ['encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx']

const force = process.argv.includes('--force')
mkdirSync(OUT_DIR, { recursive: true })

const missing = WANTED.filter((f) => force || !existsSync(resolve(OUT_DIR, f)))
if (missing.length === 0) {
  console.log('[kws] 模型已在 content/kws/ ✓（要重下加 --force）')
  process.exit(0)
}

console.log('[kws] 下载模型（约 31MB 的 tar，只取其中 ' + missing.length + ' 个文件）…')
const tmp = resolve(OUT_DIR, '.download')
rmSync(tmp, { recursive: true, force: true })
mkdirSync(tmp, { recursive: true })

const tar = resolve(tmp, 'm.tar.bz2')
execFileSync('curl', ['-sSL', '-o', tar, URL], { stdio: 'inherit' })
// ⚠️ alpine 上 `tar -xj` 需要 bzip2 包（Dockerfile 里已装 ✓）
execFileSync('tar', ['-xjf', tar, '-C', tmp], { stdio: 'inherit' })

for (const f of missing) {
  const src = resolve(tmp, RELEASE, f)
  if (!existsSync(src)) {
    console.error('[kws] ✗ 压缩包里没有 ' + f)
    process.exit(1)
  }
  copyFileSync(src, resolve(OUT_DIR, f))
  console.log('[kws] ✓ ' + f)
}
rmSync(tmp, { recursive: true, force: true })
console.log('[kws] 完成 ✓ → ' + OUT_DIR)
