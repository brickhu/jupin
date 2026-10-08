import { resolveCloudFileUrl } from '../../lib/cloud-file'
import { fetchKwsModel } from '../../lib/api/client'
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
/**
 * ⭐⭐ **模型在代码包里叫 `.bin`，不叫 `.onnx`** —— 这是本轮扫描得出的硬结论 ✓
 *
 * 真机实测（主包与分包结果一致 ✓ 说明分包没问题 ✓）：
 *
 *     .onnx ✗   .bin ✓   .mp3 ✓   .dat ✗   .txt ✗   .wasm ✓
 *
 * ⇒ ⚠️ **打包器把 `.onnx` 丢掉了** ✗（不是路径问题、也不是分包问题 ✓）
 * ⇒ 所以进包时用 `.bin` ✓ 读出来之后再**在 USER_DATA_PATH 里叫回 `.onnx`** ✓
 *    （那个目录不受打包器管 ✓ 而且调研里写着这个 API 认 USER_DATA_PATH ✓）
 */
const MODEL_OUT = 'kws-encoder.onnx'



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

    // ── ① 向服务端问"模型在哪" → 自己去 CDN 下 ⭐ ─────────────────
    /**
     * ⚠️⚠️ 为什么这么绕（而不是让服务端回吐 4.4MB）—— 算过账：
     *    容器**公网流量 0.8 元/GB** ✗，对象存储 **CDN 0.18 元/GB** ✓，
     *    而**只通过 callContainer 访问不产生流量用量** ✓
     *  ⇒ 服务端只回一个**一百字节的 fileID** ✓ 字节走对象存储 ✓ 这一条完全免费 ✓
     */
    let modelUrl = ''
    try {
      const info = await fetchKwsModel()
      if (!info?.fileId) throw new Error('服务端没给 fileId')
      this.log('服务端给了 fileId ✓（' + Math.round(info.bytes / 1048576 * 100) / 100 + ' MB）')
      modelUrl = await resolveCloudFileUrl(info.fileId)
      this.log('换到可下载地址 ✓')
    } catch (e) {
      /**
       * ⚠️⚠️ **错误对象必须 stringify**，不能读 `.message` ✗
       *    `wx.request` 的 fail 给的是一个普通对象（没有 message ✓）⇒
       *    上一版打出来是 `[object Object]`，等于没报错 ✓（这条踩过）
       */
      this.log('取模型地址失败 ✗ ' + JSON.stringify(e).slice(0, 200))
      this.setData({ running: false, verdict: 'fail' })
      return
    }

    // ② 下载 → 落到 USER_DATA_PATH（createInferenceSession 认这个目录 ✓）
    const fs = wx.getFileSystemManager()
    const dest = `${wx.env.USER_DATA_PATH}/${MODEL_OUT}`
    try {
      this.log('下载模型（约 4.4MB）…')
      const dl = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((res, rej) =>
        wx.downloadFile({ url: modelUrl, success: res, fail: rej }),
      )
      if (dl.statusCode !== 200) throw new Error('HTTP ' + dl.statusCode)
      try {
        fs.unlinkSync(dest)
      } catch {
        /* 第一次没有，忽略 */
      }
      fs.copyFileSync(dl.tempFilePath, dest)
      const st = fs.statSync(dest)
      const size = Array.isArray(st) ? 0 : st.size
      if (size < 1024 * 1024) throw new Error('下到的太小：' + size + ' 字节')
      this.log('已存到 USER_DATA_PATH ✓ ' + (size / 1048576).toFixed(2) + ' MB')
    } catch (e) {
      this.log('下载失败 ✗ ' + JSON.stringify(e).slice(0, 200))
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
