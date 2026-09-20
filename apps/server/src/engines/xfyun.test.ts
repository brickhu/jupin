import { describe, it, expect } from 'vitest'
import { buildBusinessParams, parseIseXml } from './xfyun'

/**
 * ⚠️⚠️ 这份 fixture 的**结构是从真实返回里逐字抄下来的**（apps/server/scripts/dump-ise-xml.ts
 *    打出来的 XML），只把重复的 word 节点截短了。属性名、层级、命名都与实测一致 ——
 *    包括那个反直觉的点：**题型是 read_sentence，但 rec_paper 下的节点叫 read_chapter**。
 *
 * ⭐ 为什么必须用真实结构而不是手写一份"合理的"XML：
 *    这个文件里所有字段位置的结论都来自实测，上一版就是照着文档猜、
 *    结果连分制（0–5 还是 0–100）都搞错了。
 */
const REAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<xml_result>
  <read_sentence lan="en" type="study" version="7.0.0.1020">
    <rec_paper>
      <read_chapter accuracy_score="88.820000" beg_pos="0" content="The best way to predict the future is to invent it." end_pos="260" except_info="0" fluency_score="74.400000" integrity_score="91.700000" is_rejected="false" reject_type="0" score_pattern="loose" standard_score="54.600000" total_score="74.000000" word_count="11">
        <sentence accuracy_score="88.820000" beg_pos="0" content="the best way to predict" end_pos="140" fluency_score="74.400000" index="0" standard_score="54.600000" total_score="74.000000" word_count="5">
          <word beg_pos="1" content="the" dp_message="16" end_pos="7" global_index="0" index="0" property="0" total_score="0.000000">
            <syll beg_pos="1" content="dh ax" end_pos="7" syll_accent="0" syll_score="0.000000">
              <phone beg_pos="1" content="dh" dp_message="16" end_pos="4" gwpp="-2.429311"></phone>
            </syll>
          </word>
          <word beg_pos="7" content="best" dp_message="0" end_pos="36" global_index="1" index="1" property="0" total_score="92.740540">
            <syll beg_pos="7" content="b eh s t" end_pos="36" syll_accent="0" syll_score="99.911280"></syll>
          </word>
          <word beg_pos="36" content="sil" dp_message="0" end_pos="60" global_index="2" index="2" property="0" total_score="0.000000"></word>
          <word beg_pos="60" content="way" dp_message="0" end_pos="88" global_index="3" index="3" property="0" total_score="99.996700"></word>
        </sentence>
        <sentence accuracy_score="90.000000" beg_pos="140" content="the future is to invent it" end_pos="260" fluency_score="80.000000" index="1" standard_score="60.000000" total_score="78.000000" word_count="6">
          <word beg_pos="140" content="future" dp_message="0" end_pos="180" global_index="4" index="4" property="0" total_score="89.453200"></word>
          <word beg_pos="180" content="invent" dp_message="32" end_pos="210" global_index="5" index="5" property="0" total_score="0.000000"></word>
          <word beg_pos="210" content="it" dp_message="0" end_pos="259" global_index="6" index="6" property="0" total_score="84.017420"></word>
        </sentence>
      </read_chapter>
    </rec_paper>
  </read_sentence>
</xml_result>`

describe('parseIseXml —— 用真实返回结构做回归', () => {
  it('总分与词级结果', () => {
    const r = parseIseXml(REAL_XML)
    expect(r.total).toBe(74)
    expect(r.words?.map((w) => w.word)).toEqual(['the', 'best', 'way', 'future', 'invent', 'it'])
  })

  it('⭐ dp_message 数字 → 语义（16 漏读 / 32 增读）', () => {
    const r = parseIseXml(REAL_XML)
    expect(r.words?.map((w) => w.dp)).toEqual([
      'omission',
      'normal',
      'normal',
      'normal',
      'insertion',
      'normal',
    ])
  })

  it('⭐ beg_pos/end_pos 是**帧**，每帧 10ms', () => {
    const r = parseIseXml(REAL_XML)
    // best: 7 → 36 帧 = 70ms → 360ms
    expect(r.words?.[1]?.startMs).toBe(70)
    expect(r.words?.[1]?.endMs).toBe(360)
  })

  /**
   * ⭐ 静音段会被 ISE 造成一个 content="sil" 的"词"。
   *    它必须被剔除 —— 否则客户端「第 n 个词 ↔ 第 n 个评分」的按位对应会整体错位。
   */
  it('⭐ 静音段 "sil" 必须被剔除', () => {
    const r = parseIseXml(REAL_XML)
    expect(r.words?.some((w) => w.word.toLowerCase() === 'sil')).toBe(false)
  })

  /**
   * ⭐ 多分句：read_chapter（篇章题）下 paper.sentence 有多个元素。
   *    只取第一句会把后面的词**静默丢掉** —— 这条测试就是钉住这件事。
   */
  it('⭐ 多个 <sentence> 的词必须合并，不能只取第一句', () => {
    const r = parseIseXml(REAL_XML)
    expect(r.words?.length).toBe(6)
    expect(r.words?.some((w) => w.word === 'it')).toBe(true)
    expect(r.sentences?.length).toBe(2)
  })

  it('⭐ 四维得分：位置在 rec_paper 下的 <read_chapter> 上', () => {
    const r = parseIseXml(REAL_XML)
    expect(r.dimensions).toEqual({
      accuracy: 88.8,
      fluency: 74.4,
      standard: 54.6,
      integrity: 91.7,
    })
  })

  it('分句级也带 standard', () => {
    const r = parseIseXml(REAL_XML)
    expect(r.sentences?.[1]?.standard).toBe(60)
  })

  it('缺任何一个维度 → 整个 dimensions 为 undefined（宁可没有，也不显示假的 0）', () => {
    const missing = REAL_XML.replace(' integrity_score="91.700000"', '')
    expect(parseIseXml(missing).dimensions).toBeUndefined()
  })

  /**
   * ⚠️⚠️ 这条测试记录的是一个**反直觉的实测事实**，别再指望区间断言：
   *
   *    v1 项目「能力分恒为 0」的根因是 ise_unite 没传 → 返回 0–5 分制，
   *    而代码当成百分制用。当时的"修法"是加一句
   *        if (!(score >= 0 && score <= 100)) throw
   *    ——**这拦不住**：4.795611 本身就落在 0–100 内，断言根本不会触发。
   *
   *    所以真正的防线只有「参数必须传对」，也就是下面那一组测试。
   */
  it('⚠️ 0–5 分制**不会**被区间断言拦住（4.79 落在 0–100 内）', () => {
    const legacy = REAL_XML.replace('total_score="74.000000"', 'total_score="4.795611"')
    const r = parseIseXml(legacy)
    expect(r.total).toBeCloseTo(4.795611, 5) // 静默通过，没有任何报错
  })

  it('明显越界（>100）才拦得住', () => {
    const weird = REAL_XML.replace('total_score="74.000000"', 'total_score="740.000000"')
    expect(() => parseIseXml(weird)).toThrow(/分制异常/)
  })

  it('is_rejected="true" → 报「未检测到有效语音」', () => {
    const rejected = REAL_XML.replace('is_rejected="false"', 'is_rejected="true"')
    expect(() => parseIseXml(rejected)).toThrow(/未检测到有效语音/)
  })

  it('结构不对（没有 rec_paper）→ 明确报错', () => {
    expect(() => parseIseXml('<?xml version="1.0"?><xml_result></xml_result>')).toThrow(/缺少 rec_paper/)
  })
})

/**
 * ⭐ 这一组才是**分制/维度**问题的真正防线。
 *
 * 这些参数全都属于「少传一个、结果就悄悄变样、但一声不吭」的类型 ——
 * 没有任何报错、没有任何异常，只是分数含义变了。
 * 唯一能钉住它们的办法就是把参数本身断言住。
 */
describe('buildBusinessParams —— 每个参数都对应一次踩过的坑', () => {
  const params = buildBusinessParams('read_sentence', 'The best way.')

  it('⭐ ise_unite="1" —— 不传就退回 0–5 分制（v1 的根因）', () => {
    expect(params.ise_unite).toBe('1')
  })

  it('⭐ extra_ability="multi_dimension" —— 不传就没有四维得分', () => {
    expect(params.extra_ability).toBe('multi_dimension')
  })

  it('⭐ 音频格式必须是 16k 裸 PCM —— 不符会被判「乱读」且分值不可参考', () => {
    expect(params.aue).toBe('raw')
    expect(params.auf).toBe('audio/L16;rate=16000')
  })

  it('⭐ read_sentence 的 text 必须带 BOM 与 [content] 标签', () => {
    expect(params.text).toBe('\uFEFF[content]The best way.\n')
  })

  it('其他题型不加 [content] 标签（规则不同）', () => {
    expect(buildBusinessParams('read_chapter', 'A. B.').text).toBe('\uFEFFA. B.')
  })

  it('category 原样透传', () => {
    expect(params.category).toBe('read_sentence')
    expect(params.ent).toBe('en_vip')
  })
})
