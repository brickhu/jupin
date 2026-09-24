import { BASE_URL, CLOUD_ENV_ID } from '../../config'

/**
 * ⭐ 标准音的取用 —— **两级缓存，都是会话级的**。
 *
 * ══════════════════════════════════════════════════════════════════
 * 为什么要有本地这一级：
 *
 *   只把**远端地址**给 InnerAudioContext，每次点喇叭都是一次网络下载 ——
 *   同一句反复听（这是朗读页最高频的动作）就反复下同一段音频；
 *   弱网下还表现为「点了要等一下才出声」。
 *
 *   ⇒ 第一次拿到就落成本地临时文件，之后**本地直接播**。
 *     朗读页进页面时还会**后台预拉取**整句 + 逐词音（见 prefetchAudio），
 *     所以正常路径上点下去是**立刻出声**的。
 * ══════════════════════════════════════════════════════════════════
 *
 * ⚠️⚠️ 为什么 cloud 那条走 `wx.cloud.downloadFile` 而不是 `wx.downloadFile`：
 *    `wx.downloadFile` 要先把域名配进「downloadFile 合法域名」——
 *    而标准音在**云开发对象存储**里，用云开发通道下载**根本不需要配域名**，
 *    和用户录音走的是同一条路（wx.cloud.uploadFile）。
 *    少一道控制台配置，就少一个「真机上播不响」的坑。
 *
 * ⚠️ 缓存键用**音频身份**（fileID / 服务端路径），不是临时地址 ——
 *    临时地址两小时就会换一份，拿它当键等于永远命中不了。
 *
 * ⚠️ 两级都是**会话级**（模块级 Map，小程序进程活着就一直有效）：
 *    不落 storage、不做过期清理 —— 临时文件由宿主自己回收，
 *    而把地址或路径落盘反而会引入「存下来的东西过期了」这种更难查的问题。
 */

/** 音频身份 → 远端可播地址（getTempFileURL 换来的，约两小时有效） */
const urlCache = new Map<string, string>()
/** 音频身份 → **本地临时文件路径**（本次会话内一直可用） */
const localCache = new Map<string, string>()
/** 进行中的下载：同一个身份不重复下（预拉取和用户点击会撞在一起） */
const inflight = new Map<string, Promise<string>>()

function keyOf(src: string, kind: 'cloud' | 'http'): string {
  return kind + ':' + src
}

/**
 * 把内容接口给的 audio 值换成**可直接播的远端地址**。失败返回空串
 * （调用方据此给一句人话，而不是静默无声）。
 *
 * ⚠️ 它是"退路"：正常情况下应该用 ensureLocalAudio 拿本地文件。
 *    消息里所有直接播远端地址的地方都应当能从这里退回来。
 *
 * @param src  见 shared 的 AudioRef / ArticleDetailAudio
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
  const hit = urlCache.get(fileId)
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
    if (url) urlCache.set(fileId, url)
    return url
  } catch (err) {
    console.warn('[audio] 换取标准音地址失败：' + (err as Error).message)
    return ''
  }
}

/**
 * ⭐ 把标准音下到本地，返回**本地文件路径**（拿不到就退回远端地址）。
 *
 * 调用方只管拿结果去播 —— 本地还是远端由这里决定，播放那侧不需要知道。
 */
export async function ensureLocalAudio(
  src: string | null | undefined,
  kind: 'cloud' | 'http',
): Promise<string> {
  if (!src) return ''
  const key = keyOf(src, kind)

  const cached = localCache.get(key)
  if (cached) return cached

  // ⚠️ 已经在下的就别再下一遍：预拉取刚发起、用户就点了喇叭，这种撞车很常见
  const running = inflight.get(key)
  if (running) return running

  const task = (async () => {
    try {
      const path = await downloadToLocal(src, kind)
      if (path) {
        localCache.set(key, path)
        return path
      }
    } catch (err) {
      // ⚠️ 预取失败不是错误路径，是"这次慢一点"：安静地退回远端地址
      console.warn('[audio] 标准音落盘失败，回退远端地址：' + (err as Error).message)
    } finally {
      inflight.delete(key)
    }
    return resolveAudioUrl(src, kind)
  })()

  inflight.set(key, task)
  return task
}

/** 真正把音频取到本地 */
async function downloadToLocal(src: string, kind: 'cloud' | 'http'): Promise<string> {
  if (kind === 'cloud') {
    // ⭐ 云开发通道：不需要配 downloadFile 合法域名
    if (typeof wx.cloud?.downloadFile !== 'function') return ''
    const res = await wx.cloud.downloadFile({ fileID: src, config: { env: CLOUD_ENV_ID } })
    return res.tempFilePath ?? ''
  }

  // 本机联调（http）才会走到这里；容器模式下服务端只会给 cloud
  const url = await resolveAudioUrl(src, kind)
  if (!url) return ''
  const res = await new Promise<WechatMiniprogram.DownloadFileSuccessCallbackResult>(
    (resolve, reject) => {
      wx.downloadFile({
        url,
        success: resolve,
        fail: (e) => reject(new Error(e.errMsg)),
      })
    },
  )
  return res.tempFilePath ?? ''
}

/**
 * ⭐ 后台预拉取 —— 进朗读页就把它做掉，等用户点喇叭时已经是本地文件了。
 *
 * ⚠️ 刻意**不返回 Promise、也不抛**：预拉取是**优化**，
 *    失败了顶多回到"点了等一下"，绝不该影响页面本身。
 * ⚠️ 并发压到 3：一段话几十个逐词音，一次性全发出去会挤占
 *    小程序本就不宽的请求通道（而用户此刻可能正在录音/提交）。
 */
export function prefetchAudio(
  items: { src: string | null | undefined; kind: 'cloud' | 'http' }[],
  concurrency = 3,
): void {
  const queue = items.filter(
    (it): it is { src: string; kind: 'cloud' | 'http' } =>
      !!it.src && !localCache.has(keyOf(it.src, it.kind)),
  )
  if (queue.length === 0) return

  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const it = queue[next++]
      if (!it) return
      await ensureLocalAudio(it.src, it.kind).catch(() => '')
    }
  }
  for (let i = 0; i < Math.min(concurrency, queue.length); i++) void worker()
}

/** 只给自检/排查用：当前会话缓存了多少段 */
export function audioCacheStats(): { urls: number; locals: number } {
  return { urls: urlCache.size, locals: localCache.size }
}
