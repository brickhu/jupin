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
/**
 * ⚠️⚠️ **`getPlugin` 里那句 `requirePlugin(...)` 必须写【字面量】** ✗
 *    —— ⭐ 微信工具的静态分析只认字面量 ✓（⭐ 写变量它会误报"插件未使用" ✓）
 *    ⇒ ⚠️ 于是这里多一个**编译期**约束：⭐ 两边不一致就报错 ✓✓
 *    （⭐ 类型相同 ⇒ 通过；⭐ 值不同 ⇒ 下面那行报错 ✓）
 */
type _PluginNameGuard = typeof PLUGIN_NAME extends 'WechatSI' ? true : never
const _pluginNameGuard: _PluginNameGuard = true
void _pluginNameGuard

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
    /**
     * ⚠️⚠️ **这里必须写【字面量】** ✗（⭐ 2026-10-10 修 ✓）
     *
     *    ⚠️ 原来是 `requirePlugin(PLUGIN_NAME)` ✗ —— ⭐ `PLUGIN_NAME` 是个变量 ✓
     *    ⇒ ⚠️ **微信开发者工具的静态分析看不出这用了哪个插件** ✗
     *    ⇒ ⭐ **代码质量报告误报「There are unused plugins: wx069ba97219f66d99」** ✓✓
     *       （⭐ 那个 id 就是 `WechatSI` 的 provider ✓）
     *
     *    ⭐ 写成字面量之后工具就能看出来 ✓
     *    ⚠️ 字面量必须与 `PLUGIN_NAME` **一致** ✗ ——
     *       ⭐ `PLUGIN_NAME` 上面那条 `_PluginNameGuard` 就是管这件事的 ✓
     *       （⭐ 两边不一致时**编译期**就报错 ✓ 不靠人记得 ✓）
     */
    return requirePlugin('WechatSI') as T
  } catch {
    return null
  }
}
