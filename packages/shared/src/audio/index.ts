/**
 * 端侧音频算法 —— 全部是纯函数，零平台依赖。
 *
 * ⭐ 设计约束：这些函数不得 import 任何小程序 / Node / 浏览器 API。
 *    原因：小程序里调试音频算法极其痛苦（无断点、难复现、日志要开 vConsole），
 *    做成纯函数就能在 Node 里用 vitest 快速迭代。
 *
 *    Worker 只做一层薄适配：收帧 → 调这里的函数 → 发结果。
 */
export * from './frame-stats'
export * from './pitch'
export * from './vad'
export * from './dtw'
export * from './wav'
