import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
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
      // ⚠️ 旧的「两条轴各一个字段」不许回来（B20 废弃）：对外只有 difficulty + advice
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

  /**
   * ⭐ 「朗读建议及收益」（advice）的职责是**让人想张嘴念一遍** ——
   *    三拍：①预期差（why）②动作（how）③收益，③落在「口语」上。
   *
   * ⚠️⚠️ 下面几条钉的是**挑战心态**（用户 2026-09 直接指出的）：
   *    旧格式是「相当于<级别>水平，<发音难点>；<词汇与句式点评>」—— 那是个**评测报告**：
   *      · 开头贴水平标签：级别已经由档位徽章给用户了，再贴一遍是冗余；
   *        而且真读砸了，感受会变成「连初中水平都不如」；
   *      · 结尾「词都很常见 / 词都很简单」在**替用户宣布"没什么好挑战的"**——
   *        实测 8 条里 5 条这样收尾，挑战心态就是从这半句泄掉的。
   *    ⇒ 现在它只做一件事：给一个**能立刻验证的动作** + 「看着简单，其实有坑」的反差。
   *
   * ⚠️ 只拦**总结式的盖章**（"词都很常见"），不拦**反差铺垫**——
   *    "看着像儿童读物，可…" 是允许的（用户明确认可的写法），所以别把"简单"两个字一并封掉。
   *
   * ⚠️ 也拦**不可验证的承诺**（"直逼母语者水平"）：用户读完这句话立刻就能看到自己的分数，
   *    承诺越大，被当场打脸的概率越高。收益要**就近可验证**（"说出来不打结"）。
   *
   * ⚠️ **故意不设正向断言**（比如"必须含'口语'二字"）：
   *    advice 是自然语言，正则会误杀好文案（"一开口就是那个味儿"里就没有"口语"）。
   *    ③收益围绕口语这条只由提示词 + 人工评审兜住。
   */
  it('⭐ 朗读建议及收益：不给水平标签、不泄气、不许诺做不到的事 —— 它是邀约，不是评测报告', async () => {
    for (const [file, raw] of await loadAll()) {
      const advice = raw.advice
      expect(typeof advice, file + ' 的 advice 应当是字符串').toBe('string')
      expect(String(advice).trim(), file + ' 的 advice 为空').not.toBe('')
      expect(String(advice), file + ' 的 advice 不该出现水平标签（级别由徽章给）').not.toMatch(
        /小学|初中|高中|大学四级|六级|考研|GRE|级水平/,
      )
      expect(String(advice), file + ' 的 advice 不该用「词都很常见」这类话替用户泄气').not.toMatch(
        /词都很常见|词都很简单|词都常见|词都简单|句子很短|字都不难/,
      )
      expect(String(advice), file + ' 的 advice 不该许诺不可验证的结果（读完就能看到分数，会被打脸）').not.toMatch(
        /直逼母语|母语者水平|母语水平|口语暴涨|秒变地道|彻底掌握/,
      )
      /**
       * ⚠️ 提示词要求 ≤100 字（理想 85–100，够装下三拍），这里就是同一根线 —— **不设更松的网**。
       *    100 字在卡片上约三行；再多就不是「一行小字」了。
       *    （这条线曾经是 80 而提示词写 45，后来又收紧到 60 而三拍根本装不下 ——
       *      规格与网不一致时，模型永远按宽的来。）
       */
      expect(String(advice).length, file + ' 的 advice 太长（提示词要求 ≤100 字）').toBeLessThanOrEqual(100)
    }
  })

  /**
   * ⭐ **反模板**（用户 2026-09 提的）：收益的**落点**可以都是口语，但**说法必须各是各的**。
   *
   * ⚠️ 实测教训：三拍提示词第一版发出去，9 条里 8 条是「这两处顺了，一开口就…」同一个句尾 ——
   *    字面要求满足了、冲动没了，用户读到第三条就腻。
   *    **硬规则不给反面约束，模型就用模板去满足它。**
   *
   * ⚠️ 口径：**同一个末拍起手式（前 4 字）最多覆盖 1/3 的文案**。
   *    放到 1/3 是因为起手式本来就有自然重合（"真正的…"），真要拦的是「8/9 一模一样」。
   */
  it('⭐ 反模板：末拍的起手式不许撞车（同一句式最多覆盖 1/3）', async () => {
    const all = await loadAll()
    const counts = new Map<string, string[]>()
    for (const [file, raw] of all) {
      const parts = String(raw.advice ?? '').split(/[；;。]/).map(s => s.trim()).filter(Boolean)
      const starter = (parts[parts.length - 1] ?? '').slice(0, 4)
      if (starter.length < 4) continue
      counts.set(starter, [...(counts.get(starter) ?? []), file])
    }
    const limit = Math.floor(all.length / 3)
    for (const [starter, files] of counts) {
      expect(
        files.length,
        '末拍起手式「' + starter + '…」有 ' + files.length + ' 条（上限 ' + limit + '）：\n' + files.join('\n'),
      ).toBeLessThanOrEqual(limit)
    }
  })

  it('标签是短、不重复、已 trim 的字符串数组', async () => {
    for (const [file, raw] of await loadAll()) {
      expect(Array.isArray(raw.tags), file + ' 的 tags 应当是数组').toBe(true)
      const tags = raw.tags as string[]
      // ⚠️ 与规范化结果逐项相等 = 没有被吃掉的东西（空串 / 重复 / 首尾空格 / 非字符串）
      expect(normalizeTags(tags), file + ' 的 tags 规范化后应无变化').toEqual(tags)
      expect(tags.length, file + ' 的标签个数').toBeLessThanOrEqual(MAX_ARTICLE_TAGS)
      /**
       * ⚠️⚠️ 标签只许写**主题与体裁**，不许写难度/发音的元描述。
       *
       *    用户 2026-09 直接指出：标签里出现了「发音难点」这种东西。
       *    它和档位徽章、那句「难在哪」、词表里的发音技巧**说的是同一件事**，
       *    当一个标签摆出来就是重复的内部黑话 —— 而且这个词组是提示词自己举例带出来的，
       *    所以光改提示词不够，这里钉一道，防止再漂回去。
       *    ⚠️ 「绕口令」不在黑名单里：它是体裁（说的是"这是绕口令"，不是"这句难"）。
       */
      for (const banned of ['发音难点', '难词', '长词', '短句', '难句', '拗口', '发音', '简单', '容易']) {
        expect(tags.includes(banned), file + ' 的标签不该出现「' + banned + '」（那是难度元描述，不是主题）').toBe(
          false,
        )
      }
      for (const tag of tags) {
        expect(tag.length, file + ' 的标签「' + tag + '」太长').toBeLessThanOrEqual(MAX_ARTICLE_TAG_CHARS)
      }
    }
  })

  /**
   * ⭐ 词表是朗读页逐词渲染与点按的**唯一**数据 —— 它必须与正文严格对齐。
   *
   * ⚠️⚠️ 这条守的是「错位」那一类坏法：词表比正文多/少一个词、或音节拼不回原词。
   *    表现是「点这个词、看到那个词的释义」，而**没有任何报错**。
   * ⚠️ 用**唯一的切词实现**来核对：自己再抄一份 split 规则只会让两者一起漂。
   */
  it('词表与正文一一对应，且每个词的音节能拼回原词', async () => {
    for (const [file, raw] of await loadAll()) {
      type W = { text?: string; stress?: number; syllables?: string[]; ipa?: string; meaning?: string; tip?: string }
      const words = raw.words as W[] | undefined
      // ⚠️ 老内容还没有这套词表 —— 客户端走旧渲染，不算错
      if (!words || words.length === 0) continue
      const expected = plainWordsOf(String(raw.text))
      expect(words.length, file + ' 的 words 条数应与词数一致').toBe(expected.length)
      for (let i = 0; i < words.length; i++) {
        const w = words[i]!
        expect(w.text, file + ' 第 ' + i + ' 个词与正文对不上').toBe(expected[i])
        expect(Array.isArray(w.syllables), file + ' 第 ' + i + ' 个词缺少 syllables').toBe(true)
        /**
         * ⭐ 不变量：拼写分拍拼回来必须**一个字不差**（含标点）。
         * ⚠️ 它是拼接对齐器的验收标准 —— 分拍错一位，音节级的样式就会画在错的字母上。
         */
        expect(w.syllables!.join(''), file + ' 第 ' + i + ' 个词（' + String(w.text) + '）的音节拼不回原词').toBe(expected[i])
        expect([-1, 0, 1], file + ' 第 ' + i + ' 个词的 stress 必须是 -1 / 0 / 1').toContain(w.stress)
        expect(typeof w.ipa, file + ' 第 ' + i + ' 个词的 ipa 应当是字符串').toBe('string')
        expect(typeof w.meaning, file + ' 第 ' + i + ' 个词的 meaning 应当是字符串').toBe('string')
        expect(typeof w.tip, file + ' 第 ' + i + ' 个词的 tip 应当是字符串').toBe('string')
      }
    }
  })

  /**
   * ⭐ `links[i]` 描述 `words[i]` 与 `words[i+1]` 之间 ⇒ 长度必须是 `words.length - 1`。
   *
   * ⚠️ 长度错一位，连读符号就会画在**错误的词界**上 —— 比不画更糟（它会教错）。
   */
  it('links 与词界一一对应（长度 = words.length - 1）', async () => {
    for (const [file, raw] of await loadAll()) {
      const words = raw.words as unknown[] | undefined
      const links = raw.links
      // ⚠️ 老内容没有 links（也没有新词表）—— 那时客户端不画连读符号
      if (links === undefined) continue
      expect(Array.isArray(links), file + ' 的 links 应当是数组').toBe(true)
      expect((links as unknown[]).length, file + ' 的 links 长度应当是 words.length - 1').toBe(
        (words?.length ?? 0) - 1,
      )
      for (const l of links as unknown[]) {
        expect(typeof l, file + ' 的 links 元素应当是字符串（空串 = 不连）').toBe('string')
      }
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
