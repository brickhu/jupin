/**
 * 对象存储抽象 —— 与 ScoreEngine 同样的思路：薄接口 + 可替换实现。
 *
 * 背景（见 docs/research/miniprogram-api-constraints.md）：
 *   小程序 → 云托管服务的请求体有大小限制（实测大请求报 nginx 413），
 *   而 20 秒 16k 音频约 640KB，**远超限制**。
 *   所以音频必须走「小程序 → 对象存储直传 → 后端按 id 取回」这条路。
 *
 * 这样做的额外收益：
 *   1. 上传进度可通过 UploadTask 监听
 *   2. 用户音频可留存，支撑「点词回放」
 */
export interface ObjectStorage {
  readonly name: string
  /** 按 key 取回对象内容 */
  get(key: string): Promise<Uint8Array>
  /** 删除对象（用于「提交后即删」的隐私策略） */
  remove(key: string): Promise<void>
}

/** 小程序直传后拿到的 fileID 形如 cloud://env.bucket/path 或纯 key */
export function normalizeKey(fileID: string): string {
  if (!fileID.startsWith('cloud://')) return fileID
  const rest = fileID.slice('cloud://'.length)
  const slash = rest.indexOf('/')
  return slash >= 0 ? rest.slice(slash + 1) : rest
}
