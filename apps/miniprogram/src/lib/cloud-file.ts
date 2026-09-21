import { CLOUD_ENV_ID } from '../config'

/**
 * ⭐ 云存储 fileID → 可直接放进 `<image src>` 的临时地址。
 *
 * ⚠️ 为什么不用 HTTP 直链：云托管通道下 API 走 callContainer **不拼 URL**，
 *    客户端根本没有一个"本服务的域名"可用；而 wx.cloud.getTempFileURL
 *    走的是云开发通道 —— **不需要配 downloadFile / request 合法域名**。
 *    少一道控制台配置，就少一个「真机上图片不显示」的坑。
 *
 * ⚠️ 缓存是**会话级**的：临时地址约两小时有效，而榜单/头像会反复渲染同一批
 *    fileID，每次都换一次地址纯属白跑网络。刻意不落 storage ——
 *    存下来的地址过期了反而更难查。
 */
const cache = new Map<string, string>()

/** 同一个 fileID 的换址请求只发一次（榜单里同一张头像会出现多次） */
const inflight = new Map<string, Promise<string>>()

export function resolveCloudFileUrl(fileID: string | null | undefined): Promise<string> {
  if (!fileID) return Promise.resolve('')
  // 已经是 http(s)（本机联调时后端可能直接给路径）→ 原样用
  if (/^https?:\/\//.test(fileID)) return Promise.resolve(fileID)

  const hit = cache.get(fileID)
  if (hit) return Promise.resolve(hit)

  const running = inflight.get(fileID)
  if (running) return running

  const task = (async () => {
    try {
      // ⚠️ wx.cloud 没初始化（游客模式 / 未开通云开发）时会抛，
      //    要挡成空串 —— 不能让一张头像把整页带崩
      if (typeof wx.cloud?.getTempFileURL !== 'function') return ''
      const res = await wx.cloud.getTempFileURL({
        config: { env: CLOUD_ENV_ID },
        fileList: [fileID],
      })
      const url = res.fileList?.[0]?.tempFileURL ?? ''
      if (url) cache.set(fileID, url)
      return url
    } catch (err) {
      console.warn('[cloud-file] 换取地址失败：' + (err as Error).message)
      return ''
    } finally {
      inflight.delete(fileID)
    }
  })()

  inflight.set(fileID, task)
  return task
}
