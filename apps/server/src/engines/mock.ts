import { plainWordsOf } from '@jushuo/shared'
import type { ScoreEngine, ScoreOptions, ScoreResult } from './types'

/**
 * Mock 引擎 —— 本地开发用。
 *
 * 价值：
 *  1. 调 UI / 交互时不用烧额度
 *  2. 自动化测试可复现（固定 seed 时结果确定）
 *  3. Docker 环境默认用它，避免误打真实 API
 *
 * ⚠️ 生成的是**确定性伪随机分**（由音频长度 + 参考文本 hash 决定），
 *    这样同一个输入反复提交得到相同分数，便于调试排名逻辑。
 */
export class MockEngine implements ScoreEngine {
  readonly name = 'mock'

  constructor(private readonly opts: { baseScore?: number; jitter?: number } = {}) {}

  async score({ refText, audio }: ScoreOptions): Promise<ScoreResult> {
    const base = this.opts.baseScore ?? 78
    const jitter = this.opts.jitter ?? 18

    // 确定性哈希：同一 (文本, 音频长度) 永远得到同一分数
    const seed = hash(`${refText}:${audio.length}`)
    const total = clamp(base + ((seed % 1000) / 1000 - 0.5) * 2 * jitter, 0, 100)

    // ⚠️ 切词走唯一实现（plainWordsOf）—— 下标要和客户端点词的下标一致
    const words = plainWordsOf(refText).map((word, i) => {
        const wSeed = hash(`${word}:${i}:${audio.length}`)
        const score = clamp(total + ((wSeed % 1000) / 1000 - 0.5) * 30, 0, 100)
        const startMs = i * 380
        return {
          word,
          score: Math.round(score * 100) / 100,
          dp: (score < 45 ? 'mispronunciation' : 'normal') as 'normal' | 'mispronunciation',
          startMs,
          endMs: startMs + 340,
        }
      })

    // ⭐ 维度也要给：否则本地开发时界面上永远是空的，
    //    「界面没显示」和「引擎没返回」就分不清了。
    //    ⚠️ mock 不模拟漏读，所以完整度恒为 100 —— 这也是刻意暴露 mock 的边界。
    const dim = (tag: string): number => {
      const dSeed = hash(`${tag}:${refText}:${audio.length}`)
      return Math.round(clamp(total + ((dSeed % 1000) / 1000 - 0.5) * 12, 0, 100) * 10) / 10
    }

    return {
      total: Math.round(total * 100) / 100,
      words,
      dimensions: {
        accuracy: dim('accuracy'),
        fluency: dim('fluency'),
        standard: dim('standard'),
        integrity: 100,
      },
    }
  }
}

function hash(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}
