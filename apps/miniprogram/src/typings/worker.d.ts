/**
 * Worker 执行上下文中的全局对象。
 * ⚠️ 微信官方类型包不包含它（Worker 是独立执行环境），故在此声明。
 */
declare const worker: {
  onMessage: <T = unknown>(listener: (msg: T) => void) => void
  postMessage: (msg: unknown) => void
}
