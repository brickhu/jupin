/**
 * ⭐ ECDICT 查词 —— **给模型用的工具**，不是代码里的判分器。
 *
 * ⚠️⚠️ 为什么是工具而不是「代码先算好再喂」：
 *    ECDICT 的字段本身不完整、也不好直接当结论用 ——
 *      · 高级词表**包含基础词**：`as` 有 ielts、`way` 有 toefl、`make` 有 ielts，
 *        但它们是小学词（取「最高档」会全判错）；
 *      · `best` 的 tag 只有 ielts，而 bnc=1212 —— 它其实是常用词；
 *      · 屈折形的 tag / 词频经常是空的（已用 lemma 归并修掉）。
 *    ⇒ 与其把「tag 和词频谁优先」的规则写死在代码里，不如**把原始字段交给模型**，
 *      它自己有权衡（「这个词我知道很简单」），代码只保证**数据是准的、查得到的**。
 *
 * 数据：`.cache/ecdict.json`（pnpm content:ecdict 生成，gitignore）
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ROOT } from '../../../env.mjs'
import type { ToolDef } from './llm'

interface Index {
  /** word → "tag|collins|oxford|bnc|frq|phonetic" */
  w: Record<string, string>
  /** 屈折形 → 原形 */
  l: Record<string, string>
}

let cache: Index | null = null

function load(): Index {
  if (cache) return cache
  const p = join(ROOT, '.cache/ecdict.json')
  if (!existsSync(p)) {
    throw new Error('还没有 ECDICT 索引 —— 先跑 pnpm content:ecdict 生成（约 23MB）')
  }
  cache = JSON.parse(readFileSync(p, 'utf8')) as Index
  return cache
}

export interface DictEntry {
  /** 查的词（原样回显，方便模型对上） */
  query: string
  /** 词典里的词条（可能由屈折形归并而来） */
  word: string
  phonetic: string
  /** 中国考试大纲标签：zk 中考 / gk 高考 / cet4 / cet6 / ky 考研 / toefl / ielts / gre（可能为空） */
  tag: string
  /** 柯林斯星级 1–5（空 = 未收录） */
  collins: string
  /** 是否牛津核心词（1 = 是） */
  oxford: string
  /** BNC 词频序号（越小越常用；0 = 未收录） */
  bnc: string
  /** COCA 词频序号（越小越常用；0 = 未收录） */
  frq: string
}

/**
 * 查一个词。**归并词形**后查（`seashells` → `seashell`），
 * 查不到就老实说「词典里没有」—— 模型据此判「超纲」。
 */
export function dictLookup(query: string): DictEntry | { query: string; found: false } {
  const idx = load()
  const q = String(query ?? '').trim().toLowerCase().replace(/[^a-z'-]/g, '')
  if (q === '') return { query: String(query), found: false }
  /**
   * ⚠️⚠️ **先归并、再取原形的数据**，顺序不能反：
   *    屈折形自己常常有词条但**字段全空**（实测 seashells / paralyzes / counts / frowns
   *    的 tag 与词频都是空的），原形才有 tag / 词频 / 星级。
   *    原形不在词典里时才退回它自己。
   */
  const base = idx.l[q] ?? q
  const word = idx.w[base] !== undefined ? base : q
  const packed = idx.w[word]
  if (packed === undefined) return { query: q, found: false }
  const [tag = '', collins = '', oxford = '', bnc = '', frq = '', phonetic = ''] = packed.split('|')
  return { query: q, word, phonetic, tag, collins, oxford, bnc, frq }
}

/** 给模型的工具定义（见 article-meta.ts 的 SYSTEM 里怎么要求它用） */
export const DICT_TOOL: ToolDef = {
  spec: {
    type: 'function',
    function: {
      name: 'dict_lookup',
      description:
        '查一个英文单词的权威词表信息：中国考试大纲标签 tag（zk 中考 / gk 高考 / cet4 / cet6 / ' +
        'ky 考研 / toefl / ielts / gre，可能为空）、柯林斯星级 collins、是否牛津核心词 oxford、' +
        'BNC 与 COCA 词频序号 bnc / frq（越小越常用，0 = 未收录）、音标 phonetic。' +
        '判断「词汇及句式」档位之前，对**拿不准的词**调用它。会自动归并词形（复数/过去式等）。',
      parameters: {
        type: 'object',
        properties: { word: { type: 'string', description: '要查的英文单词，原形或屈折形都行' } },
        required: ['word'],
      },
    },
  },
  run: (args) => dictLookup(String(args.word ?? '')),
}
