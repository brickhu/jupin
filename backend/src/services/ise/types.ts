export interface PhoneScore {
  phone: string
  score: number
}

export interface SyllableScore {
  syll: string
  score: number
  phones: PhoneScore[]
}

export interface WordScore {
  word: string
  score: number
  syllables: SyllableScore[]
}

export interface IseResult {
  totalScore: number       // 总分 Q（0-100）
  accuracyScore: number    // 准确度
  fluencyScore: number     // 流利度
  integrityScore: number   // 完整度
  toneScore: number        // 韵律/语调
  words: WordScore[]       // 单词级评分
  rejected: boolean        // 是否被拒（无有效语音）
}

export interface AssessOptions {
  text: string
  audioBuffer: Buffer
  category?: 'read_sentence' | 'read_word' | 'read_chapter'
}