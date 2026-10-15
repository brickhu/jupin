/* ⚠️ 自动生成，请勿手改 —— 重新生成：node tools/iconfont/build.mjs */
/* 名单的源头是 tools/iconfont/build.mjs 的 ICONS：那边加一行，这里就有。 */

/**
 * ⭐ **图标名单里真实存在的 iconify 名**。
 *
 * ⚠️⚠️ 这是全项目**唯一**的图标名单：校验、组件都读它，
 *    不许在别处手抄一份 —— 手抄的那份漂过（写过从来没进过名单的 `heart`、漏过 `check`）。
 * ⚠️ 名字必须带集合前缀（`mdi:play` / `clarity:favorite-solid`）：
 *    不同集合的 id 空间独立，只写后半段会含糊。
 */
export const ICON_NAMES = [
  'mdi:play', // 卡片/结果页 播放
  'mdi:loading', // 音频按钮 loading（旋转的弧）
  'mdi:stop', // 金句卡 停止
  'mdi:chevron-right', // 卡片/排名行 进入
  'mdi:chevron-left', // 导航栏 返回
  'mdi:share-variant', // 结果页 分享
  'mdi:heart-outline', // 结果页 点赞
  'mdi:home', // 导航栏 / 用户面板 我的主页
  'mdi:target', // 用户面板 参与场次
  'mdi:clipboard-text-outline', // 用户面板 我的挑战
  'mdi:fire', // 用户面板菜单 连战记录
  'mdi:bell-outline', // 用户面板 通知
  'mdi:check', // 金句卡 已参与角标（右下角圆形勾）
  'material-symbols:mic-outline', // 参与区 try/retry · 麦克风 20×20
  'material-symbols:undo', // 参与区 recoded/checking/scored · 重录（↺）14×14
  'material-symbols:play-arrow', // 参与区 三态共用 · 试听我的录音 14×14
  'material-symbols:check', // 参与区 recoded · 确认提交 14×14
  'material-symbols:progress-activity-sharp', // 参与区 checking · 转圈 24×24
  'material-symbols:arrow-forward-ios', // 参与区 scored · 进入（›）12×12
  'mdi:magnify', // 标签页 搜索框左侧的放大镜
  'mdi:close', // 标签页 清空搜索
  'mdi:tag-outline', // 首页「看全部标签」入口
  'clarity:favorite-line', // 竞技场 收藏（未收藏）
  'clarity:favorite-solid', // 竞技场 收藏（已收藏）
] as const

export type IconName = (typeof ICON_NAMES)[number]

/**
 * ⚠️ 与 `ICON_NAMES` **同序**的类名后缀（生成物）。
 * ⭐ 存在的理由：类名**不总是**"冒号后面那一段"—— 写了别名的图标不是。
 *    测试拿它与 `icons.wxss` 里真实定义的类名逐一对账。
 */
export const ICON_CLASSES = ['play', 'loading', 'stop', 'chevron-right', 'chevron-left', 'share-variant', 'heart-outline', 'home', 'target', 'clipboard-text-outline', 'fire', 'bell-outline', 'check', 'ms-mic', 'ms-undo', 'ms-play', 'ms-check', 'ms-loading', 'ms-arrow', 'magnify', 'close', 'tag-outline', 'favorite-line', 'favorite-solid'] as const

/** ⭐ 只有**写了别名**的图标才出现在这里；没写的就是冒号后面那一段 */
const CLASS_SUFFIX: Readonly<Record<string, string>> = {
  'material-symbols:mic-outline': 'ms-mic',
  'material-symbols:undo': 'ms-undo',
  'material-symbols:play-arrow': 'ms-play',
  'material-symbols:check': 'ms-check',
  'material-symbols:progress-activity-sharp': 'ms-loading',
  'material-symbols:arrow-forward-ios': 'ms-arrow',
}

const ICON_NAME_SET: ReadonlySet<string> = new Set<string>(ICON_NAMES)

/** 这个名字在名单里吗？（不在的话画不出来 —— 只有一块空白，控制台会提醒） */
export function isIconName(name: string): boolean {
  return ICON_NAME_SET.has(String(name ?? '').trim())
}

/**
 * iconify 名 → CSS 类名：`clarity:favorite-solid` → `ui-icon-favorite-solid`。
 * ⚠️ 默认是"冒号后面那一段"；**写了 `as` 别名的用它**（见 `CLASS_SUFFIX`）——
 *    别名不是装饰：查不到就会拼出一个 wxss 里不存在的类名，**图标静默不画**。
 */
export function iconClassOf(name: string): string {
  const n = String(name ?? '').trim()
  // ⭐ 先查别名表，再退回"冒号后面那一段"
  const md = CLASS_SUFFIX[n] ?? n.split(':').pop() ?? ''
  return md ? 'ui-icon-' + md : ''
}
