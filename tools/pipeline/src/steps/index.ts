/**
 * 步骤注册表。
 *
 * ⚠️ 每一步的职责边界（详见 spec.md 第九节）：
 *   ① 选文（人工）        ② 切分竞技场（LLM 提案 → 人工确认）
 *   ③ 朗读难度定级         ④ 标准音 + 词级时间戳（fish-audio）
 *   ⑤ 整篇翻译（LLM）      ⑥ 音标/词性/义项（ECDICT 查表）
 *   ⑦ 词级释义（LLM 从义项里选）  ⑧ 朗读技巧（规则检测 → LLM 润色）
 *   ⑨ 对齐校验 + 切片 + 入库
 */

import { step04 } from './04-standard-audio'

export interface StepContext {
  force: boolean
}

export interface Step {
  id: string
  title: string
  run: (ctx: StepContext) => Promise<void>
}

function stub(id: string, title: string, note: string): Step {
  return {
    id,
    title,
    async run() {
      console.log(`  ⏳ [TODO] ${note}`)
    },
  }
}

export function listSteps(): Step[] {
  return [
    stub('01', '选文', '人工挑选短文，写入 data/drafts/{passageId}/source.json'),
    stub('02', '切分竞技场', 'LLM 提案句群切分 → 人工确认（语义完整 / 10–20 秒 / 自然停顿）'),
    // ⚠️ 难度**全由 LLM 判**：不算脚本特征、不带锚点样本（2026-09 决定，见 spec.md 第九节）。
    //    实现见 lib/article-meta.ts —— 原句直接交给模型，判据是「读起来难不难」。
    stub('03', '朗读难度定级', 'LLM 直接判四档 difficulty（0/1/2/3）+ tags + advice'),
    step04,
    stub('05', '整篇翻译', 'LLM 翻译'),
    stub('06', '音标 / 词性 / 义项', 'ECDICT 查表（⚠️ 音标绝不能让 LLM 生成）'),
    stub('07', '词级释义', 'ECDICT 给义项 → LLM 选语境义（从「生成」降级为「选择」）'),
    stub('08', '朗读技巧', '规则检测 → LLM 润色（不得新增检测不到的点）'),
    stub('09', '对齐校验 + 切片 + 入库', '⚠️ segments[].text 必须与自建词表逐项一致，否则时间戳全错'),
  ]
}
