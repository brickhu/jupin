#!/usr/bin/env node
/**
 * ⭐ 一次性修复：把历史提交的 `seq`（"这一句上的第几次"）**重编号成连续的 1..N**。
 *
 * ⚠️ 为什么需要：序号的老规则是"**受理时**分配"，而"没触达"（音频读不出来）的那一行
 *    后来会被清掉 ⇒ 它占过的号变成**永久空洞**，界面上就是用户报的那个
 *    「第 4 次跳到第 6 次」。新规则改成"**有结论时**才分配"（根治），
 *    但**已经产生的空洞不会自己消失** —— 这个脚本把它们补平。
 *
 * ⚠️ 唯一索引 `(user_id, article_id, seq)` 在重编号期间会被违反（新号与旧号撞），
 *    所以走**两阶段**：先把这一组的号全部取负（负数不可能与正数撞），再写最终值。
 *
 * 用法：
 *   node tools/fix-submission-seq.mjs            # 只报告（默认，不改一行）
 *   node tools/fix-submission-seq.mjs --apply    # 真的改
 *   node tools/fix-submission-seq.mjs --apply --prod
 */
import { createRequire } from 'node:module'

import { loadEnv, ROOT } from './env.mjs'

const APPLY = process.argv.includes('--apply')
const mode = process.argv.includes('--prod') ? 'prod' : 'local'

loadEnv(mode)
const req = createRequire(ROOT + '/apps/server/package.json')
const mysql = req('mysql2/promise')

const url = new URL(process.env.DATABASE_URL)
const conn = await mysql.createConnection({
  host: url.hostname,
  port: Number(url.port || 3306),
  user: decodeURIComponent(url.username),
  password: decodeURIComponent(url.password),
  database: url.pathname.replace(/^\//, ''),
  charset: 'utf8mb4',
})

console.log(`[fix-submission-seq] 目标 = ${mode}（${url.hostname}:${url.port || 3306}）${APPLY ? '' : ' —— 只报告，不改（加 --apply 才动手）'}`)

const [rows] = await conn.execute(
  'SELECT id, user_id, article_id, seq FROM submissions WHERE seq IS NOT NULL ORDER BY user_id, article_id, seq, created_at',
)
const groups = new Map()
for (const r of rows) {
  const k = r.user_id + '\u0000' + r.article_id
  if (!groups.has(k)) groups.set(k, [])
  groups.get(k).push(r)
}

let touched = 0
for (const [k, list] of groups) {
  const [userId, articleId] = k.split('\u0000')
  const want = list.map((_, i) => i + 1)
  const have = list.map((r) => r.seq)
  if (JSON.stringify(have) === JSON.stringify(want)) continue
  touched++
  console.log(`  ${APPLY ? '修' : '需修'} user=${userId} article=${articleId}  [${have.join(',')}] → [${want.join(',')}]`)
  if (!APPLY) continue
  // 阶段一：全部取负（避开唯一索引）
  await conn.execute(
    'UPDATE submissions SET seq = -seq WHERE user_id = ? AND article_id = ? AND seq IS NOT NULL',
    [userId, articleId],
  )
  // 阶段二：写最终值（逐行；此时组内全是负数，不会与 1..N 撞）
  for (let i = 0; i < list.length; i++) {
    await conn.execute('UPDATE submissions SET seq = ? WHERE id = ?', [i + 1, list[i].id])
  }
}

console.log(touched === 0 ? '  ✅ 所有 (用户,句子) 的序号都已连续，不用改' : `  ${APPLY ? '已修' : '有'} ${touched} 组`)
await conn.end()
