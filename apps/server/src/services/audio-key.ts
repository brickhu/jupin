import { createHash } from 'node:crypto'

/**
 * 提交记录的标识与音频路径规范 —— **纯函数，零 DB 依赖**（可单测）。
 *
 * ⭐ 两个 id 互相独立：
 *   submissionId = hash(userId, articleId, seq)        —— 服务端算
 *   audioKey     = audio/{articleId}/{userId}/{ts}.pcm  —— 客户端上传时就得知道
 */

const AUDIO_PREFIX = 'audio'

export function makeSubmissionId(userId: number, articleId: number, seq: number): string {
  return createHash('sha256')
    .update(`jushuo:${userId}:${articleId}:${seq}`)
    .digest('hex')
    .slice(0, 24)
}

export function makeAudioKey(articleId: number, userId: number, timestampMs: number): string {
  return `${AUDIO_PREFIX}/${articleId}/${userId}/${timestampMs}.pcm`
}

/**
 * 校验客户端给的上传路径是否合法、且属于当前用户。
 * ⚠️⚠️ 安全边界：服务端要按这个 key 读音频；不校验的话，
 *    客户端可以传别人的 key 把别人的高分录音拿来当自己的提交。
 */
export function assertAudioKeyOwnedBy(audioKey: string, userId: number, articleId: number): void {
  const parts = audioKey.split('/')
  if (parts.length !== 4) throw new Error('音频路径格式不对')

  const [prefix, articlePart, userPart, filePart] = parts as [string, string, string, string]
  if (prefix !== AUDIO_PREFIX) throw new Error('音频路径前缀不对')
  if (!/^\d{10,}\.pcm$/.test(filePart)) throw new Error('音频文件名不对')

  if (Number(articlePart) !== articleId) throw new Error('音频路径里的文章与提交的不一致')
  if (Number(userPart) !== userId) throw new Error('音频路径不属于当前用户')
}
