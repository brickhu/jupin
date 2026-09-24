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
  normalizeDifficulty,
  normalizeTags,
} from '@jushuo/shared'
import { resolveStaticRoot } from './content'

/**
 * 正文静态 JSON 的内容校验。
 *
 * ⚠️ 为什么值得单独测仓库里这几份 JSON：**它们不是代码，tsc 看不见它们**。
 *    难度值写错、标签写重复、标签前后带空格，构建与类型检查全都不会吭声 ——
 *    而难度目前**不对外展示**，写错了连界面都不会变（要等将来按难度筛选，
 *    才会以「少了一句」的形式暴露）⇒ 只能靠这道校验出声。
 *
 * ⚠️ 走 resolveStaticRoot() 而不是自己拼路径：顺带证明了正文目录在
 *    容器与本机两种 cwd 下都能解析到（那段路径踩过坑，见 content.ts）。
 */
const dir = join(resolveStaticRoot() ?? '', 'content/articles')

describe('content/articles/*.json', () => {
  it('难度必须是四档之一（0 初级 / 1 中级 / 2 高级 / 3 专家）', async () => {
    for (const [file, raw] of await loadAll()) {
      expect(normalizeDifficulty(raw.difficulty), file + ' 的 difficulty').not.toBeNull()
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
