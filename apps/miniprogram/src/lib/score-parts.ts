import { WORD_GREEN_LINE, WORD_RED_LINE, formatScore } from '@jushuo/shared'
import type { ScoreParts } from '@jushuo/shared'

/**
 * ⭐⭐ **五个分项的展示口径** —— 出分面板（`components/score-panel`）与「我的挑战」列表
 *    **共用这一份**。
 *
 * ⚠️⚠️ 为什么必须抽出来：它是「我们自己那套打分」的**唯一**展示口径 ——
 *    总分已经不按引擎那四维等权算了，摆在一起用户对不上（"我准确度 91，为什么总分 85"），
 *    所以界面上给的就是**总分的五个组成部分**（`SubmitResponse.parts`）。
 *    两份各写一遍必然漂：一处改了阈值、另一处没改，用户会看到同一个分数两种颜色。
 */

/** 五个分项的键与中文名 —— 顺序就是展示顺序 */
export type PartKey = 'prosody' | 'weakness' | 'accuracy' | 'fluency' | 'completeness'

export const PART_META: { key: PartKey; label: string }[] = [
  { key: 'prosody', label: '语调' },
  { key: 'weakness', label: '咬字' },
  { key: 'accuracy', label: '发音' },
  { key: 'fluency', label: '流利' },
  { key: 'completeness', label: '完整' },
]

export interface DimensionView {
  key: string
  label: string
  /** 展示用的分数（一位小数） */
  value: string
  /** 进度条宽度（0–100） */
  pct: number
  /** 数字的颜色类 */
  textCls: string
  /** 进度条的颜色类 */
  barCls: string
}

/**
 * 分项明细 → 展示视图。
 * ⚠️ 拿不到时必须返回空数组让整块不渲染 —— **绝不能补 0**：
 *    界面上出现「完整 0」会被理解成「我一个词都没读」（老成绩没有这个字段）。
 */
export function renderParts(p?: ScoreParts | null): DimensionView[] {
  if (!p) return []
  return PART_META.map(({ key, label }) => {
    const v = p[key]
    const level = v < WORD_RED_LINE ? 'bad' : v < WORD_GREEN_LINE ? 'warn' : 'ok'
    return {
      key,
      label,
      value: formatScore(v),
      pct: Math.max(0, Math.min(100, v)),
      textCls: 'text-' + level,
      barCls: 'bg-' + level,
    }
  })
}

/** 给五个数字配一句「所以呢」—— 说出最拖后腿的那一项（完整度优先） */
export function partHint(p?: ScoreParts | null): string {
  if (!p) return ''
  if (p.completeness < 90) return '这次有漏读或读成了别的词 —— 先把整句读完，再谈发音'
  const items = [
    { v: p.prosody, text: '语调偏平：重音和升降调还没出来，听着像在念字' },
    { v: p.weakness, text: '咬字不匀：大部分词清楚，但有几个词明显没读准' },
    { v: p.accuracy, text: '发音有硬伤：有几个音素不对，跟着音标单独纠' },
    { v: p.fluency, text: '流利度偏低：词与词之间卡顿多，先顺下来再求准' },
  ]
  const worst = items.reduce((a, b) => (b.v < a.v ? b : a))
  return worst.v < WORD_GREEN_LINE ? worst.text : ''
}
