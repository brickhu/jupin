#!/usr/bin/env node
/**
 * 把**非哈希的句子 id** 改写成正确的内容哈希（`sha256(正文)` 前 16 位）。
 *
 *   node tools/fix-article-ids.mjs            # 只看：列出要改的行
 *   node tools/fix-article-ids.mjs --apply    # 真改（默认只对 local 生效）
 *   node tools/fix-article-ids.mjs --apply --env dev
 *
 * ⚠️⚠️ 为什么会有这种行：2026-09 之前**服务端写入不校验 id**，
 *    接口信谁给什么 id ⇒ 建出了 `zzdev653288`、`zzdel358045`、`000000000000a568` 这类行。
 *    现在写入已经拦住（`PUT /api/admin/articles/:id` 自己算一遍，对不上 400），
 *    但**历史行还在**：它们的症状是管理台详情页报「这个 id 不合法」。
 *
 * ⚠️ 改写 id 有风险，所以这个脚本刻意做得保守：
 *    · 默认**只看不改**；`--apply` 才写；
 *    · 默认只连 **local**（云环境的库没有外网入口；要改云上请走管理接口或运维窗口）；
 *    · 每行改写前打印 `旧 id → 新 id`，并**先查一遍**新 id 有没有被占用（撞了就跳过、单独报出来）；
 *    · 没有正文（text 为空）的行**跳过** —— 算不出哈希，也不会猜。
 */
import { createRequire } from 'node:module'

import { loadEnv, ROOT } from './env.mjs'

const args = process.argv.slice(2)
const apply = args.includes('--apply')
const envName = args[args.indexOf('--env') + 1] ?? 'local'

if (envName !== 'local') {
  console.error(
    '⚠️ 只会改 local（云环境的库没有外网入口）。要改 ' + envName +
      '：先把它导出，或在运维窗口里用管理接口逐条重写。',
  )
  process.exit(1)
}

loadEnv('local')

const req = createRequire(ROOT + '/apps/server/package.json')
const mysql = req('mysql2/promise')
/**
 * ⚠️ 这里内联一份 sha256，而不是 import `packages/shared/src/article-id.ts`：
 *    那个文件是 **TypeScript**，而这是个 `.mjs` 脚本 —— Node 跑不了 `.ts`（要 tsx 才行，
 *    而这个脚本刻意做成"裸 node 也能跑"的运维工具）。
 *    ⚠️ 内联有写错的风险 ⇒ 与 shared 那份**同源同口径**（trim + sha256 前 16 位），
 *    而 shared 那份由单测与 `node:crypto` 逐字节对拍（见 article-id.test.ts）。
 *    真出分歧时，以 shared 为准。
 */
function articleIdOf(text) {
  const t = text.trim()
  const K = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]
  const bytes = Buffer.from(t, 'utf8')
  const bitLen = bytes.length * 8
  const padded = Buffer.alloc((((bytes.length + 8) >> 6) + 1) << 6)
  bytes.copy(padded)
  padded[bytes.length] = 0x80
  padded.writeUInt32BE(Math.floor(bitLen / 0x100000000), padded.length - 8)
  padded.writeUInt32BE(bitLen >>> 0, padded.length - 4)
  const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0
  const w = new Array(64)
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = padded.readUInt32BE(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }
  return H.map((x) => x.toString(16).padStart(8, '0')).join('').slice(0, 16)
}

const conn = await mysql.createConnection({
  host: '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5544),
  user: process.env.MYSQL_USERNAME ?? 'root',
  password: process.env.MYSQL_PASSWORD ?? 'dev',
  database: process.env.MYSQL_DATABASE ?? 'jushuo',
  charset: 'utf8mb4',
})

/** 所有"看起来就不像哈希"的行 —— 顺带把 text 取出来算新 id */
const [rows] = await conn.execute(
  "SELECT id, text FROM articles WHERE id NOT REGEXP '^[0-9a-f]{16}$' ORDER BY created_at",
)

if (rows.length === 0) {
  console.log('✅ 没有非哈希的 id（全部 16 位十六进制）')
  await conn.end()
  process.exit(0)
}

console.log(`发现 ${rows.length} 条非哈希 id：\n`)
const plan = []
for (const r of rows) {
  const text = (r.text ?? '').trim()
  if (!text) {
    console.log(`  ⏭ 跳过 ${r.id}（没有正文，算不出哈希）`)
    continue
  }
  const next = articleIdOf(text)
  const [hit] = await conn.execute('SELECT id FROM articles WHERE id = ? LIMIT 1', [next])
  if (hit.length > 0) {
    console.log(`  ⚠️ 跳过 ${r.id} → ${next}（新 id 已被占用，需人工判断是否同一条内容）`)
    continue
  }
  console.log(`  ${r.id} → ${next}   ${text.slice(0, 44)}`)
  plan.push({ from: r.id, to: next })
}

if (plan.length === 0) {
  console.log('\n没有可自动改写的行。')
  await conn.end()
  process.exit(0)
}

if (!apply) {
  console.log(`\n（只看模式）要真改加 --apply —— 会改写 ${plan.length} 条。`)
  await conn.end()
  process.exit(0)
}

/**
 * ⚠️ 外键已去掉（迁移 0047），所以改 id **不需要**联动别的表：
 *    指向老 id 的用户数据（成绩/参与/收藏）会变成"关联不上文章" ——
 *    与"句子被删"是同一个状态，列表都走 innerJoin，因此不会显示坏行。
 */
let done = 0
for (const p of plan) {
  await conn.execute('UPDATE articles SET id = ? WHERE id = ?', [p.to, p.from])
  done++
}
console.log(`\n✅ 已改写 ${done} 条。`)
await conn.end()
