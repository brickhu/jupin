import crypto from 'node:crypto'
import WebSocket from 'ws'
import { XMLParser } from 'fast-xml-parser'
import type { ScoreEngine, ScoreOptions, ScoreResult, WordScore } from './types'

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
    const xml = await this.request(refText, audio, category)
    return this.parse(xml)
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
          business: {
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
            extra_ability: 'multi_dimension',
            // ⚠️ read_sentence 需要带 BOM + [content] 标签
            text: category === 'read_sentence' ? `\uFEFF[content]${refText}\n` : `\uFEFF${refText}`,
          },
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

    // ⭐ 分制断言 —— 一行防住 v1 那个 bug
    if (!Number.isFinite(total) || total < 0 || total > 100) {
      throw new Error(`讯飞 ISE 分制异常: ${paper['@_total_score']}（应为 0–100，检查 ise_unite 是否为 '1'）`)
    }

    const firstSentence = Array.isArray(paper.sentence) ? paper.sentence[0] : paper.sentence
    const rawWords = firstSentence?.word ?? []

    const DP_MAP: Record<number, WordScore['dp']> = {
      0: 'normal',
      16: 'omission',
      32: 'insertion',
      64: 'repetition',
      128: 'mispronunciation',
    }

    const words: WordScore[] = (Array.isArray(rawWords) ? rawWords : [rawWords]).map((w: any) => {
      const startFrame = Number(w['@_beg_pos'] ?? 0)
      const endFrame = Number(w['@_end_pos'] ?? 0)
      return {
        word: String(w['@_content'] ?? ''),
        score: Number(w['@_total_score'] ?? 0),
        dp: DP_MAP[Number(w['@_dp_message'] ?? 0)] ?? 'normal',
        // ⚠️ beg_pos/end_pos 单位是帧，每帧 10ms
        startMs: startFrame * 10,
        endMs: endFrame * 10,
      }
    })

    const sentences = (Array.isArray(paper.sentence) ? paper.sentence : [paper.sentence])
      .filter(Boolean)
      .map((s: any) => ({
        text: String(s['@_content'] ?? ''),
        total: Number(s['@_total_score'] ?? 0),
        accuracy: Number(s['@_accuracy_score'] ?? 0),
        fluency: Number(s['@_fluency_score'] ?? 0),
      }))

    return { total, words, sentences }
  }
}
