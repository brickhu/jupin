/**
 * 音频上传 —— 走对象存储直传，**不经过后端**。
 *
 * ⚠️ 为什么不直接 POST 给后端：
 *    小程序 → 云托管服务的请求体有大小限制（大请求实测报 nginx 413），
 *    而 20 秒 16k/16bit 单声道音频约 640KB，远超限制。
 *
 *    正确路径：小程序直传对象存储 → 只把 fileID 发给后端。
 *    这样还顺带拿到上传进度回调，且**免域名、免备案**。
 */
export interface UploadResult {
  fileID: string
}

export interface UploadOptions {
  /** 上传进度回调 0–100 */
  onProgress?: (percent: number) => void
}

/** 生成一个带时间戳的云存储路径，避免覆盖写 */
function makeCloudPath(ext = 'pcm'): string {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 8)
  return 'audio/' + ts + '-' + rand + '.' + ext
}

/**
 * 上传本地录音文件到对象存储。
 * @param filePath 录音得到的本地临时文件路径
 */
export function uploadAudio(filePath: string, opts: UploadOptions = {}): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const task = wx.cloud.uploadFile({
      cloudPath: makeCloudPath(),
      filePath,
      success: (res) => {
        if (!res.fileID) {
          reject(new Error('上传成功但未返回 fileID'))
          return
        }
        resolve({ fileID: res.fileID })
      },
      fail: (err) => reject(new Error(err.errMsg || '上传失败')),
    })

    // ⭐ 上传进度：对象存储直传才有的能力，走请求体上传时拿不到
    if (opts.onProgress && task && typeof task.onProgressUpdate === 'function') {
      task.onProgressUpdate((p) => opts.onProgress?.(p.progress))
    }
  })
}
