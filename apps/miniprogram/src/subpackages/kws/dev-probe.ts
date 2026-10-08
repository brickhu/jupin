/**
 * ⚠️ **临时探针页**（验完就删）—— 只回答一个问题：
 *
 *     微信的 `wx.createInferenceSession` 能不能**加载** sherpa-onnx 的 KWS 模型？
 *
 * ## ⚠️⚠️ 它只能在**真机**上跑
 *
 * 开发者工具**不支持调试这个 API** ✗ —— 实测原文：
 *   `createInferenceSession:fail 开发者工具暂时不支持此 API 调试，请使用真机进行开发`
 *
 * ## 真机实测（2026-10）已经把问题缩小到"文件路径"这一步
 *
 *   基础库 3.17.3 · API 存在 ✓
 *   直接给**代码包路径**（带/不带前导斜杠都试过）⇒
 *     `{"errno":2004000,"errMsg":"...model path invalid : failed to find model on path ..."}`
 *
 * ⭐ 注意这**不是**算子错、也**不是**动态轴错 —— 是"**找不到这个文件**" ✓
 *   ⇒ API 本身能跑 ✓ 只是它**读不到分包里的文件** ✗
 *
 * ⭐ 而仓库的调研里写着它认两种路径：**代码包路径** 或 **`wx.env.USER_DATA_PATH`**
 *   ⇒ 所以这一版**先把文件读出来、落到 USER_DATA_PATH，再把那个路径交给它** ✓
 */
const MODEL = 'encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx'
/** ⚠️ 读代码包文件时，路径带不带前导斜杠的约定不明确 ⇒ 两种都试 ✓ */
const PKG_PATHS = [`subpackages/kws/${MODEL}`, `/subpackages/kws/${MODEL}`]

Page({
  data: {
    running: false,
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
    this.log('基础库 ' + wx.getAppBaseInfo?.().SDKVersion)
    const has = typeof wx.createInferenceSession === 'function'
    this.log('wx.createInferenceSession：' + (has ? '存在 ✓' : '不存在 ✗'))
    if (!has) {
      this.setData({ running: false, verdict: 'fail' })
      return
    }

    // ── ① 把模型从代码包读出来 → 写到 USER_DATA_PATH ────────────────
    /**
     * ⚠️ 为什么要绕这一下：真机实测直接给代码包路径会报
     *    `model path invalid : failed to find model on path ...` ✗
     *    ⇒ 而调研里写着它认 `wx.env.USER_DATA_PATH` ✓
     */
    const fs = wx.getFileSystemManager()
    const dest = `${wx.env.USER_DATA_PATH}/kws-encoder.onnx`
    let ok = false
    for (const p of PKG_PATHS) {
      try {
        const buf = fs.readFileSync(p) as ArrayBuffer
        const bytes = (buf as ArrayBuffer).byteLength ?? 0
        if (bytes < 1024 * 1024) throw new Error('读到的太小：' + bytes + ' 字节')
        fs.writeFileSync(dest, buf)
        this.log(`读代码包(${p.startsWith('/') ? '带斜杠' : '不带斜杠'}) ✓ ${(bytes / 1048576).toFixed(2)} MB`)
        this.log('已写入 USER_DATA_PATH ✓')
        ok = true
        break
      } catch (e) {
        this.log(`读代码包(${p.startsWith('/') ? '带斜杠' : '不带斜杠'}) ✗ ` + ((e as Error).message || String(e)).slice(0, 90))
      }
    }
    if (!ok) {
      this.log('⚠️ 两种路径都读不到 —— 代码包里的文件读法还要再查')
      this.setData({ running: false, verdict: 'fail' })
      return
    }

    // ── ② 创建 session —— 这一步就是结论 ───────────────────────────
    this.log('createInferenceSession（USER_DATA_PATH）…')
    const created = await this.tryLoad(dest)
    this.setData({ verdict: created ? 'ok' : 'fail', running: false })
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
       *    （真机上它回得很快 ✓ 但 Beta 的事说不准 ✓）
       */
      timer = setTimeout(() => {
        this.log('  ✗ 20 秒没有任何回调（卡住了）')
        done(false)
      }, 20000)

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
