/**
 * 快速测试评分接口 — 使用真实 WAV 文件
 * 需要先存在 /tmp/stay.wav（用 say 命令生成）
 * 用法: pnpm dotenv -e .env -- pnpm tsx scripts/test-score-direct.ts
 */
import fs from 'fs'

const BASE = 'http://localhost:3000'

async function main() {
  // 读取真实语音 WAV
  const wavFile = fs.readFileSync('/tmp/stay.wav')
  console.log(`WAV 文件: ${wavFile.length} bytes`)

  // 注册新用户
  const testEmail = `ise-test-${Date.now()}@jushuo.com`
  console.log(`📡 注册 ${testEmail}...`)
  const codeResp = await fetch(`${BASE}/api/auth/send-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail }),
  })
  console.log('  验证码响应:', codeResp.status, JSON.stringify(await codeResp.json()))
  
  // 从 Mailpit 获取验证码
  let code = ''
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000))
    const mp = await fetch('http://localhost:8025/api/v1/messages')
    const mpd: any = await mp.json()
    const msg = mpd.messages?.find((m: any) => m.To?.some((t: any) => t.Address === testEmail))
    if (msg) {
      const md = await fetch(`http://localhost:8025/api/v1/message/${msg.ID}`)
      const mdd: any = await md.json()
      const match = (mdd.Text || '').match(/(\d{6})/)
      if (match) { code = match[1]; break }
    }
  }
  if (!code) { console.error('❌ 未获取到验证码'); process.exit(1) }
  
  const regResp = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, password: 'test123456', code }),
  })
  const regData: any = await regResp.json()
  console.log('  注册响应:', regResp.status, JSON.stringify(regData).slice(0, 100))
  const token = regData.token
  if (!token) { console.error('❌ 注册失败', JSON.stringify(regData)); process.exit(1) }

  // 获取文章
  console.log('\n📡 获取文章...')
  const artResp = await fetch(`${BASE}/api/articles/today`, {
    headers: { 'Authorization': `Bearer ${token}` },
  })
  const artData: any = await artResp.json()
  const article = (artData.articles || [])[0]
  if (!article) { console.error('❌ 没有文章'); process.exit(1) }
  console.log(`  文章 #${article.id}: "${(article.content || '').slice(0, 60)}..."`)

  // 提交评分 — 使用真实 WAV 文件
  console.log('\n📡 提交评分...')
  const form = new FormData()
  form.append('audio', new Blob([wavFile], { type: 'audio/wav' }), 'stay.wav')
  form.append('articleId', String(article.id))

  const scoreResp = await fetch(`${BASE}/api/readings/score`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: form,
  })
  const scoreData = await scoreResp.json()
  console.log('  状态码:', scoreResp.status)
  console.log('  响应:', JSON.stringify(scoreData, null, 2))

  if (scoreResp.status === 200) {
    console.log('\n✅ 评分成功！ISE 服务正常工作！')
  } else {
    console.log(`\n❌ 评分失败: ${scoreData.error}`)
  }
}

main().catch(console.error)