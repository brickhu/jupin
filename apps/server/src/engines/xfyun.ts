import crypto from 'node:crypto'
import WebSocket from 'ws'
import { XMLParser } from 'fast-xml-parser'
import type { ScoreDimensions, ScoreEngine, ScoreOptions, ScoreResult, WordScore } from './types'

const HOST = 'ise-api.xfyun.cn'
const PATH = '/v2/open-ise'
const TIMEOUT_MS = 30_000
const FRAME_BYTES = 1280          // 40ms @16k/16bit/mono，官方建议值
const FRAME_INTERVAL_MS = 40      // 模拟实时流

/**
 * 科大讯飞 语音评测（流式版）
 *
 * ⚠️⚠️ 两个必须记住的坑（详见 docs/research/ise-probe-report.md）：
 *
 *  1. 【分制】必须传 ise_unite: '1' 才是百分制。
 *     默认 ise_unite=0 → 返回 0–5 分制（total_score 形如 4.795611），
 *     所有阈值判断都会失效。这是 v1 项目能力分恒为 0 的根因。
 *
 *  2. 【文档】网上易搜到的《语音评测 API 文档》是**普通版**（已下线），
 *     其示例分制与流式版不同。照它写代码会踩坑。
 *
 * ⚠️ 已知限制：实测**没有任何中间结果**（116 帧全空），
 *    status=2 时才一次性返回完整 XML。"流式"指的是流式上传，不是流式返回。
 */
export class XfyunEngine implements ScoreEngine {
  readonly name = 'xfyun'

  constructor(
    private readonly cfg: { appId: string; apiKey: string; apiSecret: string },
  ) {}

  async score({ refText, audio, category = 'read_sentence' }: ScoreOptions): Promise<ScoreResult> {
    return this.parse(await this.rawScore({ refText, audio, category }))
  }

  /**
   * ⭐ 只跑评测、**原样返回 XML**，不做任何解析。
   *
   * ⚠️ 为什么值得单独暴露出来：讯飞返回的字段远多于我们当前用到的，
   *    而**字段到底挂在哪一级节点上**（rec_paper / sentence / word）光看文档说不准 ——
   *    文档本身还有普通版/流式版之分（见本文件顶部的坑 2）。
   *    想新接一个维度，正确做法是先把它 dump 出来看一眼，而不是照着文档猜。
   *    脚本：apps/server/scripts/dump-ise-xml.ts
   */
  async rawScore({ refText, audio, category = 'read_sentence' }: ScoreOptions): Promise<string> {
    return this.request(refText, audio, category)
  }

  /** 建立 WebSocket 会话，流式上传音频，等待 status=2 的完整结果 */
  private request(refText: string, audio: Uint8Array, category: string): Promise<string> {
    const url = this.buildAuthUrl()

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      let acc = ''
      let settled = false
      let aus = 1
      let offset = 0
      let timer: ReturnType<typeof setTimeout> | undefined

      const done = (err?: Error, result?: string): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        try { ws.close() } catch { /* ignore */ }
        err ? reject(err) : resolve(result as string)
      }

      timer = setTimeout(() => done(new Error('讯飞 ISE 超时')), TIMEOUT_MS)

      ws.on('open', () => {
        // 首帧：参数上传（cmd=ssb）
        ws.send(JSON.stringify({
          common: { app_id: this.cfg.appId },
          business: buildBusinessParams(category, refText),
          data: { status: 0 },
        }))

        const pump = (): void => {
          if (offset >= audio.length) {
            // 结束帧
            ws.send(JSON.stringify({
              common: { app_id: this.cfg.appId },
              business: { aus: 4, cmd: 'auw', aue: 'raw' },
              data: { status: 2, data: '' },
            }))
            return
          }
          const end = Math.min(offset + FRAME_BYTES, audio.length)
          const chunk = Buffer.from(audio.subarray(offset, end))
          ws.send(JSON.stringify({
            common: { app_id: this.cfg.appId },
            business: { aus, cmd: 'auw', aue: 'raw' },
            data: { status: 1, data: chunk.toString('base64') },
          }))
          aus = 2
          offset = end
          setTimeout(pump, FRAME_INTERVAL_MS)
        }
        pump()
      })

      ws.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString('utf8'))
        if (msg.code !== 0) {
          done(new Error(`讯飞 ISE 错误 ${msg.code}: ${msg.message}`))
          return
        }
        if (msg.data?.data) {
          acc += Buffer.from(msg.data.data, 'base64').toString('utf8')
        }
        if (msg.data?.status === 2) done(undefined, acc)
      })

      ws.on('error', (err) => done(new Error(`讯飞 ISE 连接错误: ${err.message}`)))
      ws.on('close', (code) => {
        if (!settled) done(new Error(`讯飞 ISE 连接关闭 (code=${code})`))
      })
    })
  }

  /** HMAC-SHA256 鉴权 URL */
  private buildAuthUrl(): string {
    const date = new Date().toUTCString()
    const origin = `host: ${HOST}\ndate: ${date}\nGET ${PATH} HTTP/1.1`
    const signature = crypto
      .createHmac('sha256', this.cfg.apiSecret)
      .update(origin, 'utf8')
      .digest('base64')
    const authorization =
      `api_key="${this.cfg.apiKey}", algorithm="hmac-sha256", ` +
      `headers="host date request-line", signature="${signature}"`
    const authB64 = encodeURIComponent(Buffer.from(authorization, 'utf8').toString('base64'))
    return `wss://${HOST}${PATH}?authorization=${authB64}&date=${encodeURIComponent(date)}&host=${HOST}`
  }

  /** 解析 XML 结果 */
  private parse(xml: string): ScoreResult {
    return parseIseXml(xml)
  }
}

/**
 * ⭐ ISE 首帧（参数上传）的 business 段。
 *
 * ⚠️ 单独抽成函数，唯一目的是**能被单测钉住** —— 这里每一个值都对应一次踩过的坑，
 *    而且全是「少传一个、分数就悄悄变样、但一声不吭」的类型：
 *
 *   · `ise_unite: '1'`    默认是 0 → 返回 0–5 分制（形如 4.795611）。
 *     这是 v1 项目「能力分恒为 0」的根因。
 *     ⚠️ 实测确认：**0–100 的区间断言拦不住它** —— 4.79 本身就落在 0–100 内。
 *        所以真正的防线只有「参数必须传对」，也就是下面这几条测试。
 *   · `extra_ability`     不传 → 不返回准确度/流利度/标准度/完整度四维分
 *   · `aue`/`auf`         不符 → 被判「乱读」，且分值不可参考
 *   · `text` 的 BOM + [content]  read_sentence 必需
 */
export function buildBusinessParams(category: string, refText: string) {
  return {
    aue: 'raw',
    auf: 'audio/L16;rate=16000',
    category,
    cmd: 'ssb',
    ent: 'en_vip',
    sub: 'ise',
    tte: 'utf-8',
    rstcd: 'utf8',
    ttp_skip: true,
    // ⭐ 百分制必需（配合 extra_ability）
    ise_unite: '1',
    /**
     * ⭐ 四维得分必需；后两项是**白拿的细粒度数据**（实测：同一次请求就能回，不多花钱）：
     *    · syll_phone_err_msg —— 音节级检错（syll.serr_msg）
     *    · pitch              —— 逐帧音高（word.pitch / pitch_beg / pitch_end）
     * ⚠️ 实测对比：只传 multi_dimension 时，这两个字段**根本不出现**
     *    （曾误以为是 ise_unite 的锅，见 docs/research/ise-response-fields.md 的更正）。
     */
    extra_ability: 'multi_dimension,syll_phone_err_msg,pitch',
    // ⚠️ read_sentence 需要带 BOM + [content] 标签
    text: category === 'read_sentence' ? `\uFEFF[content]${refText}\n` : `\uFEFF${refText}`,
  }
}

/**
 * 解析讯飞 ISE 返回的 XML。
 *
 * ⚠️ 刻意做成模块级**纯函数**（不碰 WebSocket、密钥、环境）——
 *    这样才能拿一段**真实返回的 XML** 做回归测试（见 xfyun.test.ts）。
 *    本文件里所有「字段挂在哪一级节点」的结论都来自实测，
 *    而实测结论必须能被测试钉住，否则下次改动会静默漂移。
 */
export function parseIseXml(xml: string): ScoreResult {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    trimValues: true,
    parseTagValue: true,
    isArray: (name) => ['word', 'syll', 'phone', 'sentence'].includes(name),
  })
  const obj = parser.parse(xml)
  const root = obj?.xml_result ?? obj
  const sentence = root?.read_sentence ?? root?.read_chapter
  const paper = sentence?.rec_paper?.read_chapter ?? sentence?.rec_paper?.read_sentence
  if (!paper) throw new Error('讯飞 ISE 返回格式异常：缺少 rec_paper')

  const isRejected = String(paper['@_is_rejected']) === 'true'
  if (isRejected) throw new Error('未检测到有效语音，请重新朗读')

  const total = Number(paper['@_total_score'])

  // ⚠️ 区间断言只能兜住「明显越界」，**兜不住 0–5 分制** ——
  //    4.79 本身就落在 0–100 里（实测确认）。真正防住 v1 那个 bug 的是
  //    buildBusinessParams() 的 ise_unite，由 xfyun.test.ts 钉住。
  if (!Number.isFinite(total) || total < 0 || total > 100) {
    throw new Error(`讯飞 ISE 分制异常: ${paper['@_total_score']}（应为 0–100，检查 ise_unite 是否为 '1'）`)
  }

  // ⚠️ 必须**把所有分句的词拼起来**，不能只取第一句 ——
  //    read_chapter（篇章题）下 paper.sentence 有多个元素，
  //    只取 [0] 会把第一句之后的词**静默丢掉**（竞技场现在是单句所以没暴露）。
  const allSentences = (Array.isArray(paper.sentence) ? paper.sentence : [paper.sentence]).filter(
    Boolean,
  )
  const rawWords = allSentences.flatMap((s: any) =>
    Array.isArray(s?.word) ? s.word : s?.word ? [s.word] : [],
  )

  const DP_MAP: Record<number, WordScore['dp']> = {
    0: 'normal',
    16: 'omission',
    32: 'insertion',
    64: 'repetition',
    128: 'mispronunciation',
  }

  // 音节级检错的累计器 —— 依赖 extra_ability 里的 syll_phone_err_msg
  let syllableTotal = 0
  let syllableErrors = 0

  const words: WordScore[] = rawWords
    .map((w: any) => {
      const startFrame = Number(w['@_beg_pos'] ?? 0)
      const endFrame = Number(w['@_end_pos'] ?? 0)
      /**
       * ⭐ 音节级检错：syll.serr_msg 非 0 就是这个音节读错了。
       *
       * ⚠️ 它依赖 extra_ability 带 syll_phone_err_msg；不带的话这个字段
       *    **根本不会出现** —— 那不等于「没有错误」。所以要区分
       *    「一个音节都没读到」和「读了 10 个音节全对」：前者让整项为 undefined，
       *    调用方据此忽略这一项，而不是把它当成 0 错误率。
       */
      const sylls = Array.isArray(w.syll) ? w.syll : w.syll ? [w.syll] : []
      syllableTotal += sylls.length
      syllableErrors += sylls.filter((s: any) => Number(s['@_serr_msg'] ?? 0) !== 0).length
      /**
       * ⭐ 这个词里「明显读错」的音素。
       *
       * ⚠️ 阈值 -4 是实测出来的：读对的音素 gwpp 多在 -0.0x ~ -0.6，
       *    而「读成另一个词」时会掉到 -5 ~ -7（见 docs/research/ise-response-fields.md）。
       *    ⚠️ 整句的 gwpp 中位数**没有区分度**（各样本都差不多），
       *    所以只在**音素级、带阈值**用它 —— 它是定位器，不是打分项。
       */
      const badPhones = sylls
        .flatMap((s: any) => (Array.isArray(s.phone) ? s.phone : s.phone ? [s.phone] : []))
        .filter((p: any) => Number(p['@_gwpp']) < -4)
        .map((p: any) => String(p['@_content'] ?? ''))
        .filter(Boolean)
      return {
        word: String(w['@_content'] ?? ''),
        score: Number(w['@_total_score'] ?? 0),
        dp: DP_MAP[Number(w['@_dp_message'] ?? 0)] ?? 'normal',
        // ⚠️ beg_pos/end_pos 单位是帧，每帧 10ms
        startMs: startFrame * 10,
        endMs: endFrame * 10,
        ...(badPhones.length ? { badPhones } : {}),
      }
    })
    // ⚠️ ISE 会给**静音段**也造一个 content="sil" 的"词"（录音里有停顿时就会出现）。
    //    它不是用户读的词，留着会**打乱「第 n 个词 ↔ 第 n 个评分」的按位对应**，
    //    表现是词级上色整体错位 —— 这比不显示更难查。
    .filter((w: WordScore) => w.word.toLowerCase() !== 'sil')

  const sentences = allSentences.map((s: any) => ({
    text: String(s['@_content'] ?? ''),
    total: Number(s['@_total_score'] ?? 0),
    accuracy: Number(s['@_accuracy_score'] ?? 0),
    fluency: Number(s['@_fluency_score'] ?? 0),
    standard: Number(s['@_standard_score'] ?? 0),
  }))

  /**
   * ⭐ 音节级检错率（0–1）。
   * ⚠️ 「一个音节都没读到」时给 undefined，而不是 0 —— 0 会被当成「全对」。
   */
  const syllableErrorRate = syllableTotal > 0 ? syllableErrors / syllableTotal : undefined

  return { total, words, sentences, dimensions: readDimensions(paper), syllableErrorRate }
}

/** 转成有限数字；拿不到就是 NaN（不要用 0 冒充「真实得了 0 分」） */
function finiteNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : Number.NaN
}

/**
 * 读句级四维得分。
 *
 * ⭐ 字段位置是**实测**出来的，不是照文档写的 —— 四个维度都挂在
 *    `rec_paper` 下的 `<read_chapter>` 节点上，**即使题型是 read_sentence，节点名也叫 read_chapter**。
 *    实测结构见 apps/server/scripts/dump-ise-xml.ts。
 *
 * ⚠️ 四个必须**齐了**才返回：缺任何一个都说明返回结构不是我们预期的样子，
 *    这时候宁可界面上不显示，也不能把 0 当成真实分数画出去 ——
 *    「完整度 0」是会被用户当成「我一个词都没读」的。
 */
function readDimensions(node: any): ScoreDimensions | undefined {
  const accuracy = finiteNumber(node?.['@_accuracy_score'])
  const fluency = finiteNumber(node?.['@_fluency_score'])
  const standard = finiteNumber(node?.['@_standard_score'])
  const integrity = finiteNumber(node?.['@_integrity_score'])
  if (![accuracy, fluency, standard, integrity].every((v) => Number.isFinite(v))) return undefined
  const r = (v: number): number => Math.round(v * 10) / 10
  return { accuracy: r(accuracy), fluency: r(fluency), standard: r(standard), integrity: r(integrity) }
}
