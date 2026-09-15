import { getUserId } from './client'

/**
 * 音频上传 —— 走对象存储直传，**不经过后端**。
 *
 * ⚠️ 为什么不直接 POST 给后端：
 *    小程序 → 云托管服务的请求体上限是 **100KiB**（官方文档明写，超限报业务错误码
 *    -606001），而 20 秒 16k/16bit 单声道音频约 640KB，远超限制。
 *
 *    正确路径：小程序直传对象存储 → 只把**路径**发给后端。
 *    这样还顺带拿到上传进度回调，且**免域名、免备案**。
 */

export interface UploadResult {
  /** 对象存储里的 key，形如 audio/{articleId}/{userId}/{ts}.pcm */
  audioKey: string
}

export interface UploadOptions {
  /** 本段录音属于哪篇文章 —— 会编进存储路径 */
  articleId: number
  /** 上传进度回调 0–100 */
  onProgress?: (percent: number) => void
}

/**
 * ⭐ 存储路径规范：**句子 / 用户 / 时间戳** 三段。
 *
 *   audio/{articleId}/{userId}/{timestamp}.pcm
 *
 * ⚠️ 必须与服务端 `services/audio-key.ts` 的 `makeAudioKey()` 完全一致。
 *    服务端会校验这个路径：段数、前缀、文件名格式，
 *    以及**第二段的 uid 必须等于发起请求的人**（防冒充）。
 *
 * 为什么路径不能直接用 submissionId：
 *   路径要在**上传那一刻**就定下来，而 submissionId 含序列号，
 *   序列号要等提交时数库才知道——所以两者是独立的（见服务端注释）。
 */
function makeAudioKey(articleId: number, userId: number): string {
  return 'audio/' + articleId + '/' + userId + '/' + Date.now() + '.pcm'
}

/**
 * 上传本地录音文件到对象存储。
 * @param filePath 录音得到的本地临时文件路径
 */
export function uploadAudio(filePath: string, opts: UploadOptions): Promise<UploadResult> {
  const userId = getUserId()
  if (!userId) {
    // 上传路径必须带 uid，拿不到就早失败 —— 否则会传到错误路径被服务端拒掉
    return Promise.reject(new Error('还没拿到用户 id，请稍后重试'))
  }

  const audioKey = makeAudioKey(opts.articleId, userId)

  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath: audioKey,
      filePath,
      success: () => resolve({ audioKey }),
      fail: (err) => reject(new Error(err.errMsg || '上传失败')),
    })

    // ⭐ 上传进度：对象存储直传才有的能力，走请求体上传时拿不到
    if (opts.onProgress && task && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((p) => opts.onProgress?.(p.progress))
    }
  })
}
