/**
 * ⭐⭐ **KWS 模型的位置**（端侧逐词标注用）—— 只负责"它在哪"，不负责传字节。
 *
 * ## 为什么服务端只给一个 fileID、不自己回吐 4.4MB
 *
 * ⚠️⚠️ 算过账（微信云托管官方价）：
 *   · 容器**公网流量 0.8 元/GB** ✗
 *   · 对象存储 **CDN 流量 0.18 元/GB** ✓（还有 3GB 免费额度 ✓）
 *   · 而**只通过 callContainer 访问不产生流量用量** ✓（免费 ✓）
 * ⇒ 模型字节走**对象存储**（客户端自己去 CDN 下 ✓），
 *   服务端只回一个**一百字节的 fileID** ✓ ⇒ 那点流量走 callContainer，**完全免费** ✓
 *
 * ## 为什么第一次调用时才上传
 *
 * 模型是**构建时**抓进 `content/kws/` 的 ✓ 不进 git ✓（见 scripts/fetch-kws-model.mjs）
 * ⇒ 部署完第一次问"模型在哪"的时候顺手 put 一次 ✓ 免得再要一个手动步骤 ✓
 * ⚠️ `put` 是幂等的 ✓ 而且先 `exists` 判一下 ⇒ 正常情况下只上传一次 ✓
 */
import { getStorage, fileIdOf } from '../storage'
import { readStaticFile } from './content'

/**
 * ⚠️ key 里带完整文件名 —— 换模型时**自然就是新 key** ✓
 *    （不要在客户端或别处硬编码：这里是唯一的出处 ✓）
 */
export const KWS_MODEL_KEY = 'kws/encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx'

export interface KwsModelInfo {
  /** 客户端拿去下字节的地址（云端是 cloud:// fileID ✓ 本机联调是 http 路径 ✓） */
  fileId: string
  key: string
  bytes: number
}

/** ⭐ 模型就绪就返回它的位置；`content/kws/` 里没有就返回 null（构建时抓漏了） */
export async function ensureKwsModel(): Promise<KwsModelInfo | null> {
  const bytes = await readStaticFile(KWS_MODEL_KEY)
  if (!bytes || bytes.byteLength < 1024 * 1024) {
    // ⚠️ 判大小是刻意的：读到一个**空文件/半个文件**时，宁可当"没就绪" ✓
    //    把坏文件传给端侧会表现为"模型加载失败"，比"没就绪"难查得多 ✗
    console.warn('[kws] 模型缺失或过小：' + KWS_MODEL_KEY)
    return null
  }

  const storage = getStorage()
  if (!(await storage.exists(KWS_MODEL_KEY))) {
    console.log('[kws] 首次上传模型到对象存储（' + bytes.byteLength + ' 字节）…')
    await storage.put(KWS_MODEL_KEY, bytes)
  }

  /**
   * ⚠️ `fileIdOf` 需要 WX_CLOUD_ENV_ID / COS_BUCKET（部署脚本注入 ✓）——
   *    本机没这两个变量时它会抛 ✗ ⇒ 这里兜住，回一句能自查的话 ✓
   */
  try {
    return { fileId: fileIdOf(KWS_MODEL_KEY), key: KWS_MODEL_KEY, bytes: bytes.byteLength }
  } catch (e) {
    console.warn('[kws] 拼不出 fileID：' + (e as Error).message)
    return null
  }
}
