import type { ObjectStorage } from './types'
import { normalizeKey } from './types'

/**
 * 微信云托管对象存储实现。
 *
 * ⚠️⚠️ 尚未接真实环境 —— 需要先在云托管控制台创建环境后，补齐下面两处：
 *
 *   1. **读取路径**：云托管对象存储底层是 COS。服务端读取有两条路：
 *      a) 用 COS SDK（cos-nodejs-sdk-v5）+ 密钥直读对象
 *      b) 用微信服务端接口换取临时下载链接，再 fetch
 *      官方文档章节：操作指南 / 对象存储 / 服务端和其他客户端
 *
 *   2. **凭据来源**：云托管环境变量注入，或自建 COS 桶。
 *
 * 在小程序侧，上传用的是 wx.cloud.uploadFile（免域名、免备案、无大小限制），
 * 它返回的 fileID 会作为参数传到这里。
 */
export class WxCloudStorage implements ObjectStorage {
  readonly name = 'wxcloud'

  constructor(
    private readonly cfg: {
      envId: string
      /** COS 桶与地域（若走 COS SDK 直读） */
      bucket?: string
      region?: string
    },
  ) {}

  async get(fileID: string): Promise<Uint8Array> {
    const key = normalizeKey(fileID)
    // TODO(云环境就绪后实现)：按 key 从对象存储读取
    //   走通后删掉这个 throw，并补一个集成测试
    throw new Error(
      `WxCloudStorage.get 尚未实现（key=${key}, env=${this.cfg.envId}）。` +
        '请参考 spec.md「对象存储」一节补齐读取路径。',
    )
  }

  async remove(fileID: string): Promise<void> {
    const key = normalizeKey(fileID)
    void key
    // TODO(云环境就绪后实现)
  }
}
