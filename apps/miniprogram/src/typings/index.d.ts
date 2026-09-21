/** 全局 App 数据类型（与 src/app.ts 的 globalData 对应） */
interface IAppOption {
  globalData: {
    ready: boolean
    isMember: boolean
    // ⚠️ 原来这里还有 nextFreeAt（24 小时冷却的"下次可免费提交时间"）——
    //    冷却已下线，改成「每句额度 + 固定间隔」，端侧不再需要记一个时间戳
  }
  onLaunch?: () => void
}
