#!/usr/bin/env node
/**
 * ⭐ A/B：同一段音频，同时打**讯飞 ISE** 与**有道 语音评测（iseapi）**，逐项对比。
 *
 *   npx tsx apps/server/scripts/ab-compare.ts /tmp/ab-samples.json /tmp/ab-result.json
 *
 * ⚠️ 有道走的是 **HTTP iseapi**（https://openapi.youdao.com/iseapi），
 *    **不是** stream_capt —— 后者是「实时语音评测」，是另一个产品（¥5/小时 vs ¥50/万次）。
 *    踩过一次，见 docs/research/speech-eval-vendor-comparison.md。
 *
 * ⚠️ 入参是**本地真实录音**（WebM/Opus 容器，扩展名不可信），
 *    先用 ffmpeg 解成 16k/16bit/单声道裸 PCM 再喂给两家 —— 与生产链路同一条归一化路径。
 */
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { env } from '../src/env'
import { XfyunEngine } from '../src/engines/xfyun'

const ISEAPI = 'https://openapi.youdao.com/iseapi'

function wavOf(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8)
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22)
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34)
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([h, pcm])
}

/** 有道 iseapi：HTTP POST，音频 base64，signType=v2 */
async function youdaoScore(pcm: Buffer, text: string) {
  const appKey = env.YDS_APP_KEY as string
  const appSecret = env.YDS_APP_SECRET as string
  const q = wavOf(pcm).toString('base64')
  const salt = randomUUID()
  const curtime = String(Math.floor(Date.now() / 1000))
  // ⚠️ iseapi 的 v2 签名：input 是 q 的「前10 + 长度 + 后10」，不是整个 q
  const input = q.length > 20 ? q.slice(0, 10) + q.length + q.slice(-10) : q
  const sign = createHash('sha256').update(appKey + input + salt + curtime + appSecret).digest('hex')
  const body = new URLSearchParams({
    q, text, langType: 'en', appKey, salt, curtime, sign,
    signType: 'v2', format: 'wav', rate: '16000', channel: '1', type: '1',
  })
  const res = await fetch(ISEAPI, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const json: any = await res.json()
  if (json.errorCode !== '0') throw new Error('有道 errorCode=' + json.errorCode + ' ' + (json.msg ?? ''))
  return json
}

interface Sample { id: string; articleId: number; refText: string; audioPath: string; storedScore: number | null }

async function main() {
  const samples: Sample[] = JSON.parse(readFileSync(process.argv[2]!, 'utf8'))
  const outPath = process.argv[3] ?? '/tmp/ab-result.json'
  const dir = '/tmp/ab-pcm'
  mkdirSync(dir, { recursive: true })

  const xfyun = new XfyunEngine({
    appId: env.XFYUN_APP_ID as string,
    apiKey: env.XFYUN_API_KEY as string,
    apiSecret: env.XFYUN_API_SECRET as string,
  })

  const rows: any[] = []
  for (const s of samples) {
    const rec: any = { id: s.id, articleId: s.articleId, refText: s.refText, storedScore: s.storedScore }
    try {
      const pcmPath = dir + '/' + s.id + '.pcm'
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', s.audioPath, '-ar', '16000', '-ac', '1', '-f', 's16le', pcmPath])
      const pcm = readFileSync(pcmPath)
      rec.secs = +(pcm.length / 32000).toFixed(1)
      rec.bytes = pcm.length

      try {
        const x = await xfyun.score({ refText: s.refText, audio: new Uint8Array(pcm) })
        rec.xfyun = {
          total: x.total, dimensions: x.dimensions,
          words: (x.words ?? []).map((w) => ({ word: w.word, score: w.score, dp: w.dp, badPhones: w.badPhones ?? [] })),
        }
      } catch (e) { rec.xfyunError = (e as Error).message }

      try {
        const y = await youdaoScore(pcm, s.refText)
        rec.youdao = {
          overall: y.overall, integrity: y.integrity, fluency: y.fluency, pronunciation: y.pronunciation, speed: y.speed,
          words: (y.words ?? []).map((w: any) => ({
            word: w.word, score: w.pronunciation, ipa: w.IPA,
            phonemes: (w.phonemes ?? []).map((p: any) => ({ p: p.phoneme, judge: p.judge, cal: p.calibration, prom: p.prominence })),
          })),
        }
      } catch (e) { rec.youdaoError = (e as Error).message }

      const xt = rec.xfyun?.total, yo = rec.youdao?.overall
      console.log(
        s.id.slice(0, 8) + '  art' + s.articleId +
        '  ' + String(rec.secs).padStart(5) + 's' +
        '  讯飞=' + (xt == null ? ' ERR' : String(xt).padStart(5)) +
        '  有道=' + (yo == null ? ' ERR' : String(yo).padStart(5)) +
        '  Δ=' + (xt != null && yo != null ? (yo - xt).toFixed(1).padStart(6) : '     -') +
        (rec.xfyunError ? '  [讯飞 ' + rec.xfyunError.slice(0, 40) + ']' : '') +
        (rec.youdaoError ? '  [有道 ' + rec.youdaoError.slice(0, 40) + ']' : ''),
      )
    } catch (e) {
      rec.decodeError = (e as Error).message
      console.log(s.id.slice(0, 8) + '  解码失败: ' + rec.decodeError)
    }
    rows.push(rec)
    writeFileSync(outPath, JSON.stringify(rows, null, 2))
  }
  console.log('\n→ ' + outPath + '（已写 ' + rows.length + ' 条）')
}

main().catch((e) => { console.error(e); process.exit(1) })
