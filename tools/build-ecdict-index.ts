/**
 * ⭐ 把 ECDICT 的 CSV 压成**只含判难度需要的那几列**的紧凑索引。
 *
 * 为什么要有这一步：npm 的 ecdict 包 install 后会生成 `data/dict.json`（**119MB**，
 * 带英文释义/中文翻译），而我们只需要 6 个字段。整份载入要几百 MB 内存，
 * 对一个「查几个词」的工具来说完全不成比例。
 *
 * 产物：`.cache/ecdict.json`（gitignore）——
 *   { "w": { "<word>": "<tag>|<collins>|<oxford>|<bnc>|<frq>|<phonetic>" },
 *     "l": { "<屈折形>": "<原形>" } }
 *
 * ⚠️ 词形归并（lemma）**必须做**：ECDICT 对屈折形的 tag/词频经常是空的
 *    （实测 days / sells / shells / smiles / counts 全是空 → 硬算会把小学词判成超纲）。
 *    规则：① 词条自己带 `0:原形` 就用它；② 否则用「别的主词条的屈折列表」反查；
 *    ③ 都不是就是它自己（**主词条优先**，否则 `way` 会被反查成 `ways`）。
 *
 * 用法：pnpm content:ecdict
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { ROOT } from './env.mjs'

const require = createRequire(import.meta.url)

/** 找到 ecdict 包里的 assets/ecdict.csv（pnpm 的 node_modules 布局下不能硬编码路径） */
function csvPath(): string {
  try {
    const entry = require.resolve('ecdict')
    const p = join(dirname(entry), '..', 'assets', 'ecdict.csv')
    if (existsSync(p)) return p
  } catch {
    /* 继续找 */
  }
  throw new Error('找不到 ecdict 的 assets/ecdict.csv —— 先 pnpm add --filter @jushuo/pipeline ecdict')
}

/** RFC4180 的极简解析器：字段里的逗号/换行/双写引号都要认（词条释义里全有） */
function* records(text: string): Generator<string[]> {
  let field = ''
  let row: string[] = []
  let inQ = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ } else inQ = false
      } else field += c
    } else if (c === '"') inQ = true
    else if (c === ',') { row.push(field); field = '' }
    else if (c === '\n') { row.push(field); yield row; row = []; field = '' }
    else if (c !== '\r') field += c
  }
  if (field !== '' || row.length > 0) { row.push(field); yield row }
}

/** CSV 的列顺序（见 assets/ecdict.csv 的表头） */
const COL = ['word', 'phonetic', 'definition', 'translation', 'pos', 'collins', 'oxford', 'tag', 'bnc', 'frq', 'exchange', 'detail', 'audio']
/** 这些 key 后面的值是**屈折形**（本词条是原形）；`0` 反过来：值是**原形**（本词条是屈折形） */
const INFLECT_KEYS = ['s', 'p', 'd', 'i', '3', 'r', 't']

const words: Record<string, string> = {}
const lemma: Record<string, string> = {}
let n = 0

for (const row of records(readFileSync(csvPath(), 'utf8'))) {
  const r: Record<string, string> = {}
  COL.forEach((c, i) => { r[c] = row[i] ?? '' })
  const w = (r.word || '').trim().toLowerCase()
  if (w === '') continue
  n++
  words[w] = [r.tag, r.collins, r.oxford, r.bnc, r.frq, r.phonetic].map((x) => (x || '').trim()).join('|')
  for (const part of (r.exchange || '').split('/')) {
    const [k, v] = part.split(':', 2)
    if (!k || !v) continue
    if (k === '0') lemma[w] = v.trim().toLowerCase()
    else if (INFLECT_KEYS.includes(k)) {
      for (const f of v.split(',')) {
        const form = f.trim().toLowerCase()
        // ⚠️ 主词条优先：不覆盖已有的「自己」（否则 way 会被反查成 ways）
        if (form && form !== w && !(form in words) && !(form in lemma)) lemma[form] = w
      }
    }
  }
}

const out = join(ROOT, '.cache/ecdict.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, JSON.stringify({ w: words, l: lemma }))
const mb = (JSON.stringify({ w: words, l: lemma }).length / 1024 / 1024).toFixed(1)
console.log('✅ 索引已建：' + out)
console.log('   词条 ' + n + '，归并映射 ' + Object.keys(lemma).length + '，大小 ' + mb + ' MB')
for (const probe of ['seashells', 'days', 'made', 'way', 'is', 'paralyzes']) {
  const base = lemma[probe] ?? probe
  console.log('   ' + probe + ' → ' + base + '  [' + (words[base] ?? '(不在词表)') + ']')
}
