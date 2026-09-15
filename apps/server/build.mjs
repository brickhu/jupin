/**
 * 服务端构建：esbuild 打成**单文件**。
 *
 * ⭐ 为什么不用 tsc 直接产出：
 *   tsconfig.base.json 是 moduleResolution: 'bundler'，产出的相对导入**不带 .js 扩展名**，
 *   Node 的 ESM 解析器直接跑不起来（ERR_MODULE_NOT_FOUND）。
 *   再加上 @jushuo/shared 的 main 指向 ./src/index.ts（TS 源码），
 *   Node 也无法从 node_modules 里加载 .ts。
 *   → 整个仓库打包成一个 .mjs，两者一并解决。
 *
 * ⭐ 顺带的好处：运行镜像不需要 node_modules、不需要 pnpm，
 *   体积从几百 MB 降到几十 MB，云托管冷启动（缩容到 0 后首次请求）更快。
 */
import { rm } from 'node:fs/promises'
import { build } from 'esbuild'

await rm('dist', { recursive: true, force: true })

const result = await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.mjs',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  sourcemap: true,
  minify: false,
  metafile: true,
  // ⚠️ 不外部化任何 npm 包：连 node_modules 都不需要进镜像。
  //    CJS 依赖内部的 require() 靠 createRequire 兜住。
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      'const require = __createRequire(import.meta.url);',
    ].join('\n'),
  },
  logLevel: 'info',
})

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0
console.log(`✅ dist/index.mjs  ${(bytes / 1024 / 1024).toFixed(2)} MB`)
