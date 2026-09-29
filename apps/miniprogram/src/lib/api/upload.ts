import { RECORD_SPEC } from '@jushuo/shared'

import { BASE_URL, TRANSPORT } from '../../config'
import { authHeader, getUserId } from './client'

/**
 * 音频上传 —— 上传到「对象存储」，**不经过业务后端**。
 *
 * ⚠️ 为什么不直接 POST 给后端：
 *    小程序 → 云托管服务的请求体上限是 **100KiB**（官方文档明写，超限报业务错误码
 *    -606001），而 20 秒 16k/16bit 单声道音频约 640KB，远超限制。
 *
 *    ⭐ 所以线上路径是：小程序直传对象存储 → 只把**路径**发给后端。
 *       这样还顺带拿到上传进度回调，且**免域名、免备案**。
 *
 * ⚠️⚠️ 本地（模拟器）走的是**另一条路**：本地 Docker 服务端没有 COS 凭证
 *      （取临时密钥要调云托管内网的 /_/cos/getauth，本机调不到），
 *      所以它读不到微信云存储里的对象。
 *      本地改成用 wx.uploadFile 把文件打到本地服务端（POST /api/uploads），
 *      服务端用 LocalStorage 落盘 —— 这样「上传 → 提交」这条路本地才跑得通。
 *      这条裂缝的细节见 apps/server/src/routes/uploads.ts。
 */

export interface UploadResult {
  /** 对象存储里的 key，形如 audio/{articleId}/{userId}/{ts}.pcm */
  audioKey: string
  /**
   * 带签名的下载地址（只有线上通道能给）。
   *
   * ⚠️ 服务端读音频本来该走 COS-SDK + 「开放接口服务」取临时密钥，
   *    但该服务在本项目 dev 环境实测**始终没有旁加载到实例**，
   *    于是提交必然失败在「读取音频失败」那一步。
   *    把签名地址一并交给服务端，它就不必依赖那个服务。
   *    拿不到时为 undefined，服务端会自动退回自己取。
   */
  audioUrl?: string
}

export interface UploadOptions {
  /** 本段录音属于哪篇文章 —— 会编进存储路径 */
  articleId: string
  /**
   * ⭐ 一次提交尝试的稳定 id（32 hex）—— **重试必须复用同一个值**（见 newAttemptId）。
   * 它同时是存储路径的第三段与服务端的幂等键（见 db/schema.ts 的 attemptId）。
   */
  attemptId: string
  /** 上传进度回调 0–100 */
  onProgress?: (percent: number) => void
}

/**
 * ⭐ 存储路径规范：**句子 / 用户 / 尝试 id** 三段。
 *
 *   audio/{articleId}/{userId}/{attemptId}.{后缀}
 *
 * ⚠️ 第三段原来是上传时间戳，2026-09 改成 attemptId：路径必须"同一段录音重试时不变"，
 *    否则服务端按路径判重的兜底会跟着失效（真实事故：重试多扣一次能量）。
 *
 * ⚠️ 必须与服务端 `services/audio-key.ts` 的 `makeAudioKey()` 完全一致。
 *    服务端会校验这个路径：段数、前缀、文件名格式（后缀在允许集合里），
 *    以及**第二段的 uid 必须等于发起请求的人**（防冒充）。
 *
 * ⭐ 后缀取**落盘文件的真实扩展名**，而不是写死一个：
 *    录音格式跟着微信接口的默认值走（aac，见 RECORD_SPEC），
 *    而不同平台上同一个格式落盘的后缀可能不同（.aac / .m4a），
 *    写死就会让「文件叫什么」和「里面是什么」对不上。
 *    ⚠️ 服务端其实**按文件头 sniff**（不靠后缀判断内容），后缀只用于日志和排查，
 *       所以这里取错也不会算错分 —— 但会让排查时看不出这一条是什么。
 *
 * 为什么路径不能直接用 submissionId：
 *   路径要在**上传那一刻**就定下来，而 submissionId 含序列号，
 *   序列号要等提交时数库才知道 —— 所以两者是独立的（见服务端注释）。
 */
function makeAudioKey(articleId: string, userId: number, attemptId: string, filePath: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filePath)
  const ext = (m?.[1] ?? RECORD_SPEC.extension).toLowerCase()
  /**
   * ⚠️⚠️ 第三段是 **attemptId**（一次提交尝试的稳定 id），**不再是 Date.now()**。
   *
   * 用时间戳的后果（真实事故）：客户端每次重试都会重新上传一次 ⇒ 路径变了
   * ⇒ 服务端按 audioKey 判重必然落空 ⇒ 多加一条成绩、**多扣一次能量**、
   * 多调一次引擎 —— 而界面上写着"不会重复计费"。
   * 现在路径与幂等键同源：重试（同一个 attemptId）会覆盖同一个对象、命中同一行。
   */
  return 'audio/' + articleId + '/' + userId + '/' + attemptId + '.' + ext
}

/**
 * ⭐ 生成一次提交尝试的 id（32 位十六进制，与服务端正则一致）。
 *
 * ⚠️ 调用方**必须**在"录音落地那一刻"生成一次、然后在整个重试链里复用
 *    （见 pages/reading 的 attemptId 字段）。这里只负责生成，不负责复用 ——
 *    每次调用都会得到**不同**的值，那正是"重录一次 = 新的一次尝试"。
 */
export function newAttemptId(): string {
  const bytes = new Uint8Array(16)
  /**
   * ⚠️⚠️ **先用 `Math.random` 填满，再试着叠加平台的密码学随机** —— 顺序不能反。
   *
   *    真实事故（2026-09，用户报"每次都在显示前一次的结果"）：这里原来写的是
   *    "优先 `wx.getRandomValues(bytes)`，拿不到才退回 Math.random"。而微信的
   *    `wx.getRandomValues` 要的是 **ArrayBuffer**，传 `Uint8Array` 进去**静默不回填** ——
   *    于是 bytes 全是 0 ⇒ `attemptId` 恒为 `000…0`（32 个 0）⇒
   *    服务端每次都判成"同一次提交"（幂等键相同）⇒ **永远返回第一次那条成绩**。
   *    更阴的是服务端日志里只有一句"幂等命中"，看起来完全正常。
   *
   *    ⚠️ 用 Math.random 是**可接受**的：这是幂等键、不是密钥 ——
   *    可预测不造成越权，最坏是极小概率撞键，而服务端的唯一索引会挡住。
   *    ⇒ **"保证非零"比"用密码学随机"重要得多**。
   *    ⚠️ 刻意**不写 `globalThis`**：它是 ES2020，而小程序产物必须停在 es2017
   *    （build.mjs 的 assertNoModernSyntax 会当场拦下 —— 这一版就先被它拦过一次）。
   */
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  try {
    const wxCrypto = (wx as unknown as { getRandomValues?: (a: ArrayBuffer) => void }).getRandomValues
    // ⚠️ 传 `bytes.buffer`（ArrayBuffer）；即使微信那边仍不认，上面填好的随机值也不会变成 0
    if (typeof wxCrypto === 'function') wxCrypto(bytes.buffer)
  } catch {
    /* 拿不到就用 Math.random 那份，不影响幂等性 */
  }
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  /**
   * ⚠️ 兜底断言：全 0 的键会让"每一次提交"都被服务端当成同一次 ——
   *    宁可现造一个随机值，也不要返回一个必然出错的键。
   */
  if (/^0+$/.test(id)) {
    console.warn('[upload] attemptId 全为 0（随机源异常）—— 现造一个')
    return (
      Date.now().toString(16).padStart(12, '0') +
      Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
    )
  }
  return id
}

export function uploadAudio(filePath: string, opts: UploadOptions): Promise<UploadResult> {
  const userId = getUserId()
  if (!userId) {
    // 上传路径必须带 uid，拿不到就早失败 —— 否则会传到错误路径被服务端拒掉
    return Promise.reject(new Error('还没拿到用户 id，请稍后重试'))
  }
  if (!/^[a-f0-9]{32}$/.test(opts.attemptId)) {
    // ⚠️ 早失败：拿不到合法 attemptId 就上传，会传到一个"判不了重"的路径上
    return Promise.reject(new Error('本次提交的 attemptId 不合法，请重录一次'))
  }

  const audioKey = makeAudioKey(opts.articleId, userId, opts.attemptId, filePath)
  return TRANSPORT === 'http'
    ? uploadToLocalServer(filePath, audioKey, opts)
    : uploadToCloudStorage(filePath, audioKey, opts)
}

/** 通道 ①：本地联调 —— 直传本机服务端，落盘到 LocalStorage */
function uploadToLocalServer(
  filePath: string,
  audioKey: string,
  opts: UploadOptions,
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const task = wx.uploadFile({
      /**
       * ⚠️⚠️ 路径是「/api/user/uploads」，**不是**「/api/uploads」—— 这个前缀写错过一次。
       *    症状：提交时报「上传响应不是合法 JSON」。因为那条路径不存在，
       *    Hono 的 404 回的是 text/plain 的「404 Not Found」，客户端 JSON.parse 就抛了
       *    —— 报的是"不是合法 JSON"，而不是一句能看出「路径写错了」的话。
       *    见 middleware/auth.test.ts 那条铁律：需要鉴权的接口全在 /api/user/* 下。
       * ⚠️ 写注释时别用两个星号去夹路径：星号紧挨斜杠会**提前关掉块注释**，
       *    整个文件当场语法错误（我自己踩的，一次 typecheck 才发现）。
       */
      url: BASE_URL + '/api/user/uploads',
      filePath,
      name: 'file',
      formData: { articleId: String(opts.articleId), audioKey },
      header: authHeader(),
      success: (res) => {
        // ⚠️ wx.uploadFile 的 data 是**字符串**，不像 wx.request 会自动解析
        try {
          const body = JSON.parse(res.data) as { ok: boolean; data?: { audioKey: string }; error?: string }
          if (body.ok && body.data) resolve({ audioKey: body.data.audioKey })
          else reject(new Error(body.error ?? '上传失败'))
        } catch {
          reject(new Error('上传响应不是合法 JSON：' + String(res.data).slice(0, 120)))
        }
      },
      fail: (err) => reject(new Error(err.errMsg || '上传失败')),
    })

    if (opts.onProgress && task && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((p) => opts.onProgress?.(p.progress))
    }
  })
}

/** 通道 ②：线上 —— 直传微信对象存储 */
async function uploadToCloudStorage(
  filePath: string,
  audioKey: string,
  opts: UploadOptions,
): Promise<UploadResult> {
  const fileID = await new Promise<string>((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath: audioKey,
      filePath,
      success: (res) => resolve(res.fileID),
      fail: (err) => reject(new Error(err.errMsg || '上传失败')),
    })

    // ⭐ 上传进度：对象存储直传才有的能力，走请求体上传时拿不到
    if (opts.onProgress && task && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((p) => opts.onProgress?.(p.progress))
    }
  })

  return { audioKey, audioUrl: await tempUrlOf(fileID) }
}

/**
 * 取带签名的下载地址。
 *
 * ⚠️ 失败**不抛异常**，返回 undefined —— 让服务端退回自己读对象存储。
 *    这是刻意的降级：取不到签名地址只是少了条路，不该让整个提交挂掉。
 */
async function tempUrlOf(fileID: string): Promise<string | undefined> {
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: [fileID] })
    const item = res.fileList && res.fileList[0]
    if (item && item.tempFileURL) return item.tempFileURL
    console.warn('[upload] 取临时地址未返回 URL：', item ? item.errMsg : 'fileList 为空')
  } catch (err) {
    console.warn('[upload] 取临时地址异常：', (err as Error).message)
  }
  return undefined
}
