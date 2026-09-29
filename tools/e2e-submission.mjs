#!/usr/bin/env node
/**
 * ⭐ 端到端跑一遍「参与挑战」这条业务流程（对着**真实运行的服务**，不是单测）。
 *
 *   node tools/e2e-submission.mjs            # 默认打 local（127.0.0.1:8899）
 *   BASE=... node tools/e2e-submission.mjs
 *
 * 它按客户端的**真实请求顺序**走一遍：
 *   ① 造一个测试用户（给能量）
 *   ② GET /api/user/today            拿今日句子
 *   ③ POST /api/user/uploads         传音频（拿 audioKey/audioUrl）
 *   ④ POST /api/user/submissions     受理（新 attemptId）
 *   ⑤ 轮询 /api/user/submissions/:id  直到 scored / failed
 *   ⑥ GET /api/user/article-records  核对"历史挑战"那张卡的数字
 *   ⑦ 核对库里的行（status/score/attempt_id/participations）
 * 最后把每一步的**真实响应**打出来，失败就非零退出。
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

import { loadEnv, ROOT } from './env.mjs'

const BASE = process.env.BASE ?? 'http://127.0.0.1:8899'
const OPENID = process.env.E2E_OPENID ?? 'z_e2e_' + Date.now()
const AUDIO = process.env.E2E_AUDIO ?? 'content/audio/06ef2b193b83b3d7.mp3'

loadEnv('local')
const req = createRequire(ROOT + '/apps/server/package.json')
const mysql = req('mysql2/promise')

const H = { 'x-wx-source': 'cloudrun', 'x-wx-openid': OPENID, 'Content-Type': 'application/json' }
const j = async (r) => {
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { __raw: t.slice(0, 200) } }
}
const step = (n, s) => console.log('\n' + n + ' ' + s)
let failed = 0
const check = (name, ok, detail) => {
  console.log('   ' + (ok ? '✅' : '❌') + ' ' + name + (detail === undefined ? '' : '  → ' + detail))
  if (!ok) failed++
}

const conn = await mysql.createConnection({ host: '127.0.0.1', port: 5544, user: 'root', password: 'dev', database: 'jushuo', charset: 'utf8mb4' })

// ---- ① 造用户 + 给能量 ----
step('①', '造测试用户并给能量')
let [u] = await conn.execute('SELECT id FROM users WHERE openid = ?', [OPENID])
if (u.length === 0) {
  await conn.execute('INSERT INTO users (openid, energy, energy_date) VALUES (?, 20, ?)', [OPENID, new Date().toISOString().slice(0, 10)])
  ;[u] = await conn.execute('SELECT id FROM users WHERE openid = ?', [OPENID])
}
const uid = u[0].id
await conn.execute('UPDATE users SET energy = 20 WHERE id = ?', [uid])
check('测试用户就绪', !!uid, 'uid=' + uid + ' energy=20')

// ---- ② 今日句子 ----
step('②', 'GET /api/user/today')
const today = await j(await fetch(BASE + '/api/user/today', { headers: H }))
const entry = today?.data?.entry
check('拿到今日句子', !!entry?.articleId, entry?.articleId + ' | ' + String(entry?.text).slice(0, 32))
if (!entry?.articleId) { console.error(JSON.stringify(today).slice(0, 300)); process.exit(1) }
const articleId = entry.articleId
const scheduleDate = entry.date

// ---- ③ 上传音频 ----
step('③', 'POST /api/user/uploads')
const attemptId = req('node:crypto').randomBytes(16).toString('hex')
const key = `audio/${articleId}/${uid}/${attemptId}.mp3`
// ⚠️ 字段名照客户端的 uploadToLocalServer：articleId / audioKey / file（不是 'key'）
const form = new FormData()
form.append('file', new Blob([readFileSync(ROOT + '/' + AUDIO)], { type: 'audio/mpeg' }), 'a.mp3')
form.append('articleId', articleId)
form.append('audioKey', key)
/**
 * ⚠️ multipart 的 `Content-Type` 里**必须带 boundary**，而 boundary 是 fetch 自己生成的 ——
 *    所以我**不能**在这里手写 `'Content-Type': 'multipart/form-data'`（那会覆盖掉 boundary，
 *    服务端读不出 formData）。这里显式**不带 Content-Type**，让 fetch 自动补。
 *    ⚠️ 用 `{ ...H }` 再 delete 掉那个键：直接写 `'Content-Type': undefined` 在 Node 的 fetch 里
 *    仍然可能把 header 设成字符串 "undefined"，那就是我上一版踩的坑。
 */
const uploadHeaders = { ...H }
delete uploadHeaders['Content-Type']
const up = await j(await fetch(BASE + '/api/user/uploads', { method: 'POST', headers: uploadHeaders, body: form }))
check('音频上传成功', up?.ok === true, JSON.stringify(up?.data ?? up).slice(0, 120))
if (up?.ok !== true) process.exit(1)
const audioKey = up.data?.audioKey ?? key
const audioUrl = up.data?.audioUrl ?? up.data?.url ?? null

// ---- ④ 提交 ----
step('④', 'POST /api/user/submissions（新 attemptId）')
const sub = await j(await fetch(BASE + '/api/user/submissions', {
  method: 'POST', headers: H,
  body: JSON.stringify({ articleId, audioKey, audioUrl, attemptId, scheduleDate }),
}))
const submissionId = sub?.data?.submissionId
check('受理成功（202 + submissionId）', sub?.ok === true && !!submissionId, 'status=' + sub?.data?.status + ' id=' + submissionId)
if (!submissionId) { console.error(JSON.stringify(sub).slice(0, 300)); process.exit(1) }

// ---- ⑤ 轮询 ----
step('⑤', '轮询 /api/user/submissions/' + submissionId)
let last = null
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1500))
  const st = await j(await fetch(BASE + '/api/user/submissions/' + submissionId, { headers: H }))
  last = st?.data
  if (last?.status !== 'scoring') break
}
check('检测有了结论（不是一直 scoring）', last?.status === 'scored' || last?.status === 'failed', 'status=' + last?.status + ' score=' + last?.score + ' fail=' + (last?.failReason ?? last?.error ?? '-'))

// ---- ⑥ 历史卡 ----
step('⑥', 'GET /api/user/article-records（历史挑战那张卡）')
const rec = await j(await fetch(BASE + '/api/user/article-records?article=' + articleId, { headers: H }))
const d = rec?.data ?? {}
check('接口正常', rec?.ok === true, 'attempts=' + d.attempts + ' best=' + d.bestScore + ' lowest=' + d.lowestScore + ' rank=' + d.rank + '/' + d.participantCount + ' rows=' + (d.rows ?? d.items ?? []).length)

// ---- ⑦ 库 ----
step('⑦', '核对库里的行')
const [rows] = await conn.execute('SELECT seq, status, score, attempt_id FROM submissions WHERE user_id=? AND article_id=? ORDER BY seq DESC LIMIT 3', [uid, articleId])
for (const r of rows) console.log('   · seq=' + r.seq + ' status=' + r.status + ' score=' + r.score + ' attempt=' + String(r.attempt_id ?? '-').slice(0, 8))
check('这一行真的落库了', rows.some((r) => r.attempt_id === attemptId), 'attempt=' + attemptId.slice(0, 8))
/**
 * ⚠️⚠️ 这里的**不变量**是（2026-09 定，别改回去）：
 *    · `participations` **只由"有分"的提交撑起来** —— 它的 `best_submission_id` /
 *      `reached_at` 是 NOT NULL，只有 failed 的句子**写不出这一行**；
 *    · 而「检测跑到了但没出分」那一次**算一次挑战**，体现在**列表**上：
 *      `/api/user/article-records` 连 failed 一起返回，卡片次数 = 列表行数。
 *    ⇒ 所以对"全是 failed"的句子，**没有参与行才是对的**。
 */
const [p] = await conn.execute('SELECT attempts, best_score FROM participations WHERE user_id=? AND article_id=?', [uid, articleId])
const scoredCount = rows.filter((r) => r.status === 'scored').length
if (scoredCount === 0) {
  check('没有任何分数 ⇒ 不该有参与行（符合 NOT NULL 的设计）', p.length === 0, p.length === 0 ? '无参与行 ✓' : '❌ 竟然有行')
} else {
  check('有分数 ⇒ 参与行已更新', p.length > 0, p[0] ? 'attempts=' + p[0].attempts + ' best=' + p[0].best_score : '(无)')
}
/** ⭐ 最关键的一条：**卡片次数 = 列表行数**（用户报的"5 次 vs 第 6 次"就是这条被破坏） */
const apiAttempts = d.attempts
const apiRows = (d.rows ?? d.items ?? []).length
check('卡片次数 = 列表行数（不会再出现"5 次"配"第 6 次"）', apiAttempts === apiRows, 'attempts=' + apiAttempts + ' rows=' + apiRows)

// ---- ⑧ 场景二：「没触达」应当**整行删掉**（音频读不出来 = 我们这边的问题）----
step('⑧', '场景二：audioKey 指向不存在的文件 ⇒ 该整行删掉（不占序号、不进历史）')
const ghostKey = `audio/${articleId}/${uid}/${'f'.repeat(32)}.mp3`
const ghostAttempt = 'f'.repeat(32)
const before = (await conn.execute('SELECT COUNT(*) n FROM submissions WHERE user_id=? AND article_id=?', [uid, articleId]))[0][0].n
const sub2 = await j(await fetch(BASE + '/api/user/submissions', {
  method: 'POST', headers: H,
  body: JSON.stringify({ articleId, audioKey: ghostKey, attemptId: ghostAttempt, scheduleDate }),
}))
const id2 = sub2?.data?.submissionId
for (let i = 0; i < 20 && id2; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const st = await j(await fetch(BASE + '/api/user/submissions/' + id2, { headers: H }))
  if (st?.data?.status !== 'scoring') break
}
const after = (await conn.execute('SELECT COUNT(*) n FROM submissions WHERE user_id=? AND article_id=?', [uid, articleId]))[0][0].n
check('没触达 ⇒ 行数没有增加（整行被删了）', after === before, 'before=' + before + ' after=' + after)
const [ghost] = await conn.execute('SELECT COUNT(*) n FROM submissions WHERE attempt_id=?', [ghostAttempt])
check('那一行确实不在库里', ghost[0].n === 0, 'count=' + ghost[0].n)
const [e2] = await conn.execute('SELECT energy FROM users WHERE id=?', [uid])
check('能量已退回（没触达不该扣）', e2[0].energy >= 20 - 2, 'energy=' + e2[0].energy)

// ---- ⑨ 最关键：序号**不许有空洞**（用户报的"第 4 次跳到第 6 次"）----
step('⑨', '序号连续性（根治项）：占过号的行必须恰好是 1..N')
const [seqRows] = await conn.execute(
  'SELECT seq FROM submissions WHERE user_id=? AND article_id=? AND seq IS NOT NULL ORDER BY seq',
  [uid, articleId],
)
const seqs = seqRows.map((r) => r.seq)
const expectSeq = seqs.map((_, i) => i + 1)
check(
  '序号是 1..N 连续的（没有空洞）',
  JSON.stringify(seqs) === JSON.stringify(expectSeq),
  '实际=[' + seqs.join(',') + '] 期望=[' + expectSeq.join(',') + ']',
)
const [nullSeq] = await conn.execute(
  'SELECT COUNT(*) n FROM submissions WHERE user_id=? AND article_id=? AND seq IS NULL',
  [uid, articleId],
)
check('没有"无号"的残留行（检测中/没触达都该被清掉）', nullSeq[0].n === 0, 'count=' + nullSeq[0].n)

// ---- ⑩ 用户中途退出：提交后**谁都不问**，服务端该自己跑完 ----
step('⑩', '用户中途退出（提交后不再轮询）⇒ 后台自己跑完并落号')
const attemptX = req('node:crypto').randomBytes(16).toString('hex')
const keyX = `audio/${articleId}/${uid}/${attemptX}.mp3`
const formX = new FormData()
formX.append('file', new Blob([readFileSync(ROOT + '/' + AUDIO)], { type: 'audio/mpeg' }), 'a.mp3')
formX.append('articleId', articleId)
formX.append('audioKey', keyX)
const upX = await j(await fetch(BASE + '/api/user/uploads', { method: 'POST', headers: uploadHeaders, body: formX }))
const subX = await j(await fetch(BASE + '/api/user/submissions', {
  method: 'POST', headers: H,
  body: JSON.stringify({ articleId, audioKey: upX?.data?.audioKey ?? keyX, attemptId: attemptX, scheduleDate }),
}))
const idX = subX?.data?.submissionId
// ⚠️ 这里**故意不轮询**：完全模拟"用户提交完就退出小程序"
let settledX = null
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const [r] = await conn.execute('SELECT status, seq FROM submissions WHERE id=?', [idX])
  if (r.length === 0) { settledX = { status: 'deleted' }; break }
  if (r[0].status !== 'scoring') { settledX = r[0]; break }
}
check(
  '没有人轮询，后台也把这一把跑完了（有结论）',
  settledX !== null && settledX.status !== 'scoring',
  settledX ? 'status=' + settledX.status + ' seq=' + settledX.seq : '仍在 scoring（超时）',
)
if (settledX && settledX.status !== 'deleted') {
  check('它拿到了序号（算一次挑战、会出现在历史里）', settledX.seq !== null, 'seq=' + settledX.seq)
}

// ---- ⑪ 进程崩了留下的悬空行 ⇒ 清扫时**整行删掉**（没触达，不该占号/进历史）----
step('⑪', '悬空行（进程崩了）被清扫 ⇒ 整行删掉，不占号')
const ghostId = 'zzsweep' + Date.now().toString(16).slice(-8)
await conn.execute(
  `INSERT INTO submissions (id, user_id, article_id, seq, schedule_date, status, heartbeat_at, attempts, attempt_id, audio_key, energy_state)
   VALUES (?, ?, ?, NULL, ?, 'scoring', DATE_SUB(NOW(), INTERVAL 30 MINUTE), 1, ?, ?, 'held')`,
  [ghostId, uid, articleId, scheduleDate, 'a'.repeat(31) + '0', `audio/${articleId}/${uid}/${'a'.repeat(31)}0.mp3`],
)
/**
 * 任何 /api/user/* 请求都会**惰性**触发清扫（见 index.ts 的中间件），但它有**节流**：
 *    · 悬空判定：心跳超过 3 分钟（STALE_MS）
 *    · 触发节流：两次清扫间隔 60 秒（THROTTLE_MS）
 * ⇒ 所以要**持续发请求**直到跨过节流窗口，而不是打一次就断言。
 */
let swept = false
for (let i = 0; i < 18 && !swept; i++) {
  await fetch(BASE + '/api/user/today', { headers: H }).catch(() => {})
  await new Promise((r) => setTimeout(r, 5000))
  const [r] = await conn.execute('SELECT COUNT(*) n FROM submissions WHERE id=?', [ghostId])
  swept = r[0].n === 0
}
check('悬空行被整行删掉（不是标成"未出分"留在历史里）', swept, swept ? '已删' : '还在')

// ---- 清理：把造出来的测试用户**整个删掉**（别每次跑都留一个孤儿账号）----
//
// ⚠️ 顺序按外键：出分那一把会发奖励（reward_grants.user_id → users.id），
//    不先删它就会 1451（实测踩过）。这里刻意**逐条写出来**而不做成数组循环 ——
//    数据所有权守门要静态解析"哪个文件写了哪张表"，表名藏进数组它就扫不到。
await conn.execute('DELETE FROM participations WHERE user_id = ?', [uid]).catch(() => {})
await conn.execute('DELETE FROM reward_grants WHERE user_id = ?', [uid]).catch(() => {})
await conn.execute('DELETE FROM energy_ledger WHERE user_id = ?', [uid]).catch(() => {})
await conn.execute('DELETE FROM submissions WHERE user_id = ?', [uid]).catch(() => {})
await conn.execute('DELETE FROM users WHERE id = ?', [uid]).catch(() => {})
console.log('\n' + (failed === 0 ? '✅ 端到端通过（测试用户 openid=' + OPENID + '）' : '❌ 有 ' + failed + ' 项没过'))
await conn.end()
process.exit(failed === 0 ? 0 : 1)
