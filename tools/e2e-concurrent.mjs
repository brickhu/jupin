#!/usr/bin/env node
/**
 * ⭐ 并发撞号测试：同一个人对同一句**同时**提交 N 次。
 *
 * ⚠️ 为什么单独一个脚本：它盯的是两个**实测踩过的**失败形状，
 *    而正常的端到端（tools/e2e-submission.mjs）是串行的，测不到它们：
 *
 *   ① **服务端不许崩**：序号是 `MAX(seq)+1`，并发下会撞
 *      `uniqueIndex(user, article, seq)`。撞了若让异常逃逸，**整个 Node 进程会被带走**
 *      （实测：容器重启、所有正在打分的提交一起丢）。
 *   ② **序号不许有空洞**：必须是恰好 1..N（用户报的"第 4 次跳到第 6 次"）。
 *
 *   node tools/e2e-concurrent.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
const BASE = 'http://127.0.0.1:8899'
const OPENID = 'z_conc_' + Date.now()
const AUDIO = 'content/audio/06ef2b193b83b3d7.mp3'
const req = createRequire('/Users/free/Projects/jushuo/apps/server/package.json')
const mysql = req('mysql2/promise')
const conn = await mysql.createConnection({ host: '127.0.0.1', port: 5544, user: 'root', password: 'dev', database: 'jushuo', charset: 'utf8mb4' })

const H = { 'x-wx-source': 'cloudrun', 'x-wx-openid': OPENID }
await conn.execute('INSERT INTO users (openid, energy, energy_date) VALUES (?, 40, ?)', [OPENID, new Date().toISOString().slice(0, 10)])
const [[u]] = await conn.execute('SELECT id FROM users WHERE openid=?', [OPENID])
const uid = u.id
const [[a]] = await conn.execute('SELECT id FROM articles WHERE is_active=1 LIMIT 1')
const articleId = a.id
const date = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

const N = 3
console.log('  并发提交 ' + N + ' 次（user=' + uid + ' article=' + articleId + '）')
const attemptIds = []
for (let i = 0; i < N; i++) {
  const attemptId = req('node:crypto').randomBytes(16).toString('hex')
  attemptIds.push(attemptId)
  const audioKey = `audio/${articleId}/${uid}/${attemptId}.mp3`
  const form = new FormData()
  form.append('file', new Blob([readFileSync('/Users/free/Projects/jushuo/' + AUDIO)], { type: 'audio/mpeg' }), 'a.mp3')
  form.append('articleId', articleId)
  form.append('audioKey', audioKey)
  const up = await (await fetch(BASE + '/api/user/uploads', { method: 'POST', headers: H, body: form })).json()
  if (!up.ok) { console.log('  上传失败:', JSON.stringify(up)); process.exit(1) }
}

// 同时发出去（不 await 任何一个）
const subs = await Promise.all(attemptIds.map((attemptId) =>
  fetch(BASE + '/api/user/submissions', {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/json' },
    body: JSON.stringify({ articleId, audioKey: `audio/${articleId}/${uid}/${attemptId}.mp3`, attemptId, scheduleDate: date }),
  }).then((r) => r.json()).catch((e) => ({ error: String(e) })),
))
console.log('  受理响应：', subs.map((s) => s?.data?.status ?? s?.error ?? '?').join(' / '))

// 等服务端把这 N 条跑完
for (let i = 0; i < 40; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const [[c]] = await conn.execute("SELECT COUNT(*) n FROM submissions WHERE user_id=? AND article_id=? AND status<>'scoring'", [uid, articleId])
  if (c.n >= N) break
}

// ① 服务端还活着吗
let alive = false
try { alive = (await fetch(BASE + '/api/user/today', { headers: H })).ok } catch { alive = false }
console.log('  ① 服务端仍然存活：' + (alive ? '✅' : '❌ 崩了'))

// ② 序号连续吗
/**
 * ⚠️ "第几次"是**接口现算**的（库里的 `seq` 列已删）⇒ 只能问接口。
 *    这也正是要验的：并发下它仍然必须是 1..N（不是错的、也不是重复的）。
 */
const rec = await (await fetch(BASE + '/api/user/article-records?article=' + articleId, { headers: H })).json()
const rows = (rec?.data?.items ?? []).map((i) => ({ seq: i.seq, status: i.status })).sort((a, b) => a.seq - b.seq)
const seqs = rows.map((r) => r.seq)
const want = seqs.map((_, i) => i + 1)
const contig = JSON.stringify(seqs) === JSON.stringify(want)
console.log('  ② 序号连续：' + (contig ? '✅' : '❌') + '  实际=[' + seqs.join(',') + '] 期望=[' + want.join(',') + ']')
console.log('     各行状态：' + rows.map((r) => r.seq + ':' + r.status).join(' '))

// 清理
// ⚠️ 顺序要紧：participations 有外键指向 submissions.best_submission_id，
//    必须先删参与行，再删提交行（反了就是 ER_ROW_IS_REFERENCED_2）。
/**
 * ⚠️ 清理必须**按外键顺序**、且覆盖**所有**指向 users 的表（实测漏一张就是 1451）：
 *    出分那一把会发奖励（`reward_grants`），它指着 users ⇒ 先删它才能删用户。
 * ⚠️ 这里刻意**逐条写出来**，不做成数组循环 —— 数据所有权守门（domain-write-guard.test.ts）
 *    要**静态解析**出"哪个文件写了哪张表"；表名藏进数组它就扫不到，
 *    对应的豁免会变成"死条目"而报警（我试过，正是这么红的）。
 */
await conn.execute(`DELETE FROM participations WHERE user_id=?`, [uid]).catch((e) => console.warn('  清理跳过 participations：' + e.code))
await conn.execute(`DELETE FROM reward_grants WHERE user_id=?`, [uid]).catch((e) => console.warn('  清理跳过 reward_grants：' + e.code))
await conn.execute(`DELETE FROM energy_ledger WHERE user_id=?`, [uid]).catch((e) => console.warn('  清理跳过 energy_ledger：' + e.code))
await conn.execute(`DELETE FROM submissions WHERE user_id=?`, [uid]).catch((e) => console.warn('  清理跳过 submissions：' + e.code))
await conn.execute(`DELETE FROM users WHERE id=?`, [uid]).catch((e) => console.warn('  清理跳过 users：' + e.code))
await conn.end()
console.log(alive && contig ? '  ✅ 并发测试通过' : '  ❌ 并发测试失败')
process.exit(alive && contig ? 0 : 1)
