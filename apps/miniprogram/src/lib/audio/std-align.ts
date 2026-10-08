/**
 * ⭐ **录音过程中的逐词对齐**（粗糙版）—— 把"读到第几个词"这件事封在这里。
 *
 * ## 它做什么
 *   用 `align.ts` 的 MFCC + subsequence DTW，把**用户正在录的音频**和**标准音**对齐，
 *   得到"当前读到第几个词" ✓
 *
 * ## ⚠️ 与"定稿预检"的分工（⭐ 别混）
 *   · 本模块 = **录音中**的位置跟踪（⭐ 中性下划线 ✓ 不下判断 ✓）
 *   · 定稿预检（`missed` / `misread`）= **录音结束后**算一次（⭐ 现有逻辑不动 ✓）
 *
 * ## ⚠️ 粗糙在哪（⭐ 用户点名"先做粗糙版" ✓）
 *   实测平均滞后 ~0.5 个词（≈190ms）✓ 但单条可能偏 ±2~3 个词（≈±1 秒）✗
 *   ⇒ ⭐ 先让用户看到"读的时候有反馈"✓ 精度后面再提 ✓
 *
 * ## ⚠️ 两个坑记在这里
 *   ① 标准音是 **24kHz** mp3，而 MFCC 要 **16kHz** ⇒ ⭐ 必须重采样 ✓
 *   ② `alignFreeEnd` **自己不保证单调** ✗ ⇒ ⭐ 每次把上次的位置当 `minEndFrame` 传 ✓
 */
import { alignFreeEnd, features } from './align'

/** 对齐算法的采样率（⭐ 与 align.ts 的 SR 一致 ✓） */
const TARGET_SR = 16000
/** 每多久跑一次对齐（⚠️ 太密费电 ✗ 太疏反馈顿 ✓） */
const ALIGN_EVERY_MS = 250
/** 用户采样最多留多久（⭐ 一句也就 10 秒上下 ✓ 留足余量 ✓） */
const MAX_USER_MS = 20_000

export interface StdAlignState {
  /** 标准音的 MFCC 特征（⭐ 每句只算一次 ✓） */
  stdCep: Float64Array
  stdT: number
  /** 标准音总时长（ms ✓） */
  stdMs: number
  /** 用户已录的采样（⭐ 累积 ✓ 滚动截断 ✓） */
  user: number[]
  userMs: number
  /** 上次对齐到的标准音帧（⭐ 单调下界 ✓） */
  lastEnd: number
  /** 上次跑对齐的时刻（ms ✓） */
  lastAlignAt: number
  /** 已经算出来的"读到第几个词"（⭐ -1 = 还没读到 ✓） */
  readCount: number
}

/**
 * ⭐ 把任意采样率的 Float32 重采样成 16kHz（⭐ 线性插值 ✓ 对 MFCC 够用 ✓）
 */
export function resampleTo16k(input: Float32Array, fromSr: number): Float32Array {
  if (fromSr === TARGET_SR) return input
  const n = Math.max(1, Math.round((input.length * TARGET_SR) / fromSr))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const pos = (i * fromSr) / TARGET_SR
    const i0 = Math.floor(pos)
    const i1 = Math.min(input.length - 1, i0 + 1)
    const w = pos - i0
    out[i] = (input[i0] ?? 0) * (1 - w) + (input[i1] ?? 0) * w
  }
  return out
}

/**
 * ⭐ 用**标准音的采样**建一个对齐状态（⭐ 特征在这里算一次 ✓ 后面每 tick 只算用户的 ✓）
 * ⚠️ 调用方要保证 samples 是 16kHz（⭐ 用 resampleTo16k 转好再进来 ✓）
 */
export function createStdAlign(std16k: Float32Array): StdAlignState {
  const f = features(std16k)
  return {
    stdCep: f.cep,
    stdT: f.T,
    stdMs: Math.round((std16k.length / TARGET_SR) * 1000),
    user: [],
    userMs: 0,
    lastEnd: 0,
    lastAlignAt: 0,
    readCount: -1,
  }
}

/**
 * ⭐ 喂一段**用户音频**（16kHz），到点就跑一次对齐。
 *
 * @param wordCount 这一句有几个词（⭐ 用来把帧位置换算成词下标 ✓）
 * @param nowMs     当前时刻（⭐ 由调用方给，便于测试 ✓）
 * @returns ⭐ 新的"读到第几个词"；没变化时返回 null（⚠️ 避免无谓的 setData ✗）
 */
export function feedUserAudio(
  st: StdAlignState,
  samples16k: Float32Array,
  wordCount: number,
  nowMs: number,
): number | null {
  for (let i = 0; i < samples16k.length; i++) st.user.push(samples16k[i] ?? 0)
  st.userMs += Math.round((samples16k.length / TARGET_SR) * 1000)
  // ⚠️ 滚动截断：只留最近 MAX_USER_MS（⭐ 长录音不至于把内存拖垮 ✓）
  const keep = Math.round((MAX_USER_MS / 1000) * TARGET_SR)
  if (st.user.length > keep) st.user = st.user.slice(st.user.length - keep)

  if (nowMs - st.lastAlignAt < ALIGN_EVERY_MS) return null
  st.lastAlignAt = nowMs
  if (st.user.length < TARGET_SR / 4) return null // ⚠️ 太短（<250ms）没得对 ✓

  const uf = features(Float32Array.from(st.user))
  if (uf.T < 4) return null
  // ⭐ 单调下界：上次的位置压住这次的终点（⭐ 算法自己不保证 ✓）
  const { endFrame } = alignFreeEnd(st.stdCep, st.stdT, uf.cep, uf.T, 0.35, st.lastEnd)
  st.lastEnd = endFrame
  const ratio = endFrame / Math.max(1, st.stdT - 1)
  const next = Math.min(wordCount - 1, Math.max(0, Math.round(ratio * (wordCount - 1))))
  if (next === st.readCount) return null
  st.readCount = next
  return next
}
