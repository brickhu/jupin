import { env } from '../env'
import { MockEngine } from './mock'
import { XfyunEngine } from './xfyun'
import type { ScoreEngine } from './types'

export type { ScoreEngine, ScoreOptions, ScoreResult, WordScore, SentenceScore } from './types'

/**
 * 引擎工厂 —— 全系统唯一的引擎选择点。
 *
 * 按 AGENT.md 原则 1，本文件之外不应出现任何引擎专有代码。
 */
let cached: ScoreEngine | undefined

export function getEngine(): ScoreEngine {
  if (cached) return cached

  if (env.ENGINE === 'xfyun') {
    cached = new XfyunEngine({
      appId: env.XFYUN_APP_ID as string,
      apiKey: env.XFYUN_API_KEY as string,
      apiSecret: env.XFYUN_API_SECRET as string,
    })
  } else {
    cached = new MockEngine()
  }

  console.log(`[engine] 使用 ${cached.name} 引擎`)
  return cached
}
