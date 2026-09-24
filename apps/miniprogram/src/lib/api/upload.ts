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
  /** 上传进度回调 0–100 */
  onProgress?: (percent: number) => void
}

/**
 * ⭐ 存储路径规范：**句子 / 用户 / 时间戳** 三段。
 *
 *   audio/{articleId}/{userId}/{timestamp}.{后缀}
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
function makeAudioKey(articleId: string, userId: number, filePath: string): string {
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filePath)
  const ext = (m?.[1] ?? RECORD_SPEC.extension).toLowerCase()
  return 'audio/' + articleId + '/' + userId + '/' + Date.now() + '.' + ext
}

export function uploadAudio(filePath: string, opts: UploadOptions): Promise<UploadResult> {
  const userId = getUserId()
  if (!userId) {
    // 上传路径必须带 uid，拿不到就早失败 —— 否则会传到错误路径被服务端拒掉
    return Promise.reject(new Error('还没拿到用户 id，请稍后重试'))
  }

  const audioKey = makeAudioKey(opts.articleId, userId, filePath)
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
      url: BASE_URL + '/api/uploads',
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
