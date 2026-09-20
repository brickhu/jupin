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
  /**
   * 写入对象。
   *
   * ⚠️ 原先只有本地实现提供，理由是「线上写入永远由小程序直传完成」。
   *    那个前提**对用户录音成立，对内容侧的静态资源不成立** ——
   *    标准音是我们自己生成的文件，没有任何小程序会去上传它，
   *    只能由服务端写进对象存储（见 services/standard-audio.ts）。
   *
   * ⚠️ 云托管下的写权限来自「开放接口服务」发的**临时密钥**
   *    （和读用的是同一份，见 wxcloud.ts 的 getAuth）。
   */
  put(key: string, data: Uint8Array): Promise<void>

  /**
   * 对象是否存在。
   *
   * ⚠️ 存在的意义是**幂等**：内容资源每次冷启动都重传一遍是纯浪费，
   *    而「先 get 再判断 NoSuchKey」会把一个正常的探测写成一条错误日志，
   *    在排查真正的故障时淹没现场。
   */
  exists(key: string): Promise<boolean>
}

/** 小程序直传后拿到的 fileID 形如 cloud://env.bucket/path 或纯 key */
export function normalizeKey(fileID: string): string {
  if (!fileID.startsWith('cloud://')) return fileID
  const rest = fileID.slice('cloud://'.length)
  const slash = rest.indexOf('/')
  return slash >= 0 ? rest.slice(slash + 1) : rest
}
