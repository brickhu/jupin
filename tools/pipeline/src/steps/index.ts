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
    stub('03', '朗读难度定级', '脚本算特征 → LLM 带锚点判断 → 输出 stars + reason'),
    stub('04', '标准音 + 词级时间戳', 'fish-audio /v1/tts/stream/with-timestamp，整篇 + 每竞技场各一份'),
    stub('05', '整篇翻译', 'LLM 翻译'),
    stub('06', '音标 / 词性 / 义项', 'ECDICT 查表（⚠️ 音标绝不能让 LLM 生成）'),
    stub('07', '词级释义', 'ECDICT 给义项 → LLM 选语境义（从「生成」降级为「选择」）'),
    stub('08', '朗读技巧', '规则检测 → LLM 润色（不得新增检测不到的点）'),
    stub('09', '对齐校验 + 切片 + 入库', '⚠️ segments[].text 必须与自建词表逐项一致，否则时间戳全错'),
  ]
}
