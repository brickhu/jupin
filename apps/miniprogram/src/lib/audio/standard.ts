import { BASE_URL, CLOUD_ENV_ID } from '../../config'

/**
 * ⭐ 标准音的 fileID → 可播地址。
 *
 * ⚠️⚠️ 为什么走 cloud:// 而不是 HTTP 直链：
 *
 *   · 云托管通道下，API 走 callContainer **不拼 URL**（微信网关代劳），
 *     所以客户端根本没有一个「本服务的域名」可以用来取静态文件。
 *   · 而对象存储是**云开发自己的存储**：wx.cloud.getTempFileURL 直接换地址，
 *     **不需要配 downloadFile 合法域名**。少一道控制台配置就少一个「真机上播不响」的坑。
 *   · 和用户录音走的是同一套设施 —— 一个问题只有一种解法。
 *
 * ⚠️ 刻意**没有** mediaUrl / MEDIA_BASE_URL 那套东西：
 *    曾经为了「container 模式下没有 URL」加过一整套构建期域名注入，
 *    现在音频进了对象存储，那一层整个不需要了。
 */

/**
 * 临时地址的缓存。
 * ⚠️ 必须缓存：点同一个词两次、或同一句里两个相同的词，
 *    每次都换一次地址纯属白跑一趟网络。
 * ⚠️ 临时地址本身有有效期（约两小时），所以缓存的是**本次会话内**的，
 *    不做持久化 —— 存下来的地址过期了反而更难排查。
 */
const cache = new Map<string, string>()

/**
 * 把内容接口给的 audio 值换成**可直接播的地址**。失败返回空串
 * （调用方据此给一句人话，而不是静默无声）。
 *
 * @param src  见 ArticleContent.audio 的注释
 * @param kind 'cloud' = 云存储 fileID；'http' = 服务端路径
 */
export async function resolveAudioUrl(
  src: string | null | undefined,
  kind: 'cloud' | 'http',
): Promise<string> {
  if (!src) return ''
  // ⚠️ 本机模式：路径要加 BASE_URL。容器模式下 BASE_URL 是空串，
  //    但那种环境服务端给的一定是 'cloud'，走不到这里。
  if (kind === 'http') return BASE_URL ? BASE_URL + src : ''
  return resolveCloudUrl(src)
}

/** 云存储 fileID → 临时地址（带缓存） */
async function resolveCloudUrl(fileId: string): Promise<string> {
  const hit = cache.get(fileId)
  if (hit) return hit

  // ⚠️ wx.cloud 没初始化（游客模式 / 未开通云开发）时这里会抛，
  //    要挡成空串，不能让一个「听不到标准音」把整页带崩
  if (typeof wx.cloud?.getTempFileURL !== 'function') return ''

  try {
    const res = await wx.cloud.getTempFileURL({
      config: { env: CLOUD_ENV_ID },
      fileList: [fileId],
    })
    const url = res.fileList?.[0]?.tempFileURL ?? ''
    if (url) cache.set(fileId, url)
    return url
  } catch (err) {
    console.warn('[audio] 换取标准音地址失败：' + (err as Error).message)
    return ''
  }
}
