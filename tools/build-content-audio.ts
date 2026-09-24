#!/usr/bin/env node
/**
 * ⭐ 生成标准音 —— 整句 + 逐词。
 *
 * 产物（进仓库，随镜像发布）：
 *   content/audio/{id}.mp3        整句标准音
 *   content/audio/{id}/w{i}.mp3   第 i 个单词的发音
 *
 * ⚠️⚠️ 逐词的**下标必须与客户端切词完全一致** —— 客户端是
 *    `text.split(/\s+/).filter(Boolean)`，这里必须一模一样。
 *    两边规则一旦不同，点第 3 个词会听到第 4 个词的音，
 *    而界面上完全看不出来（都是正常发音，只是不对应）。
 *
 * ⚠️ 合成用 macOS 自带的 say + ffmpeg：
 *    · 不依赖任何 API key，本机就能跑、能验
 *    · 换成云 TTS（fish-audio 之类）时，只需替换 synth() 一个函数
 *
 * ⚠️ 逐词读的是**单词的独立发音**（citation form），不是整句里那个词的切片。
 *    这两者确实不同（连读、弱读只在句子里出现），但对「这个词怎么念」这个问题，
 *    独立发音才是答案 —— 词典也是这么给的。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONTENT = resolve(ROOT, 'content')
const OUT = resolve(CONTENT, 'audio')
const MANIFEST = resolve(OUT, 'manifest.json')

/** 英文女声。macOS 自带，无需下载。 */
const VOICE = 'Samantha'

const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])
const say = (text, aiff) => execFileSync('say', ['-v', VOICE, '-o', aiff, text])

/**
 * ⚠️ 与客户端**逐字一致**的切词。改这里就必须同步改 reading.ts。
 */
function splitWords(text) {
  return text.split(/\s+/).filter(Boolean)
}

/**
 * 送给 TTS 的文本：去掉首尾标点。
 * ⚠️ 只去首尾，不动中间的连字符和撇号（"well-known" / "it's" 必须原样读）。
 */
function speakable(word) {
  return word.replace(/^[^\p{L}\p{N}'-]+|[^\p{L}\p{N}'-]+$/gu, '') || word
}

/** 合成一段语音 → mp3（vbr，单声道，音量归一化，便于和其它音源混着听不出突兀） */
function synth(text, outMp3) {
  mkdirSync(dirname(outMp3), { recursive: true })
  const aiff = outMp3 + '.tmp.aiff'
  try {
    say(text, aiff)
    ffmpeg(['-i', aiff, '-ac', '1', '-ar', '24000', '-codec:a', 'libmp3lame', '-q:a', '5', outMp3])
  } finally {
    rmSync(aiff, { force: true })
  }
}

function main() {
  mkdirSync(OUT, { recursive: true })
  const manifest = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, 'utf8')) : {}

  let made = 0
  let skipped = 0
  for (const id of [1, 2, 3, 4, 5]) {
    const file = resolve(CONTENT, 'articles', id + '.json')
    if (!existsSync(file)) continue
    const { text } = JSON.parse(readFileSync(file, 'utf8'))
    const words = splitWords(text)
    // ⚠️ 指纹带上语音名：换发音人时必须重新生成，否则新旧音色混在一套内容里
    const hash = createHash('sha256').update(VOICE + '|' + text).digest('hex').slice(0, 16)
    const full = resolve(OUT, id + '.mp3')

    if (manifest[id] === hash && existsSync(full)) {
      skipped++
      continue
    }

    synth(text, full)
    words.forEach((w, i) => synth(speakable(w), resolve(OUT, String(id), 'w' + i + '.mp3')))
    manifest[id] = hash
    made++
    console.log(`  #${id}  ${words.length} 词  ${(statSync(full).size / 1024).toFixed(0)}KB  ${text.slice(0, 40)}…`)
  }

  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`[audio] 生成 ${made} 篇，跳过 ${skipped} 篇（未变）`)
}

main()
