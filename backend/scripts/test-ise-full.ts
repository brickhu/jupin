/**
 * ISE 端到端测试：直接用 assessPronunciation 测试，不绕文章系统
 * 用法: pnpm dotenv -e .env -- pnpm tsx scripts/test-ise-full.ts
 */
import fs from 'fs'
import { assessPronunciation } from '../src/services/ise'

async function main() {
  console.log('=== ISE 端到端测试 ===\n')

  // 读取 WAV 并提取 PCM
  const wavFile = fs.readFileSync('/tmp/stay.wav')
  
  // 解析 WAV 提取 PCM
  let pcmOffset = 12
  while (pcmOffset < wavFile.length - 8) {
    const id = wavFile.toString('utf8', pcmOffset, pcmOffset + 4)
    const sz = wavFile.readUInt32LE(pcmOffset + 4)
    if (id === 'data') break
    pcmOffset += 8 + sz
  }
  const pcmData = wavFile.subarray(pcmOffset + 8)
  console.log(`WAV: ${wavFile.length} bytes, PCM: ${pcmData.length} bytes`)

  // 文本需要与音频匹配（say 朗读的是 "Stay hungry, stay foolish."）
  const text = 'Stay hungry, stay foolish.'

  console.log(`文本: "${text}"`)
  console.log('调用 ISE 评分...\n')

  const result = await assessPronunciation({
    text,
    audioBuffer: pcmData,
    category: 'read_sentence',
  })

  console.log('✅ ISE 评分成功！')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('❌ 测试失败:', err.message)
  process.exit(1)
})