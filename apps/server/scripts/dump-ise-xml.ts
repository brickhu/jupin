#!/usr/bin/env node
/**
 * ⭐ 把**生产参数**下的完整 ISE 返回 dump 出来，并列出一共有哪些字段。
 *
 *   npx tsx apps/server/scripts/dump-ise-xml.ts /tmp/probe.pcm "The best way to predict the future is to invent it."
 *
 * ⚠️ 为什么值得有这么一个脚本：讯飞返回的字段远多于我们用到的，而
 *    「字段挂在哪一级节点上」光看文档说不准 —— 文档还有普通版/流式版之分，
 *    两份的分制与示例都不一样（docs/research/ise-probe-report.md 记过两次坑）。
 *    想新接一个维度，正确做法是**先 dump 出来看一眼**，而不是照着文档猜。
 *
 * ⚠️ 入参是**裸 PCM**（16k/16bit/单声道，无 WAV 头）。容器先转：
 *      ffmpeg -i 录音.webm -ar 16000 -ac 1 -f s16le /tmp/probe.pcm
 *
 * 完整字段清单见 docs/research/ise-response-fields.md。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { XMLParser } from 'fast-xml-parser'

import { env } from '../src/env'
import { XfyunEngine } from '../src/engines/xfyun'

const pcmPath = process.argv[2]
const refText = process.argv[3]
if (!pcmPath || !refText) {
  console.error('用法：npx tsx apps/server/scripts/dump-ise-xml.ts <裸PCM> "<参考文本>"')
  process.exit(1)
}

async function main() {
  const engine = new XfyunEngine({
    appId: env.XFYUN_APP_ID ?? '',
    apiKey: env.XFYUN_API_KEY ?? '',
    apiSecret: env.XFYUN_API_SECRET ?? '',
  })

  const audio = new Uint8Array(readFileSync(pcmPath as string))
  const secs = (audio.byteLength / 32000).toFixed(1)
  console.log('音频 ' + audio.byteLength + ' 字节（~' + secs + 's @16k/16bit/mono）')
  console.log('参考文本：' + refText)

  const xml = await engine.rawScore({ refText: refText as string, audio })
  writeFileSync('/tmp/ise.xml', xml)
  console.log('XML ' + xml.length + ' 字符 → /tmp/ise.xml')

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    isArray: (n) => ['word', 'syll', 'phone', 'sentence'].includes(n),
  })
  const root = parser.parse(xml) as any
  const tree = root.xml_result ?? root

  // 逐节点收集属性：同一个节点有很多实例（每个词一个），属性取并集
  const byPath = new Map<string, Set<string>>()
  const walk = (node: any, path: string): void => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const n of node) walk(n, path)
      return
    }
    if (!byPath.has(path)) byPath.set(path, new Set())
    const attrs = byPath.get(path) as Set<string>
    for (const k of Object.keys(node)) {
      if (k.startsWith('@_')) attrs.add(k.slice(2))
      else walk(node[k], path + '.' + k)
    }
  }
  walk(tree, 'xml_result')

  console.log('')
  console.log('=== 每个节点的全部属性 ===')
  for (const [path, attrs] of byPath) console.log(path + '  →  ' + [...attrs].join(', '))

  const paper = tree.read_sentence?.rec_paper?.read_chapter ?? tree.read_sentence?.rec_paper?.read_sentence
  console.log('')
  console.log('=== 关键分数（百分制）===')
  const keys = ['total_score', 'accuracy_score', 'fluency_score', 'standard_score', 'integrity_score', 'is_rejected']
  for (const k of keys) console.log('  ' + k + ' = ' + paper?.['@_' + k])
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
