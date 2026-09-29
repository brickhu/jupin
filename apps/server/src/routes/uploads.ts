import { createRoute, OpenAPIHono } from '@hono/zod-openapi'
import { env } from '../env'
import { getStorage } from '../storage'
import { assertAudioKeyOwnedBy } from '../services/audio-key'
import type { Variables } from '../middleware/auth'
import { defaultHook } from '../openapi'
import { errorResponse, UploadResponseSchema } from '../openapi/schemas'

export const uploadsRoutes = new OpenAPIHono<{ Variables: Variables }>({ defaultHook })

/**
 * ⭐ 路由声明 —— **文档的来源**（见 openapi.ts 的说明）。
 *
 * ⚠️⚠️ 刻意**不声明 `request.body`**：声明了框架就会去校验表单，而它解析 multipart
 *    的行为会把正常上传打成 400（本机联调立刻全挂）。字段名写在 description 里。
 */
const uploadRoute = createRoute({
  method: 'post',
  path: '/',
  tags: ['挑战提交'],
  summary: '上传音频（仅 STORAGE=local 时可用；线上走对象存储直传）',
  description:
    '⚠️ 线上链路是「小程序 wx.cloud.uploadFile → 微信对象存储 → 服务端用 COS SDK 读」，' +
    '这条只服务本机联调（容器里没有 COS 凭证）。\n\n' +
    '请求体 multipart/form-data，字段：`articleId` / `audioKey` / `file`。\n\n' +
    '⚠️ `audioKey` 必须是 `audio/{句子}/{我自己}/{attemptId}.mp3` —— 服务端会**校验归属**。',
  security: [{ userToken: [] }],
  responses: {
    200: {
      content: { 'application/json': { schema: UploadResponseSchema } },
      description: '上传成功（返回 audioKey 与写入字节数）',
    },
    400: errorResponse('请求体不是 multipart/form-data / 缺 articleId、audioKey、file'),
    403: errorResponse('audioKey 不属于当前用户（路径归属校验失败）'),
    404: errorResponse('本端点只在 STORAGE=local 时可用'),
    500: errorResponse('存储实现不支持写入'),
  },
})

/**
 * 本地开发用的音频直传端点。
 *
 * ⚠️ 为什么需要它 —— 这是一条**真实的集成裂缝**：
 *    线上链路是「小程序 wx.cloud.uploadFile → 微信对象存储 → 服务端用 COS SDK 读」。
 *    但本地 Docker **没有 COS 凭证**：临时密钥要调 /_/cos/getauth，
 *    而那是微信云托管的内网接口，本机根本调不到。
 *    结果就是：小程序把音频传到了微信云，本地服务端在 .uploads/ 里找不到
 *    → 提交必然 400「读取音频失败」，而且看起来像是提交逻辑写错了。
 *
 * ⚠️ 所以本端点**只在 STORAGE=local 时开放**（云端部署 STORAGE=wxcloud，这里直接 404），
 *    落到 LocalStorage.put() —— 那个方法本来就是为「模拟小程序直传」预留的。
 *
 * ⚠️ 请求体大小：20 秒 16k/16bit 单声道约 640KB，**远超云托管那 100KiB 上限**。
 *    这条路只能本地走 —— 正好也是它的定位。
 */
uploadsRoutes.openapi(uploadRoute, async (c) => {
  if (env.STORAGE !== 'local') {
    return c.json({ ok: false, error: '本地直传端点仅在 STORAGE=local 时可用' }, 404)
  }

  const storage = getStorage()
  if (typeof storage.put !== 'function') {
    return c.json({ ok: false, error: `${storage.name} 实现不支持写入` }, 500)
  }

  const userId = c.get('userId')

  let form: FormData
  try {
    form = await c.req.formData()
  } catch {
    return c.json({ ok: false, error: '请求体不是 multipart/form-data' }, 400)
  }

  const articleIdRaw = form.get('articleId')
  const articleId = typeof articleIdRaw === 'string' ? articleIdRaw : ''
  const audioKey = String(form.get('audioKey') ?? '')
  const file = form.get('file')

  if (!articleId || !audioKey) {
    return c.json({ ok: false, error: '缺少 articleId 或 audioKey' }, 400)
  }
  if (!(file instanceof File)) {
    return c.json({ ok: false, error: '缺少 file 字段' }, 400)
  }

  // ⚠️ 与 /api/submissions 是同一条安全边界，必须同样校验 ——
  //    否则可以往别人的路径下写垃圾，再让服务端当别人的录音去评分。
  try {
    assertAudioKeyOwnedBy(audioKey, userId, articleId)
  } catch (err) {
    console.warn(`[uploads] 拒绝非法路径 user=${userId} key=${audioKey}`)
    return c.json({ ok: false, error: (err as Error).message }, 403)
  }

  const bytes = new Uint8Array(await file.arrayBuffer())
  await storage.put(audioKey, bytes)
  console.log(`[uploads] 本地直传 ${audioKey}（${bytes.byteLength} 字节）`)
  return c.json({ ok: true, data: { audioKey, bytes: bytes.byteLength } }, 200)
})
