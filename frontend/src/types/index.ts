export interface Article {
  id: number
  content: string
  translation: string
  difficulty: number
  dLen: number
  dVocab: number
  dSyntax: number
  wordCount: number
  sourceType: string
  author?: string
  publishDate?: string
}

export interface ReadingResult {
  readingId: number
  qualityScore: number
  experienceGained: number
  proficiencyBefore: number
  proficiencyAfter: number
  cefr: string
  totalExperience: number
  honorTitle: string
  streakDays: number
  isConquered: boolean
  isPerfect: boolean
  errorDetail?: WordError[]
  aiSuggestions?: Record<string, string>
  article: {
    content: string
    translation: string
    author?: string
    difficulty: number
  }
}

export interface WordError {
  word: string
  accuracyScore: number
  errorType: string
  phonemes: PhonemeError[]
}

export interface PhonemeError {
  phoneme: string
  accuracyScore: number
  offset: number
}