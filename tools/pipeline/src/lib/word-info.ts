/**
 * ⭐ 词表生成 —— 正文里 `words[]` / `links[]` 的**唯一产出方**（流水线的 ③④⑤⑥ 步）。
 *
 * 一份数据支撑朗读页的三层显示（表现层不在数据里，见 types/content.ts）：
 *   · 词级节奏 —— `stress`（句重音：重读 / 普通 / 弱读）
 *   · 词内分拍 —— `syllables`（拼写分块）+ `ipa`（重音符号在音标里）
 *   · 词间断连 —— `links`（一句人话；空串 = 不连）
 *
 * ⚠️⚠️ **这里不碰音频**。点词播放走微信 TTS，正文里不存时间戳、不存切片地址 ——
 *    以前那套「ffmpeg 从整句切出 w{i}.mp3 + words[].startMs/endMs」已经删掉（2026-09）。
 *    ⚠️ 唯一与音频有关的地方是 **连读的否决**：见 buildLinks 的 pauses 参数。
 *
 * ⚠️ 词下标必须与 plainWordsOf(text) 严格一致（评分引擎的逐词分数就按这个下标给），
 *    所以这里**不合并、不拆分、不剥标点**。
 */

import { createRequire } from 'node:module'

import { plainWordsOf } from '@jushuo/shared'
import type { ArticleWordItem, ArticleWordStress } from '@jushuo/shared'
// ⚠️ cmu-pronouncing-dictionary 是纯数据包（13.5 万词，ISC）：
//    ARPAbet 音素序列，形如 "S AH0 F IH2 S T AH0 K EY1 SH AH0 N"
import { dictionary as cmu } from 'cmu-pronouncing-dictionary'

/**
 * ⚠️ hyphen 没有类型声明，用 createRequire 拿（它的 en-us 入口自带 TeX 的英文断词模式，
 *    零依赖、**ISC 许可** —— 商用没问题；不需要另外装 hyphenation.en-us）。
 *    用法：hyphenateSync('interesting') === 'in-ter-est-ing'
 */
const require = createRequire(import.meta.url)
const { hyphenateSync } = require('hyphen/en-us') as {
  /**
   * ⚠️⚠️ 必须传 `hyphenChar`：它默认用的是**软连字符 U+00AD**（不可见），
   *    照默认值拿结果再 split('-') 会**永远切不开**（踩过：mirror 返回 'mir\u00ADror'，
   *    split('-') 得到一个整块，看起来像"连字符词典不支持这个词"）。
   */
  hyphenateSync: (w: string, opts?: { hyphenChar?: string }) => string
}

/**
 * ⭐ 功能词表 —— 决定 `stress` 的弱读侧（-1）。
 *
 * ⚠️ 刻意**只放**冠词 / 介词 / 连词 / 代词 / 助动词 / 情态动词：
 *    副词与限定词（also / only / very / too / more / all / every …）会**承载句重音**，
 *    放进来的话"这句话的重心在哪"就丢了（实测过：'it smiles too' 的 too 是重心）。
 */
const FUNCTION_WORDS = new Set(
  (
    'a an the of to and or but is are was were be been am it its that this these those at by in on ' +
    'for with from as not no nor so than then there when what which who whom whose how do does did ' +
    'done has have had will would can could may might must shall should i me my we our you your he ' +
    'she him his her they them their us into over under out up down off if because while until since ' +
    'though although whereas'
  ).split(/\s+/),
)

/**
 * ⭐ 功能词的**句中弱读形**（标准 IPA，不带音节点）。
 *
 * ⚠️⚠️ 为什么必须有：`and` 在句子里念 /ən/，不是词典引用形 /ænd/。音标若写引用形，
 *    就会和 `stress = -1`（这个词是弱读）**自相矛盾** —— 用户照音标念反而是错的。
 * ⚠️ 只覆盖最常见的那批；弱读还受前后音影响（the 在元音前是 /ði/），这里取默认形。
 */
const WEAK_IPA: Record<string, string> = {
  a: 'ə', an: 'ən', the: 'ðə', of: 'əv', to: 'tə', and: 'ən', or: 'ɚ', but: 'bət',
  as: 'əz', at: 'ət', for: 'fɚ', from: 'frəm', than: 'ðən', that: 'ðət', with: 'wɪð',
  can: 'kən', was: 'wəz', were: 'wɚ', are: 'ɚ', have: 'həv', has: 'həz', had: 'həd',
  do: 'də', does: 'dəz', some: 'səm', us: 'əs', them: 'ðəm', her: 'hɚ', your: 'jɚ',
  is: 'ɪz', it: 'ɪt', its: 'ɪts', you: 'jə', he: 'hi', she: 'ʃi', we: 'wi', me: 'mi',
  i: 'aɪ', in: 'ɪn', on: 'ɑn', not: 'nɑt', no: 'noʊ',
}

/** ARPAbet → IPA（美音）。映射表只在这些音素上做取舍，别自己发明符号。 */
const IPA_OF: Record<string, string> = {
  AA: 'ɑ', AE: 'æ', AO: 'ɔ', AW: 'aʊ', AY: 'aɪ', B: 'b', CH: 'tʃ', D: 'd', DH: 'ð',
  EH: 'ɛ', EY: 'eɪ', F: 'f', G: 'ɡ', HH: 'h', IH: 'ɪ', IY: 'i', JH: 'dʒ', K: 'k',
  L: 'l', M: 'm', N: 'n', NG: 'ŋ', OW: 'oʊ', OY: 'ɔɪ', P: 'p', R: 'ɹ', S: 's', SH: 'ʃ',
  T: 't', TH: 'θ', UH: 'ʊ', UW: 'u', V: 'v', W: 'w', Y: 'j', Z: 'z', ZH: 'ʒ',
}

/** 元音（NAP 里的「拍」就是数它们） */
const VOWELS = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'])

/** 合法的英语音节首（辅音丛）—— 用来把音节边界切对，重音符号才不会落错位置 */
const ONSETS = new Set([
  'pɹ', 'bɹ', 'tɹ', 'dɹ', 'kɹ', 'ɡɹ', 'fɹ', 'θɹ', 'ʃɹ', 'pl', 'bl', 'kl', 'ɡl', 'fl', 'sl',
  'sp', 'st', 'sk', 'sm', 'sn', 'sw', 'tw', 'kw', 'dw', 'spl', 'spɹ', 'stɹ', 'skɹ', 'skw',
])

/** 爆破音 / 阻塞音 —— 失爆与同化的判据 */
const STOPS = new Set(['P', 'B', 'T', 'D', 'K', 'G'])
const OBSTRUENTS = new Set(['P', 'B', 'T', 'D', 'K', 'G', 'F', 'V', 'TH', 'DH', 'S', 'Z', 'SH', 'ZH', 'CH', 'JH'])

interface Phone {
  b: string
  d?: string
}

const parse = (arpa: string): Phone[] =>
  arpa
    .trim()
    .split(/\s+/)
    .map((p) => /^([A-Z]+)([0-2])?$/.exec(p))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ b: m[1]!, d: m[2] }))

/** 词（小写、不含标点）→ 音素序列；查不到就是 null */
function phonesOf(word: string): Phone[] | null {
  const key = word.toLowerCase().replace(/[^a-z'’]/g, '').replace(/’/g, "'")
  if (key === '') return null
  const arpa = (cmu as Record<string, string>)[key]
  if (arpa === undefined) return null
  const p = parse(arpa)
  return p.length > 0 ? p : null
}

/** 最长合法音节首（从后往前取） */
function longestOnset(cons: string[]): string {
  for (let take = Math.min(3, cons.length); take >= 1; take--) {
    const cand = cons.slice(cons.length - take).join('')
    if ((take === 1 && cand !== 'ŋ') || ONSETS.has(cand)) return cand
  }
  return ''
}

/**
 * 音素序列 → 逐拍 IPA（每拍自带重音符号前缀）。
 *
 * ⚠️ 切音节是为了**把 ˈ/ˌ 放对位置**（重音符号要落在重读音节的音节首之前）；
 *    音素层算，不要在渲染字符串上按字符切 —— IPA 里有多字符合并音（tʃ / dʒ / aʊ），
 *    按字符串长度算会把音节切错（踩过：'dʒ'.length === 2，把 n 吃掉）。
 */
function syllablesOfIpa(phones: Phone[]): string[] {
  const nuclei = phones.map((p, i) => (VOWELS.has(p.b) ? i : -1)).filter((i) => i >= 0)
  const out: string[] = []
  for (let k = 0; k < nuclei.length; k++) {
    const n = nuclei[k]!
    const cons = phones.slice(k === 0 ? 0 : nuclei[k - 1]! + 1, n).map((p) => IPA_OF[p.b] ?? '')
    const onset = k === 0 ? cons.join('') : longestOnset(cons)
    let coda = ''
    if (k + 1 < nuclei.length) {
      const between = phones.slice(n + 1, nuclei[k + 1]!).map((p) => IPA_OF[p.b] ?? '')
      coda = between.slice(0, between.length - longestOnset(between).length).join('')
    } else {
      coda = phones.slice(n + 1).map((p) => IPA_OF[p.b] ?? '').join('')
    }
    const p = phones[n]!
    const nucleus =
      p.b === 'AH' ? (p.d === '0' || p.d === undefined ? 'ə' : 'ʌ')
      : p.b === 'ER' ? (p.d === '0' || p.d === undefined ? 'ɚ' : 'ɝ')
      : (IPA_OF[p.b] ?? '')
    out.push((p.d === '1' ? 'ˈ' : p.d === '2' ? 'ˌ' : '') + onset + nucleus + coda)
  }
  return out
}

/** 整词的标准 IPA（**不带音节点**，就是词典那个写法）；查不到给空串 */
export function ipaOf(word: string, weak: boolean): string {
  const key = word.toLowerCase().replace(/[^a-z'’]/g, '')
  if (weak && WEAK_IPA[key] !== undefined) return '/' + WEAK_IPA[key] + '/'
  const phones = phonesOf(word)
  if (!phones) return ''
  const out = syllablesOfIpa(phones).join('')
  /**
   * ⚠️ 弱读词但弱读表里没有它 ⇒ 用词典形，但**去掉重音符号**：
   *    既然是 `stress = -1`（这句里弱读），音标却顶着 ˈ，两者就自相矛盾了
   *    （踩过：which 显示 /ˈwɪtʃ/ 却被标成弱读）。
   */
  return '/' + (weak ? out.replace(/[ˈˌ]/g, '') : out) + '/'
}

/** 主重音在第几拍（从 1 数）；没有多拍或查不到就是 null */
function primaryBeat(word: string): number | null {
  const phones = phonesOf(word)
  if (!phones) return null
  const syl = syllablesOfIpa(phones)
  if (syl.length < 2) return null
  const i = syl.findIndex((s) => s.includes('ˈ'))
  return i >= 0 ? i + 1 : null
}

/**
 * 拼写分拍（**甲：按拼写惯例切**）。
 *
 * ⚠️⚠️ 用的是连字符词典（hyphen 自带 TeX 的英文模式），所以结果是 in-ter-est-ing 这种
 *    **拼写惯例**的切法，不是按发音拍切 —— 两者块数**可能不同**（interesting 4 块 / 发音 3 拍），
 *    用户 2026-09 明确要的就是拼写这一种。
 * ⚠️ 短词常常切不开（TeX 模式有最小长度限制），切不开就给 `[text]`（整词一拍），**不硬切**。
 * ⚠️ 标点附在最后一拍，保证不变量 `syllables.join('') === text`。
 */
export function spellingSyllables(text: string): string[] {
  const letters = text.replace(/^[^a-zA-Z]+/, '')
  const head = text.slice(0, text.length - letters.length)
  const tail = /[^a-zA-Z]*$/.exec(letters)?.[0] ?? ''
  const core = letters.slice(0, letters.length - tail.length)
  if (core === '') return [text]
  let parts: string[]
  try {
    parts = String(hyphenateSync(core, { hyphenChar: '-' }))
      .split('-')
      .filter(Boolean)
  } catch {
    parts = [core]
  }
  // ⚠️ 大小写：按小写切会丢掉原词的大小写 ⇒ 用原词的字符按同样的长度切回来
  if (parts.length <= 1) {
    const out = [head + core + tail].filter((s) => s !== '')
    return out.length > 0 ? out : [text]
  }
  const rebuilt: string[] = []
  let at = 0
  for (const p of parts) {
    rebuilt.push(core.slice(at, at + p.length))
    at += p.length
  }
  if (at < core.length) rebuilt[rebuilt.length - 1] += core.slice(at)
  rebuilt[0] = head + rebuilt[0]!
  rebuilt[rebuilt.length - 1] += tail
  return rebuilt
}

/** 词级发音技巧（规则 + 模板，最多两条，给用户看的一句话） */
function tipOf(text: string, phones: Phone[] | null, stress: ArticleWordStress, syllables: string[]): string {
  if (stress === -1) return '功能词：轻读、含糊带过'
  const parts: string[] = []
  const beat = primaryBeat(text)
  if (beat !== null && beat <= syllables.length) parts.push('主重音在第 ' + beat + ' 拍')
  if (phones) {
    // ⚠️ 只看**最后一个元音之后**的辅音 —— 原来的 slice(-3) 会把元音之前的辅音也算进来
    //    （Frown /fɹaʊn/ 被误判成"词尾辅音丛"，其实词尾只有 n）
    let lastVowel = -1
    for (let i = phones.length - 1; i >= 0; i--) if (VOWELS.has(phones[i]!.b)) { lastVowel = i; break }
    const coda = lastVowel >= 0 ? phones.slice(lastVowel + 1) : []
    if (coda.length >= 2) parts.push('词尾辅音连着收，别加元音')
    if (phones.some((p) => p.b === 'TH' || p.b === 'DH')) parts.push('th 要咬舌尖')
  }
  return parts.length > 0 ? parts.join('；') : ''
}

/**
 * 词间连读（规则 + 模板）。
 *
 * ⚠️ `pauses` 是**音频给出的否决**：那两词之间真的停了（>150ms）就一定没连读 ——
 *    规则只看音素，判不出"这里其实断开了"。这是音频在整条链路里唯一的作用。
 */
function linkTip(
  a: { text: string; phones: Phone[] | null },
  b: { text: string; weak: boolean; phones: Phone[] | null },
): { kind: string; tip: string } | null {
  const pa = a.phones
  const pb = b.phones
  if (!pa || !pb || pa.length === 0 || pb.length === 0) return null
  const la = pa[pa.length - 1]!
  const fb = pb[0]!
  const weakNote = b.weak && WEAK_IPA[b.text] !== undefined ? '；' + b.text + ' 弱读成 /' + WEAK_IPA[b.text] + '/' : ''
  if ((la.b === 'T' || la.b === 'D') && fb.b === 'Y') return { kind: 'assim', tip: 't / d 遇上 you 合成一个音' + weakNote }
  if (la.b === 'T' && VOWELS.has(fb.b) && fb.d !== '1') return { kind: 'flap', tip: '美音里这里的 t 变成很轻的 /ɾ/（像汉语的 d）' + weakNote }
  if (VOWELS.has(la.b) && VOWELS.has(fb.b)) return { kind: 'glide', tip: '两个元音相接，中间自然带一个很轻的滑音' + weakNote }
  if (STOPS.has(la.b) && OBSTRUENTS.has(fb.b)) return { kind: 'stop', tip: '词尾爆破音只做口型不出声，停住再念下一个词' + weakNote }
  // ⚠️ 纯 C+V 连读：**返回 null**（不标）。它是连读语流里的默认行为，每个边界都会发生
  //    （实测 18 个词界里 8 个），全标出来等于符号失去信息量 —— 见 buildWordInfo 的说明。
  return null
}

export interface WordInfoInput {
  /** 纠错**之后**的正文（id 就是按它算的） */
  text: string
  /**
   * 句中释义：**词 → 中文**（LLM 从 ECDICT 义项里挑的，见 article-meta.ts 的 SYSTEM）。
   * ⚠️ 不是每个词都有；没有就给空串。
   */
  meanings?: Map<string, string>
}

export interface WordInfo {
  words: ArticleWordItem[]
  links: string[]
}

/**
 * ⭐ 把词表写进正文 JSON 的 `words` / `links` —— **唯一写入方**。
 *
 * ⚠️ 只改这两个字段，其它字段原样带回（正文一个字都不动 ⇒ id 不变）。
 * ⚠️ 为什么写进正文 JSON：客户端渲染朗读页要的就是它，而正文 JSON 已经会随内容
 *    一起发布 / 缓存（服务端 /api/articles/:id 透传），多一个文件就多一处会掉队的东西。
 */
export async function applyWordInfo(articleId: string, info: WordInfo): Promise<void> {
  const { readFile, writeFile } = await import('node:fs/promises')
  const { resolve } = await import('node:path')
  const { contentPathOf } = await import('@jushuo/shared')
  const root = (await import('../../../env.mjs')).ROOT
  const p = resolve(root, contentPathOf(articleId).replace(/^\/+/, ''))
  const j = JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
  j.words = info.words
  j.links = info.links
  await writeFile(p, JSON.stringify(j, null, 2) + '\n')
}

/**
 * 正文 → 词表 + 连读标注。
 *
 * ⚠️ 永远返回 `words.length === plainWordsOf(text).length`、`links.length === words.length - 1`：
 *    条数对不上就会「点这个词、看那个词的诊断」，宁可数据空也不能错位。
 */
export function buildWordInfo(input: WordInfoInput): WordInfo {
  const tokens = plainWordsOf(input.text)
  const meanings = input.meanings ?? new Map<string, string>()

  // ① 先判定句重音：功能词 = -1；其余 = 0；**最后一个实词** = 1（英语的默认中性句重音）
  const isFunc = tokens.map((t) => FUNCTION_WORDS.has(t.toLowerCase().replace(/[^a-z'’]/g, '')))
  const lastContent = isFunc.lastIndexOf(false)
  const stress = tokens.map((_, i): ArticleWordStress => {
    if (isFunc[i]) return -1
    return i === lastContent ? 1 : 0
  })

  const words: ArticleWordItem[] = tokens.map((t, i) => {
    const weak = stress[i] === -1
    const phones = isFunc[i] ? null : phonesOf(t)
    const syllables = spellingSyllables(t)
    const key = t.toLowerCase().replace(/[^a-z'’]/g, '')
    return {
      text: t,
      stress: stress[i]!,
      syllables,
      ipa: ipaOf(t, weak),
      meaning: meanings.get(key) ?? '',
      tip: tipOf(t, phones, stress[i]!, syllables),
    }
  })

  /**
   * ⚠️ 这里**只按音素规则判**连读，没有用音频的"词间真实停顿"做否决 ——
   *    否决要等音频产出之后才有数据（见 audio-assets.ts 返回的 alignment），
   *    而那一步在这之后。实测那次间隙数据（400ms 量级 = 真停）说明它有价值，
   *    但为了「一份数据一个写入方」，这一版先不接。**已知的待改进项。**
   * ⚠️⚠️ 只标**非默认**的音变（闪音 / 同化 / 加音 / 失爆）：
   *    纯 C+V 连读在连读语流里几乎每个边界都会发生（实测 18 个词界里有 8 个），
   *    全标出来等于整句都是符号、符号就没有信息量了。C+V 是"连起来念"的默认要求，
   *    不标它不表示"不要连"。
   */
  const links: string[] = []
  for (let i = 0; i + 1 < tokens.length; i++) {
    const bText = tokens[i + 1]!.toLowerCase().replace(/[^a-z'’]/g, '')
    const hit = linkTip(
      { text: tokens[i]!, phones: phonesOf(tokens[i]!) },
      { text: bText, weak: stress[i + 1] === -1, phones: phonesOf(tokens[i + 1]!) },
    )
    links.push(hit?.tip ?? '')
  }

  return { words, links }
}
