import { readStaticFile } from './content'
import { mp3DurationMs } from './mp3-duration'
import { audioKeyOf, audioRefOf } from './standard-audio'

/**
 * ⭐ 标准音的**时长** —— 卡片上要显示「这一段多长」。
 *
 * ⚠️⚠️ 为什么是现算而不是落库：
 *    · 时长是**内容的属性**，和 MP3 文件绑在一起；库里存一份就是第二份真相
 *      （音频换了、库忘改，卡片上的时长就开始骗人）
 *    · 运行容器里没有 ffprobe，所以只能自己解析（见 mp3-duration.ts）
 *    · 音频文件本身就在镜像里（Dockerfile COPY content），读得到
 *
 * ⚠️ 进程内缓存：一篇只解析一次。首页一次要 7 张卡片、而池子里通常只有几句，
 *    所以命中率很高；解析一个 20–50KB 的文件也就几十微秒。
 * ⚠️ 解析不出来（文件缺失 / 编码不认）就返回 null，
 *    客户端据此**只显示按钮、不显示时长** —— 而不是显示一个 0:00。
 */
const cache = new Map<number, number | null>()

export async function standardAudioMs(articleId: number): Promise<number | null> {
  const hit = cache.get(articleId)
  if (hit !== undefined) return hit

  let value: number | null = null
  try {
    /**
     * ⚠️⚠️ 路径必须走 audioKeyOf（它返回 content/audio/{id}.mp3）——
     *    静态资源的根目录是**仓库根 / /app**，不是 content/ 那一层
     *    （contentJson 里自带 content/ 这一段，见 services/content.ts 的注释）。
     *    我第一版写成 'audio/{id}.mp3' ⇒ 永远读不到文件 ⇒ 时长永远不显示，
     *    而且**不报错**。用 audioKeyOf 就不会再犯：磁盘路径与对象存储 key 同源。
     */
    const bytes = await readStaticFile(audioKeyOf(articleId))
    if (bytes) value = mp3DurationMs(Buffer.from(bytes))
  } catch (err) {
    console.warn('[audio] 读标准音算时长失败（articleId=' + articleId + '）：' + (err as Error).message)
  }
  cache.set(articleId, value)
  return value
}

/**
 * ⭐ 卡片上要的标准音：可播引用 + 时长。
 * ⚠️ 没有标准音时返回 null —— 客户端据此**不渲染播放入口**，
 *    而不是渲染一个点了 404 的按钮（同 audioRefOf 的约定）。
 */
export async function scheduleAudioOf(article: {
  id: number
  standardAudio: string | null
}): Promise<{ full: string; kind: 'cloud' | 'http'; durationMs: number | null } | null> {
  const ref = audioRefOf(article)
  if (!ref) return null
  return { full: ref.full, kind: ref.kind, durationMs: await standardAudioMs(article.id) }
}
