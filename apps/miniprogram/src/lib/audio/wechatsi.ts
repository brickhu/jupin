/**
 * ⭐ **微信同声传译插件**（WechatSI）的**唯一访问层**。
 *
 * ⚠️ 为什么要单独一层：同一个插件被两处用到 —— `lib/audio/tts.ts`（文本→语音）
 *    与 `lib/audio/asr.ts`（语音→文本）。插件名、取插件的方式、"没配置时说什么"
 *    这三件事**必须只有一份**，否则改了 app.json 的 provider 会漏改一处。
 *
 * ⚠️⚠️ **前置条件不在代码里，在微信公众平台**：
 *    设置 → 第三方设置 → 插件管理 → 添加插件 → 搜「微信同声传译」。
 *    ⚠️ 没加过的话 `requirePlugin` 会抛错 / 开发者工具报插件不存在 ——
 *      这是**一次性配置**，也是最常见的"代码明明写了却没反应"的原因，
 *      所以下面的话术必须把它写出来（别只报"失败"）。
 *    ⚠️ `app.json` 里的 version / provider 也要和平台上的一致。
 */

/** app.json 的 plugins 键名 —— 改这里要连 app.json 一起改 */
export const PLUGIN_NAME = 'WechatSI'

/** 一次性配置没做时的统一话术 —— 它比"调用失败"有用得多 */
export const PLUGIN_HINT =
  '同声传译插件没生效：请在微信公众平台「设置 → 第三方设置 → 插件管理」里添加「微信同声传译」，再重新编译'

/**
 * 拿插件实例；没在 app.json 声明 / 平台上没添加 / 版本不对时返回 null。
 *
 * ⚠️ 一律返回 null 而**不抛**：调用方要给用户一句明确的话，
 *    而不是让一个同步异常炸掉整个页面（见 tts / asr 两处的用法）。
 * ⚠️ `requirePlugin` 是小程序引擎注入的**运行时全局**，vitest 里没有 ——
 *    所以 try/catch 同时兜住了"没声明"和"测试环境"两种情况。
 */
export function getPlugin<T>(): T | null {
  try {
    return requirePlugin(PLUGIN_NAME) as T
  } catch {
    return null
  }
}
