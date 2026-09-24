import { existsSync, readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { mp3DurationMs } from './mp3-duration'
import {
  ARTICLE_ID_LENGTH,
  plainWordsOf,
  MAX_ARTICLE_TAGS,
  MAX_ARTICLE_TAG_CHARS,
  difficultyFromScores,
  normalizeLevel,
  normalizeScores,
  normalizeTags,
} from '@jushuo/shared'
import { resolveStaticRoot } from './content'

/**
 * 正文静态 JSON 的内容校验。
 *
 * ⚠️ 为什么值得单独测仓库里这几份 JSON：**它们不是代码，tsc 看不见它们**。
 *    档位写错、标签写重复、标签前后带空格，构建与类型检查全都不会吭声 ——
 *    只能靠这道校验出声。
 *
 * ⚠️ 难度档位必须在场：它是**一个**由词汇 / 发音 / 长度合成的值（见 shared/level.ts）。
 *    三个判据分也记在正文里（scores）—— **就是为了让这里能验算**：
 *    difficulty 必须能由 scores 按公式算回来（模型自己算加权是会算错的）。
 *
 * ⚠️ 走 resolveStaticRoot() 而不是自己拼路径：顺带证明了正文目录在
 *    容器与本机两种 cwd 下都能解析到（那段路径踩过坑，见 content.ts）。
 */
const dir = join(resolveStaticRoot() ?? '', 'content/articles')

describe('content/articles/*.json', () => {
  it('难度档位必须在场，且是四档之一（0 初级 / 1 中级 / 2 高级 / 3 专家）', async () => {
    for (const [file, raw] of await loadAll()) {
      expect(normalizeLevel(raw.difficulty), file + ' 的 difficulty').not.toBeNull()
      // ⚠️ 旧的「两条轴各一个字段」不许回来（B20 废弃）：对外只有 difficulty + reason
      expect(raw.vocabLevel, file + ' 还留着 vocabLevel（已废弃，见 B20）').toBeUndefined()
      expect(raw.pronLevel, file + ' 还留着 pronLevel（已废弃，见 B20）').toBeUndefined()
    }
  })

  /**
   * ⭐ 判据分记下来是为了**能被验算**：difficulty 必须等于 difficultyFromScores(scores)。
   *
   * ⚠️ 这是「模型把加权算错」这类错的**唯一出口** —— 徽章从「高级」变成「专家」
   *    不会有任何别的地方报错，而正文里 difficulty 和 scores 是互相矛盾的。
   * ⚠️ 公式与权重一律取自 shared（唯一真相），**不在这里手算一遍** ——
   *    否则调权重时这条测试会跟着一起错，等于没测。
   */
  it('三个判据分 [词汇, 发音, 长度] 在场，且 difficulty 能由它算回来', async () => {
    for (const [file, raw] of await loadAll()) {
      const scores = normalizeScores(raw.scores)
      expect(scores, file + ' 的 scores 不是 1–5 的三元组').not.toBeNull()
      expect(difficultyFromScores(scores), file + ' 的 difficulty 与 scores 算出来的对不上').toBe(raw.difficulty)
    }
  })

  it('⭐ 一句话（难在哪）必须以「相当于…水平」开头 —— 它是给用户看的文案，不是审核术语', async () => {
    for (const [file, raw] of await loadAll()) {
      const reason = raw.reason
      expect(typeof reason, file + ' 的 reason 应当是字符串').toBe('string')
      expect(String(reason).trim(), file + ' 的 reason 为空').not.toBe('')
      // 格式：相当于<级别>水平，<发音难在哪>；<词汇与句式点评>
      expect(String(reason), file + ' 的 reason 没以「相当于…水平」开头').toMatch(/^相当于.+水平[，,]/)
      expect(String(reason), file + ' 的 reason 缺少分号后的词汇点评').toContain('；')
      // ⚠️ 提示词要求 ≤45 字，这里是**网**不是规格：给模型留一点漂移的余量，
      //    但 60 已经远超「卡片上一行小字」的容量 —— 撞到它说明提示词没被遵守。
      expect(String(reason).length, file + ' 的 reason 太长（提示词要求 ≤45 字）').toBeLessThanOrEqual(60)
    }
  })

  it('标签是短、不重复、已 trim 的字符串数组', async () => {
    for (const [file, raw] of await loadAll()) {
      expect(Array.isArray(raw.tags), file + ' 的 tags 应当是数组').toBe(true)
      const tags = raw.tags as string[]
      // ⚠️ 与规范化结果逐项相等 = 没有被吃掉的东西（空串 / 重复 / 首尾空格 / 非字符串）
      expect(normalizeTags(tags), file + ' 的 tags 规范化后应无变化').toEqual(tags)
      expect(tags.length, file + ' 的标签个数').toBeLessThanOrEqual(MAX_ARTICLE_TAGS)
      for (const tag of tags) {
        expect(tag.length, file + ' 的标签「' + tag + '」太长').toBeLessThanOrEqual(MAX_ARTICLE_TAG_CHARS)
      }
    }
  })

  it('每个词的播放区间都够长 —— 弱读虚词不能只剩静音', async () => {
    for (const [file, raw] of await loadAll()) {
      const words = raw.words as { word: string; startMs: number; endMs: number }[] | undefined
      // ⚠️ 老内容还没有 words（流水线 ④ 没跑过）—— 那种情况下端侧退回预切切片，不算错
      if (!words || words.length === 0) continue
      // ⚠️ 用**唯一的切词实现**来核对：这条断言的意思是「写的 words 就是客户端会切出来的那些」，
      //    自己再抄一份 split 规则只会让两者一起漂
      const expected = plainWordsOf(String(raw.text))
      expect(words.length, file + ' 的 words 条数应与词数一致').toBe(expected.length)
      for (let i = 0; i < words.length; i++) {
        const w = words[i]!
        expect(w.word, file + ' 第 ' + i + ' 个词与正文对不上').toBe(expected[i])
        expect(w.startMs, file + ' 的区间为负').toBeGreaterThanOrEqual(0)
        /**
         * ⚠️⚠️ 这条守的是实测出来的一类错：引擎对弱读虚词（the / to / is）给的边界
         *    经常落在**停顿**上 —— "Don't count the days…" 里那个 the 给到 [0.72,0.80]，
         *    而这段音频 0.74–0.79 是数字静音（RMS 1.3% 峰值），剥出来只剩一声空响。
         *    所以区间必须有不短于 300ms 的下限（见 audio-assets 的 wordRangesOf）。
         */
        expect(w.endMs - w.startMs, file + ' 第 ' + i + ' 个词（' + w.word + '）的区间太短').toBeGreaterThanOrEqual(300)
      }
    }
  })

  /**
   * ⭐ 时间戳是「点词从哪播到哪」的唯一依据，所以它必须落在音频**里面**。
   *
   * ⚠️⚠️ 这条守的是当初那个真实 bug 的同类：引擎对弱读虚词给的边界落在停顿上，
   *    一个词的区间可能只有 80ms（"the"），甚至贴着音频末尾 ——
   *    表现是「点了没声音 / 播出来是空白」，而没有任何报错。
   *    区间下限由 wordRangesOf 保证（上面那条用例），这里补的是**上界**。
   */
  it('词级时间戳不能超出音频本体', async () => {
    const audioDir = join(resolveStaticRoot() ?? '', 'content/audio')
    for (const [file, raw] of await loadAll()) {
      const words = raw.words as { word: string; startMs: number; endMs: number }[] | undefined
      if (!words || words.length === 0) continue

      const id = String(raw.id)
      const mp3 = join(audioDir, id + '.mp3')
      /**
       * ⚠️ 「有 words 但没有 mp3」不是可以跳过的情况：时间戳指向一份不存在的音频，
       *    点词播放必然失败。老内容没 words 才允许退回预切切片 —— 反过来不行。
       */
      expect(existsSync(mp3), file + ' 有词级时间戳，却没有 content/audio/' + id + '.mp3').toBe(true)

      const durationMs = mp3DurationMs(readFileSync(mp3))
      expect(durationMs, file + ' 的 mp3 解析不出时长').not.toBeNull()

      const maxEnd = Math.max(...words.map((w) => w.endMs))
      // ⚠️ 留 120ms 余量：mp3 按帧计，最后一帧的时长会略长于最后一个词的结束点
      expect(
        maxEnd,
        file + ' 的最后一个词结束于 ' + maxEnd + 'ms，超过音频时长 ' + durationMs + 'ms',
      ).toBeLessThanOrEqual(durationMs! + 120)
    }
  })

  /**
   * ⚠️ 长度也要守：id 同时是**文件名、主键、音频路径**，
   *    而长度定义在 shared 的 ARTICLE_ID_LENGTH（schema 的列宽也用它）——
   *    这里写死数字就只能证明「没变」，证明不了「三处一致」。
   */
  it('id 是 ARTICLE_ID_LENGTH 位十六进制', async () => {
    for (const [file, raw] of await loadAll()) {
      expect(String(raw.id), file + ' 的 id 长度').toHaveLength(ARTICLE_ID_LENGTH)
      expect(String(raw.id), file + ' 的 id 含非十六进制字符').toMatch(/^[0-9a-f]+$/)
    }
  })

  it('id 与文件名一致，且正文/译文都不为空', async () => {
    const all = await loadAll()
    expect(all.length).toBeGreaterThan(0)
    for (const [file, raw] of all) {
      // ⚠️ file 是带目录前缀的（报错信息里要能直接看出是哪一份），所以只取文件名比 id
      const name = file.slice(file.lastIndexOf('/') + 1).replace('.json', '')
      expect(String(raw.id), file + ' 的 id 与文件名对不上').toBe(name)
      expect(String(raw.text).length, file + ' 的正文为空').toBeGreaterThan(0)
      expect(String(raw.translation).length, file + ' 的译文为空').toBeGreaterThan(0)
    }
  })
})

async function loadAll(): Promise<[string, Record<string, unknown>][]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()
  const out: [string, Record<string, unknown>][] = []
  for (const f of files) {
    out.push(['content/articles/' + f, JSON.parse(await readFile(join(dir, f), 'utf8'))])
  }
  return out
}
