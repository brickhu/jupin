/**
 * ⚠️ **跳转页**（临时 ✓ 探针验完就删）—— 它自己不做任何事。
 *
 * ## 为什么要多这一层
 *
 * 真正要验的 API 需要一个 **4.4MB 的 .onnx** ✗ —— 而主包上限 **2MB** ✗
 * ⇒ 模型只能在**分包**里 ✓ 而分包的页面路径是 `subpackages/kws/dev-probe` ✗
 *   ⇒ 编译模式/预览里要填一个**不一样的路径**，很容易填错（已经踩过两次 ✗）
 *
 * ⭐ 所以留这个**主包**页面在原路径上，它只负责跳过去：
 *    · 编译模式的路径**不用改**（还是 pages/dev-probe/dev-probe ✓）
 *    · **访问分包页面会自动加载分包** ✓ ⇒ 里面的模型自然就可读了 ✓
 *      （比 `loadSubpackage` / `require` 那套都省事 ✓ 而且不依赖我记对 API ✗）
 */
Page({
  onLoad() {
    wx.redirectTo({ url: '/subpackages/kws/dev-probe' })
  },
})
