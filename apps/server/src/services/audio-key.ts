import { createHash } from 'node:crypto'
import { RECORD_SPEC } from '@jushuo/shared'

/**
 * 提交记录的标识与音频路径规范 —— **纯函数，零 DB 依赖**（可单测）。
 *
 * ⭐ 两个 id 互相独立：
 *   submissionId = hash(userId, articleId, seq)   —— 服务端算
 *   audioKey     = audio/{articleId}/{userId}/{ts}.{后缀}  —— 客户端上传时就得知道
 *
 * ⚠️ 后缀跟着**录音格式**走：现在客户端录的是微信接口的默认格式 aac（见 RECORD_SPEC），
 *    所以库里常见的是 `.aac`（平台上也可能是 `.m4a`）。
 *    历史遗留还有两种：老客户端传的裸 `.pcm`，以及服务端给它们补的 `.mp3` 存档
 *    （见 services/recording.ts）。**内容一律按文件头判断**，不看后缀。
 */

const AUDIO_PREFIX = 'audio'

export function makeSubmissionId(userId: number, articleId: number, seq: number): string {
  return createHash('sha256')
    .update(`jushuo:${userId}:${articleId}:${seq}`)
    .digest('hex')
    .slice(0, 24)
}

export function makeAudioKey(articleId: number, userId: number, timestampMs: number): string {
  return `${AUDIO_PREFIX}/${articleId}/${userId}/${timestampMs}.${RECORD_SPEC.extension}`
}

/**
 * 校验客户端给的上传路径是否合法、且属于当前用户。
 * ⚠️⚠️ 安全边界：服务端要按这个 key 读音频；不校验的话，
 *    客户端可以传别人的 key 把别人的高分录音拿来当自己的提交。
 */
/**
 * 校验客户端给的**带签名下载地址**确实是「我们自己的桶 + 这个用户的这条音频」。
 *
 * ⚠️⚠️ 为什么需要这条额外的路（以及它为什么是安全的）：
 *
 *   正规做法是服务端自己用 COS-SDK 去读（见 storage/wxcloud.ts），
 *   但那要先通过「开放接口服务」拿临时密钥 —— 而本项目在 dev 环境上
 *   实测该服务**始终没有旁加载到实例**（容器内 api.weixin.qq.com 解析到公网 IP、
 *   响应头没有 x-openapi-seqid），导致提交必然 400「读取音频失败」。
 *
 *   所以补一条不依赖它的路：小程序用 wx.cloud.getTempFileURL 拿到**带签名的 https 地址**
 *   交给服务端去拉。签名是微信云存储签的，客户端伪造不出来。
 *
 *   ⚠️ 但这条路的**唯一风险**是：客户端可以换一个 URL 去指向别人的音频，
 *      或者拿它当 SSRF 跳板。下面两条校验把这两个风险都掐死：
 *        ① host 必须**恰好**是我们自己的桶（不是任意域名）→ SSRF 面归零
 *        ② 从 URL 路径里解出来的对象 key，必须**逐字符等于**那条已经通过
 *           assertAudioKeyOwnedBy 校验的 audioKey → 冒充他人音频归零
 *
 * ⚠️ 顺序很重要：**先** assertAudioKeyOwnedBy(audioKey)，**再**本函数。
 *    本函数只负责「这个 URL 指的就是 audioKey 那个对象」，不负责 uid 归属。
 */
export function assertAudioUrlMatchesKey(input: {
  audioUrl: string
  audioKey: string
  bucket: string
  region: string
}): void {
  const { audioUrl, audioKey, bucket, region } = input

  // ⚠️ 没配桶/地域时必须单独报错。否则期望的 host 会变成 ".cos..myqcloud.com"，
  //    任何地址都会被判成「桶不对」—— 报错完全指向不了真正的原因（配置缺失）。
  if (!bucket || !region) {
    throw new Error(
      '服务端缺少 COS_BUCKET / COS_REGION，无法校验音频下载地址。' +
        '正常情况下 pnpm deploy:dev / deploy:prod 会自动注入（见 tools/deploy-cloud.mjs）。',
    )
  }

  let url: URL
  try {
    url = new URL(audioUrl)
  } catch {
    throw new Error('音频下载地址不是合法 URL')
  }

  if (url.protocol !== 'https:') {
    throw new Error(`音频下载地址必须是 https（实际 ${url.protocol}）`)
  }

  // ① 域名白名单 —— 这一条同时把 SSRF 面掐死
  const expectedHost = `${bucket}.cos.${region}.myqcloud.com`
  // ⚠️ 实测：wx.cloud.getTempFileURL 返回的**不是** COS 直连域名，
  //    而是云开发的存储网关 <...>.tcb.qcloud.la（形如 6465-dev-xxx-1258596499.tcb.qcloud.la）。
  //    两者都接受。
  // ⚠️ 只放行这两个，**不要**写成「以 .myqcloud.com 结尾」——
  //    那等于放行任意账号的任意 COS 桶，白名单就形同虚设了。
  const isOurBucket = url.hostname === expectedHost
  const isTcbGateway = url.hostname.endsWith('.tcb.qcloud.la')
  if (!isOurBucket && !isTcbGateway) {
    // ⚠️ 报错必须带上**实际收到的**域名 —— 只说期望值的话，
    //    排查时完全看不出对方给的是什么（这个坑刚踩过）。
    throw new Error(
      `音频下载地址的域名不在允许范围内：实际收到 ${url.hostname}，` +
        `只接受 ${expectedHost} 或 *.tcb.qcloud.la`,
    )
  }

  // ② 路径必须指向这条音频 —— 防止拿别人的音频来提交
  // ⚠️ 必须先解码：签名 URL 的路径是 URL-encoded 的
  let path: string
  try {
    path = decodeURIComponent(url.pathname).replace(/^\/+/, '')
  } catch {
    throw new Error('音频下载地址的路径无法解码')
  }
  // ⚠️ 用 endsWith 而不是全等：网关域名可能在前面带一层路径前缀。
  //    这**不会**削弱安全性 —— 对象存储的路径就是 key 本身，
  //    「以自己那条 key 结尾」仍然只可能指向自己那条音频。
  if (path !== audioKey && !path.endsWith('/' + audioKey)) {
    throw new Error(
      `音频下载地址指向的对象与 audioKey 不一致：路径结尾是 /${path.split('/').slice(-4).join('/')}，期望 ${audioKey}`,
    )
  }
}

export function assertAudioKeyOwnedBy(audioKey: string, userId: number, articleId: number): void {
  const parts = audioKey.split('/')
  if (parts.length !== 4) throw new Error('音频路径格式不对')

  const [prefix, articlePart, userPart, filePart] = parts as [string, string, string, string]
  if (prefix !== AUDIO_PREFIX) throw new Error('音频路径前缀不对')
  /**
   * ⚠️⚠️ 只校验**名字的形状**（时间戳 + 短后缀），**不枚举后缀**：
   *    · 后缀跟着录音格式走（RECORD_SPEC），而各平台落盘的后缀未必一样 ——
   *      开发者工具甚至会给 `.webm`。枚举式白名单的后果是「换个格式，
   *      所有提交突然全被挡在门外」，而报错只有一句「音频文件名不对」，
   *      排查时很容易怀疑到别处去（客户端那边会看到 submit 直接 400）。
   *    · 这里挡的是**路径穿越与非法文件名**（不能有 `/`、不能有第二个点）；
   *      内容是什么一律由服务端按文件头 sniff（services/audio.ts），
   *      所以后缀本来就不能被用来骗过什么。
   */
  if (!/^\d{10,}\.[a-z0-9]{1,5}$/.test(filePart)) throw new Error('音频文件名不对')

  if (Number(articlePart) !== articleId) throw new Error('音频路径里的文章与提交的不一致')
  if (Number(userPart) !== userId) throw new Error('音频路径不属于当前用户')
}
