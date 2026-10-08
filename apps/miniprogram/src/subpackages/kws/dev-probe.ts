/**
 * ⚠️ **临时探针页**（验完就删）—— 只回答一个问题：
 *
 *     微信的 `wx.createInferenceSession` 能不能**加载** sherpa-onnx 的 KWS 模型？
 *
 * ## ⚠️⚠️ 它只能在**真机**上跑
 *
 * 开发者工具**不支持调试这个 API** ✗ —— 实测原文：
 *   `createInferenceSession:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发`
 * ⇒ 在模拟器里看到那句"不能加载"是**预期的**，不是模型的错 ✓
 *   （和音频解码那次一模一样的模式：**模拟器验不了，必须真机** ✓）
 *
 * ## 为什么只验"加载"、不跑推理
 *
 * 仓库端侧调研里的失败现象是「换了很多 onnx 模型**都不让用**」与
 * 「运行到 **createInferenceSession** 就闪退」—— 都是**加载/创建阶段**就挂 ✗
 * ⇒ 不需要真的跑推理（那还得自己算 fbank 特征 ✗）✓
 *
 * ⚠️ 它**不回答**准确率 / 速度 / 实时性 —— 那些等"能加载"之后再说 ✓
 *
 * ## 模型从哪来
 *
 * ⭐ **代码包路径**（本页与 .onnx 同在 subpackages/kws/ ✓ 已实测构建会拷进 dist ✓）
 * ⇒ 真机上**不联网、不需要域名白名单** ✓
 */
const CANDIDATES = [
  '/subpackages/kws/encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  'subpackages/kws/encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
]

Page({
  data: {
    running: false,
    /** 'ok' | 'fail' | '' */
    verdict: '' as '' | 'ok' | 'fail',
    lines: [] as string[],
  },

  onRun() {
    if (this.data.running) return
    this.setData({ running: true, verdict: '', lines: [] })
    void this.probe()
  },

  log(line: string) {
    console.log('[probe] ' + line)
    this.setData({ lines: [...this.data.lines, line] })
  },

  async probe() {
    // ── ① 环境：API 在不在、基础库版本多少（版本门槛很关键）──────────
    this.log('基础库 ' + wx.getAppBaseInfo?.().SDKVersion)
    const has = typeof wx.createInferenceSession === 'function'
    this.log('wx.createInferenceSession：' + (has ? '存在 ✓' : '不存在 ✗'))
    if (!has) {
      this.setData({ running: false, verdict: 'fail' })
      return
    }

    // ── ② 模型走代码包路径（不联网 ✓）────────────────────────────
    this.log('模型走代码包路径（subpackages/kws/…int8.onnx）✓')

    // ── ③ 创建 session —— 这一步就是结论 ───────────────────────────
    /**
     * ⚠️ **两种路径写法都试**：代码包路径带不带前导斜杠，文档没写死 ✓
     *    ⇒ 自动依次试、成功即止 —— 省你一次真机往返 ✓
     */
    for (const path of CANDIDATES) {
      this.log('createInferenceSession(' + (path.startsWith('/') ? '带斜杠' : '不带斜杠') + ') …')
      if (await this.tryLoad(path)) {
        this.setData({ verdict: 'ok', running: false })
        return
      }
    }
    this.setData({ verdict: 'fail', running: false })
  },

  /** ⭐ 试着用某个路径建 session；成败都写在屏幕上 ✓ */
  tryLoad(modelPath: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      const done = (v: boolean) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        resolve(v)
      }

      let session: WechatMiniprogram.InferenceSession | null = null
      try {
        session = wx.createInferenceSession({ model: modelPath, precisionLevel: 0 })
      } catch (e) {
        // ⚠️ 同步抛错也要报出来 —— 这类失败最容易只留一句"闪退"，查不出来 ✓
        this.log('  ✗ 同步抛错：' + ((e as Error).message || String(e)).slice(0, 200))
        done(false)
        return
      }

      /**
       * ⚠️ 必须有超时：这个 API 是 **Beta**，**卡住不回调是可能的** ✗
       *    （开发者工具里它直接回"不支持调试该 API" ✓ 真机行为未知 ✓）
       */
      timer = setTimeout(() => {
        this.log('  ✗ 15 秒没有任何回调（卡住了）')
        done(false)
      }, 15000)

      session.onLoad?.(() => {
        this.log('  ✅ session 创建成功')
        const s = session as unknown as { inputs?: unknown; outputs?: unknown }
        this.log('  inputs: ' + JSON.stringify(s.inputs ?? null).slice(0, 240))
        this.log('  outputs: ' + JSON.stringify(s.outputs ?? null).slice(0, 240))
        done(true)
      })
      session.onError?.((err: unknown) => {
        this.log('  ❌ ' + JSON.stringify(err).slice(0, 300))
        // ⚠️ 这条提示很关键：动态轴是这类模型最常见的拒绝理由 ✓
        this.log('  ⚠️ 若是"动态轴"⇒ 下一版传 typicalShape 再试')
        done(false)
      })
    })
  },
})
