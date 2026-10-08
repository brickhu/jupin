/**
 * ⚠️ **临时探针页**（验完就删）—— 只回答一个问题：
 *
 *    微信的 `wx.createInferenceSession` 能不能**加载** sherpa-onnx 的 KWS 模型？
 *
 * ## 为什么只验"加载"
 *
 * 仓库的端侧调研里，失败的现象是「换了很多 onnx 模型都不让用」与「运行到
 * createInferenceSession 就闪退」—— **都是"加载/创建"阶段就挂** ✗
 * ⇒ 不需要真的跑推理（那要自己算 fbank 特征 ✗），只要看它**建不建得起来** ✓
 *
 * ## 这个探针不回答什么
 *
 * ⚠️ 不验准确率、不验速度、不验实时性 —— 那些等"能加载"之后再说 ✓
 */
const MODEL_URL = 'http://127.0.0.1:8791/encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx'

Page({
  data: {
    running: false,
    /** 'ok' | 'fail' | '' */
    verdict: '',
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
    const info = wx.getAppBaseInfo?.() ?? wx.getSystemInfoSync()
    this.log('基础库 ' + info.SDKVersion)
    const has = typeof wx.createInferenceSession === 'function'
    this.log('wx.createInferenceSession：' + (has ? '存在 ✓' : '不存在 ✗'))
    if (!has) {
      this.setData({ running: false, verdict: 'fail' })
      return
    }

    // ── ② 下载模型到 USER_DATA_PATH（这个 API 只认代码包路径 / USER_DATA_PATH）──
    let modelPath = ''
    try {
      this.log('下载模型（约 4.4MB）…')
      const dl = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>((res, rej) =>
        wx.downloadFile({ url: MODEL_URL, success: res, fail: rej }),
      )
      if (dl.statusCode !== 200) throw new Error('HTTP ' + dl.statusCode)
      const dest = `${wx.env.USER_DATA_PATH}/kws-encoder.onnx`
      const fs = wx.getFileSystemManager()
      // ⚠️ tempFilePath 不在 USER_DATA_PATH 下 ⇒ 必须复制过去，createInferenceSession 才认
      try {
        fs.unlinkSync(dest)
      } catch {
        /* 第一次没有这个文件，忽略 */
      }
      fs.copyFileSync(dl.tempFilePath, dest)
      // ⚠️ statSync 的返回类型是 Stats | FileStats[]（后者是递归模式）⇒ 判一下再取 size
      const st = fs.statSync(dest)
      const size = Array.isArray(st) ? 0 : st.size
      modelPath = dest
      this.log('模型就位：' + (size / 1024 / 1024).toFixed(2) + ' MB ✓')
    } catch (e) {
      this.log('下载失败 ✗ ' + (e as Error).message)
      this.log('⚠️ 检查「详情 → 本地设置 → 不校验合法域名」是否勾上')
      this.setData({ running: false, verdict: 'fail' })
      return
    }

    // ── ③ 创建 session —— 这一步就是结论 ───────────────────────────
    this.log('正在 createInferenceSession…（成败看下面）')
    await new Promise<void>((resolve) => {
      let settled = false
      const done = (v: 'ok' | 'fail') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.setData({ verdict: v, running: false })
        resolve()
      }

      let session: WechatMiniprogram.InferenceSession | null = null
      try {
        session = wx.createInferenceSession({ model: modelPath, precisionLevel: 0 })
      } catch (e) {
        // ⚠️ 同步抛错也要报出来 —— 这类失败最容易只留一句"闪退"
        this.log('同步抛错 ✗ ' + ((e as Error).message || String(e)).slice(0, 300))
        done('fail')
        return
      }

      // ⚠️ 必须有超时：这个 API 是 Beta，卡住不回调是可能的 ✗
      const timer = setTimeout(() => {
        this.log('15 秒没有任何回调 ✗（卡住了）')
        done('fail')
      }, 15000)

      session.onLoad?.(() => {
        this.log('✅ session 创建成功')
        const s = session as unknown as { inputs?: unknown; outputs?: unknown }
        this.log('inputs: ' + JSON.stringify(s.inputs ?? null).slice(0, 300))
        this.log('outputs: ' + JSON.stringify(s.outputs ?? null).slice(0, 300))
        done('ok')
      })
      session.onError?.((err: unknown) => {
        this.log('❌ 报错：' + JSON.stringify(err).slice(0, 400))
        // ⚠️ 这条提示很关键：动态轴是这类模型最常见的拒绝理由
        this.log('⚠️ 若是"动态轴"⇒ 下一版要传 typicalShape 再试')
        done('fail')
      })
    })
  },
})
