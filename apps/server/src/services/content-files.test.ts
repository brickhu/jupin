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
   * ⭐ 给用户看的话现在**分成两句**（用户 2026-09 定的）：
   *    challenge（挑战宣言）= 判决 + 依据，**兼作分享卡标题**；
   *    advice（朗读建议）= 把挑战**框小**（真难的只有这几点，攻下来就顺了）。
   *
   * ⚠️⚠️ 下面几条钉的是**挑战心态**（用户 2026-09 直接指出的）：
   *    旧格式是「相当于<级别>水平，<发音难点>；<词汇与句式点评>」—— 那是个**评测报告**：
   *      · 开头贴水平标签：级别已经由档位徽章给用户了，再贴一遍是冗余；
   *        而且真读砸了，感受会变成「连初中水平都不如」；
   *      · 结尾「词都很常见 / 词都很简单」在**替用户宣布"没什么好挑战的"**——
   *        实测 8 条里 5 条这样收尾，挑战心态就是从这半句泄掉的。
   *    ⇒ 现在分工是：challenge **认账它难**，advice **把难度框小**。
   *
   * ⚠️ 只拦**总结式的盖章**（"词都很常见"），不拦**反差铺垫**——
   *    "看着像儿歌，读顺依然不简单" 是用户自己给的例子，别把"简单"两个字一并封掉。
   *
   * ⚠️ 也拦**不可验证的承诺**（"直逼母语者水平"）：用户读完立刻会看到自己的分数，
   *    承诺越大，被当场打脸的概率越高。收益要**就近可验证**（"一气呵成"）。
   *
   * ⚠️ **故意不设正向断言**（比如"challenge 必须含'母语者'"）：
   *    两句都是自然语言，正则会误杀好文案；具体写法只由提示词 + 人工评审兜住。
   */
  it('⭐ 挑战宣言 + 朗读建议：不给水平标签、不泄气、不许诺做不到的事', async () => {
    for (const [file, raw] of await loadAll()) {
      /* ---------- challenge：判决 + 依据，兼分享卡标题 ---------- */
      const challenge = raw.challenge
      expect(typeof challenge, file + ' 的 challenge 应当是字符串').toBe('string')
      expect(String(challenge).trim(), file + ' 的 challenge 为空').not.toBe('')
      /**
       * ⚠️ 18 字**不是排版偏好，是分享卡标题的硬约束**：
       *    客户端拼成「朗读挑战:」+ challenge，卡片标题两行约 25 字（13 字 + 12 字后省略）。
       *    这里与提示词、regrade 的 CHALLENGE_MAX_CHARS 是**同一根线**。
       */
      expect(
        String(challenge).length,
        file + ' 的 challenge 太长（≤18 字，否则分享卡标题会被省略号吃掉）',
      ).toBeLessThanOrEqual(18)
      // ⚠️ 它要当标题：末尾带句号很难看（标点由客户端拼）
      expect(String(challenge), file + ' 的 challenge 不该带末尾标点（它要当标题）').not.toMatch(/[。！？.!?]$/)

      /* ---------- advice：把挑战框小 ---------- */
      const advice = raw.advice
      expect(typeof advice, file + ' 的 advice 应当是字符串').toBe('string')
      expect(String(advice).trim(), file + ' 的 advice 为空').not.toBe('')

      /* ---------- 两句共用的黑名单 ---------- */
      for (const [name, value] of [['challenge', challenge], ['advice', advice]] as const) {
        const s = String(value)
        expect(s, file + ' 的 ' + name + ' 不该出现水平标签（级别由徽章给）').not.toMatch(
          /小学|初中|高中|大学四级|六级|考研|GRE|级水平/,
        )
        expect(s, file + ' 的 ' + name + ' 不该用「词都很常见」这类话替用户泄气').not.toMatch(
          /词都很常见|词都很简单|词都常见|词都简单|句子很短|字都不难/,
        )
        expect(s, file + ' 的 ' + name + ' 不该许诺不可验证的结果（读完就能看到分数，会被打脸）').not.toMatch(
          /直逼母语|母语者水平|母语水平|口语暴涨|秒变地道|彻底掌握/,
        )
      }

      /**
       * ⚠️ advice 的 100 字与提示词、regrade 的 ADVICE_MAX_CHARS 是**同一根线**。
       *    这个数是**量出来的**：按"别轻敌 + 三处坑 + 口语收尾"写，9 条落在 87–99；
       *    收到 90 只会逼着砍掉第三处坑（试过，5 条要手改）。
       */
      expect(String(advice).length, file + ' 的 advice 太长（提示词要求 ≤100 字）').toBeLessThanOrEqual(100)
    }
  })

  /**
   * ⭐ **开场白必须跟档位一致**（用户 2026-09 指出的）。
   *
   * ⚠️ 用户的原话是「简单句就不要用'别怕'了吧」—— 这句话是两个字段之间的**自相矛盾**：
   *    初级 / 中级的 challenge 刚说"这句像儿歌，读顺依然不简单"，
   *    advice 立刻接"别怕" —— 本来就没东西好怕，用户会觉得你在糊弄他。
   *    ⇒ 那一档该**提醒别轻敌**（"别轻敌""别一带而过"），而不是安抚。
   *
   * ⚠️ 反过来也一样：高级 / 专家的 challenge 刚认账"这句是真硬"，
   *    advice 再说"别轻敌"就是没读懂自己的上一句。
   *
   * ⚠️ 口径只拦**情绪词**（别怕 / 别慌 / 别轻敌 / 别大意），不拦"别一个词一顿"
   *    这类**动作提醒** —— 后者两档都要说。
   */
  it('⭐ 档位姿态：初级/中级必须「提醒别轻敌」，高级/专家才安抚', async () => {
    /**
     * ⚠️ 这张表与提示词里那张是**同一根线**（改一处就要改另一处）。
     *
     * ⚠️ 这是本文件里**唯一一条"正向"断言**，理由：它管的是**开场姿态**，
     *    不是文案内容 —— 允许集故意放宽（七种提醒说法 + "坑/陷阱"），
     *    真正要拦的只有两种：**安抚**（别怕）和**中性开场**（"真难的就三处…"）。
     *    ⚠️ 用户 2026-09 把口径从"不许说别怕"收紧成"**必须**提醒别轻敌"。
     *
     * ⚠️ 只看**第一小句**（到第一个标点为止）—— 管的是开场；
     *    也不拦"别一个词一顿"这类**动作提醒**，那是两档都要说的。
     */
    const MUST_WARN = /别轻敌|别大意|别小看|别轻视|别忽略|别一带而过|别被[^，。；,;]{0,8}骗|坑|陷阱/
    for (const [file, raw] of await loadAll()) {
      const level = normalizeLevel(raw.difficulty)
      if (level === null) continue
      const advice = String(raw.advice ?? '')
      const opening = advice.split(/[，。；：,;:]/)[0] ?? ''
      if (level <= 1) {
        expect(
          opening,
          file + ' 是初级/中级，advice 开场必须提醒「别轻敌」这一类（实测开场：' + opening + '）',
        ).toMatch(MUST_WARN)
        expect(advice, file + ' 是初级/中级，advice 不该说「别怕」（上一句刚说它像儿歌）').not.toMatch(
          /别怕|不用怕|别慌/,
        )
      } else {
        expect(advice, file + ' 是高级/专家，advice 不该说「别轻敌 / 别大意」（上一句刚认账它硬）').not.toMatch(
          /别轻敌|别大意/,
        )
      }
    }
  })

  /**
   * ⭐ **反模板**（用户 2026-09 提的）：收益的**落点**可以都是口语，但**说法必须各是各的**。
   *
   * ⚠️ 实测教训：三拍提示词第一版发出去，9 条里 8 条是「这两处顺了，一开口就…」同一个句尾 ——
   *    字面要求满足了、冲动没了，用户读到第三条就腻。
   *    **硬规则不给反面约束，模型就用模板去满足它。**
   *
   * ⚠️ 口径：**advice 的末拍起手式（前 4 字）最多覆盖 1/3 的文案**。
   *    放到 1/3 是因为起手式本来就有自然重合（"真正的…"），真要拦的是「8/9 一模一样」。
   *
   * ⚠️ challenge 那侧**故意不设硬断言**：它 ≤18 字、又只需判"硬 / 看着简单"两种，
   *    撞车几乎必然（"这句是真硬"就是用户自己给的例子，那不算错）。
   *    那里只靠提示词"换着说" + 人审 —— 用断言去钉只会逼模型绕开正确的写法。
   */
  it('⭐ 反模板：advice 末拍的起手式不许撞车（同一句式最多覆盖 1/3）', async () => {
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
