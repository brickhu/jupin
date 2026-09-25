/**
 * ⭐ 文本 → 语音 —— 走**微信同声传译插件**（WechatSI）。
 *
 * ⚠️⚠️ 为什么是它（用户 2026-09 的决定："点词播放这个问题你不用纠结，直接微信TTS"）：
 *    **免费**、**不占外网域名白名单**、不依赖我们自己的服务端；代价是合成质量一般、
 *    且是**异步回调**（第一次点一个词要等 ~1s）。听到的是**词典式的孤立读音**，
 *    不是句中的连读/弱读形 —— 这是刻意的取舍：
 *      整句 → 我们自己灌的标准音（"这句话怎么念"）；
 *      点词 → 这里的 TTS（"这个词怎么念"）。
 *
 * ⚠️⚠️ **前置条件不在代码里，在微信公众平台**：
 *    设置 → 第三方设置 → 插件管理 → 添加插件 → 搜「微信同声传译」。
 *    ⚠️ 没加过的话 requirePlugin 会抛错 / 开发者工具报插件不存在 ——
 *      这是**一次性配置**，也是最常见的"代码明明写了却没声音"的原因，
 *      所以下面的错误话术必须把它写出来（别只报"失败"）。
 *    ⚠️ app.json 里的 version / provider 也要和平台上的一致（见 app.json 的 plugins）。
 *
 * ⚠️ 缓存放**模块级**，不放页面 data：data 必须可序列化（Map 不适合）。
 *    缓存的是插件给的**临时文件路径** —— 小程序重启就失效，那是插件的行为，
 *    我们不能把它复制进自己的目录（临时文件的生命周期由插件管）。
 */

/** 插件的方法签名 —— 只声明我们真正用到的那一个（多声明就会跟着对方的版本漂） */
interface TtsPlugin {
  textToSpeech: (o: {
    lang: string
    tts: boolean
    content: string
    success: (res: { filename?: string }) => void
    fail: (err: { retcode?: number; msg?: string }) => void
  }) => void
}

/** 一次性配置没做时的统一话术 —— 它比"合成失败"有用得多 */
export const PLUGIN_HINT =
  '同声传译插件没生效：请在微信公众平台「设置 → 第三方设置 → 插件管理」里添加「微信同声传译」，再重新编译'

/** 词 → 插件给出的本地临时文件路径 */
const cache = new Map<string, string>()

/**
 * ⚠️ 送进插件前**剥掉首尾的非字母**：插件会把标点念出来
 *    （"count." 会读成 "count period"、"Don't," 的逗号也会）。
 *    ⚠️ 只剥首尾：词**内部**的 ' 和 - 是词的一部分（don't / well-known）。
 */
export function stripToSpoken(text: string): string {
  return String(text ?? '').replace(/^[^a-zA-Z]+|[^a-zA-Z]+$/g, '')
}

/** 拿插件；没在 app.json 声明 / 平台上没添加 / 版本不对时返回 null（调用方给明确提示，不静默失败） */
function plugin(): TtsPlugin | null {
  try {
    return requirePlugin('WechatSI') as TtsPlugin
  } catch {
    return null
  }
}

/** 插件此刻能不能用 —— 界面可以用它决定要不要渲染发音入口 */
export function isTtsAvailable(): boolean {
  return plugin() !== null
}

/**
 * 合成一段文本，返回**可播的本地路径**（同一段文本第二次直接命中缓存，不再请求）。
 *
 * ⚠️ 失败一律 reject 且 message 是**给人看的**（页面直接弹它）——
 *    插件自己的 fail 回调里只有 retcode/msg，直接展示用户看不懂。
 */
export function speak(text: string): Promise<string> {
  const clean = stripToSpoken(text)
  if (clean === '') return Promise.reject(new Error('这个词没有可发音的内容'))

  const hit = cache.get(clean)
  if (hit !== undefined) return Promise.resolve(hit)

  const p = plugin()
  if (!p) return Promise.reject(new Error(PLUGIN_HINT))

  return new Promise<string>(function (resolve, reject) {
    /**
     * ⚠️ 传英文文本 + lang: 'en_US'：插件**默认是中文**，不指定语言会把单词按中文念
     *    （"count" 读成"康特"），而且不报错 —— 只能靠人听出来。
     */
    p.textToSpeech({
      lang: 'en_US',
      tts: true,
      content: clean,
      success: function (res) {
        const file = res && res.filename
        if (!file) {
          reject(new Error('合成了但没拿到音频文件，请再试一次'))
          return
        }
        cache.set(clean, file)
        resolve(file)
      },
      fail: function (err) {
        // ⚠️ 把 retcode 打进日志：光看 errMsg 分不清是配额、参数还是网络
        console.error('[tts] 合成失败', err)
        const code = err && err.retcode ? '（' + err.retcode + '）' : ''
        reject(new Error('合成失败' + code + '：' + PLUGIN_HINT))
      },
    })
  })
}
