/** 全局 App 数据类型（与 src/app.ts 的 globalData 对应） */
interface IAppOption {
  globalData: {
    ready: boolean
    isMember: boolean
    nextFreeAt: string
  }
  onLaunch?: () => void
}
