import { iconClassOf, isIconName } from '../../lib/icon-names'

/**
 * ⭐ **图标组件** —— 页面只写 **iconify 名**，不写类名。
 *
 *     <ui-icon name="clarity:favorite-solid" class="text-40rpx text-ink" />
 *
 * ⚠️ 渲染出来是一个 **1em 的方块 + CSS mask**（见生成的 src/icons.wxss）：
 *    尺寸跟着字号（1em）、颜色吃 currentColor、每个图标按自己的 viewBox 撑满那一格。
 * ⚠️ 名字为什么是 `ui-icon` 而不是 `icon`：小程序**自带**一个 `<icon>`（`type="success"`
 *    那个），同名会去覆盖内置组件 —— 覆盖行为各家基础库不一定一致，别趟这浑水。
 *    前缀 `ui-` 与仓库里的 `ui-button` 保持一致。
 *
 * ⚠️⚠️ 为什么要有它：以前各处手写 `<text class="iconfont icon-heart-outline">`，
 *    于是"有哪些图标""叫什么名字"散落在页面里，谁也不知道某个名字到底存不存在；
 *    而写错一个**不存在的名字不会报错，只是那块空白**（比画个空框还难发现）。
 *    现在名字只有一处（`tools/iconfont/build.mjs` 的 ICONS，生成 `lib/icon-names.ts`），
 *    这里拿它校验，写错了控制台会点名。
 *
 * ⚠️ 样式：图标**跟着宿主走** —— 颜色（currentColor）与尺寸（1em）都由调用方的 class 决定。
 *    ⇒ 把排版类写在 `<ui-icon>` 自己身上（它就是一个 inline 的宿主节点），例如
 *      `class="text-40rpx text-ink ml-2"`。
 *
 * ⚠️⚠️ `apply-shared` 不能去掉：`.ui-icon` 与 `.ui-icon-*` 定义在 app.wxss（icons.wxss）里，
 *    默认的 isolated 组件**拿不到全局类**，表现是图标整个不显示（且不报错）。
 *    同理见 components/audio-button（那里也写着这条）。
 */
Component({
  options: { styleIsolation: 'apply-shared' },

  properties: {
    /** iconify 名，**必须带集合前缀**：`mdi:play` / `clarity:favorite-solid` */
    name: { type: String, value: '' },
  },

  data: {
    /** 拼好的字体类名（`icon-favorite-solid`）—— 由 name 派生，页面不用管 */
    cls: '',
  },

  observers: {
    name(name: string) {
      const n = String(name ?? '').trim()
      /**
       * ⚠️ 不在子集里就**当场点名**（而不是安静地画不出来）。
       *    加图标：tools/iconfont/build.mjs 的 ICONS 加一行，重跑那个脚本。
       */
      if (n && !isIconName(n)) {
        console.warn(
          '[icon] 这个图标不在名单里（不会显示）：' +
            n +
            ' —— 把它加进 tools/iconfont/build.mjs 的 ICONS 再重新生成（见 lib/icon-names.ts）',
        )
      }
      this.setData({ cls: iconClassOf(n) })
    },
  },
})
