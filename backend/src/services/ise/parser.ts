import { XMLParser } from 'fast-xml-parser'
import type { IseResult, WordScore, SyllableScore, PhoneScore } from './types'

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  trimValues: true,
  parseTagValue: true,
  isArray: (name) => ['word', 'syll', 'phone'].includes(name),
})

export function parseIseResult(xml: string): IseResult {
  const obj = parser.parse(xml)
  
  const readSentence = obj?.read_sentence || obj?.xml_result?.read_sentence
  if (!readSentence) {
    throw new Error('Invalid ISE XML result: missing read_sentence')
  }
  
  const recPaper = readSentence?.rec_paper
  if (!recPaper) {
    throw new Error('Invalid ISE XML result: missing rec_paper')
  }
  
  // 兼容两种结构：read_chapter（英文句子）或 read_sentence（中文/其他）
  const paper = recPaper?.read_chapter || recPaper?.read_sentence
  if (!paper) {
    throw new Error('Invalid ISE XML result: missing read_chapter/read_sentence in rec_paper')
  }

  const toNum = (v: any, d = 0): number => {
    const n = Number(v)
    return isNaN(n) ? d : n
  }

  // 取出 sentence（可能是对象或数组）
  const sentenceList = paper.sentence
  const firstSentence = Array.isArray(sentenceList) ? sentenceList[0] : sentenceList || {}

  const words: WordScore[] = (firstSentence.word || []).map((w: any) => ({
    word: String(w['@_content'] || w.content || ''),
    score: toNum(w['@_total_score'] || w.total_score),
    syllables: (w.syll || []).map((s: any): SyllableScore => ({
      syll: String(s['@_content'] || s.content || ''),
      score: toNum(s['@_total_score'] || s.total_score || s['@_syll_score']),
      phones: (s.phone || []).map((p: any): PhoneScore => ({
        phone: String(p['@_content'] || p.content || ''),
        score: toNum(p['@_total_score'] || p.total_score || p['@_gwpp']),
      })),
    })),
  }))

  return {
    totalScore: toNum(paper['@_total_score']),
    accuracyScore: toNum(paper['@_accuracy_score']),
    fluencyScore: toNum(paper['@_fluency_score']),
    integrityScore: toNum(paper['@_integrity_score']),
    toneScore: toNum(paper['@_tone_score']),
    words,
    rejected: paper['@_is_rejected'] === 'true',
  }
}