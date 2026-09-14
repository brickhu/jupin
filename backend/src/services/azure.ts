// Azure Speech Pronunciation Assessment API 调用
// 文档: https://learn.microsoft.com/en-us/azure/ai-services/speech-service/pronunciation-assessment-tool

interface AzureAssessmentResult {
  accuracyScore: number
  fluencyScore: number
  completenessScore: number
  prosodyScore: number
  words: Array<{
    word: string
    accuracyScore: number
    errorType: string
    phonemes: Array<{
      phoneme: string
      accuracyScore: number
      offset: number
    }>
  }>
}

export async function assessPronunciation(
  audioBuffer: ArrayBuffer,
  referenceText: string,
): Promise<AzureAssessmentResult> {
  const key = process.env.AZURE_SPEECH_KEY
  const region = process.env.AZURE_SPEECH_REGION || 'eastasia'

  if (!key) {
    throw new Error('AZURE_SPEECH_KEY 未配置')
  }

  // 获取 Azure token
  const tokenRes = await fetch(
    `https://${region}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  )
  if (!tokenRes.ok) {
    throw new Error(`Azure 认证失败: ${tokenRes.status}`)
  }
  const token = await tokenRes.text()

  // 构建 pronunciation assessment 请求
  // 使用 WebM/Opus 格式（Chrome）或 MP4/AAC（Safari）
  const url = `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US`

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'audio/webm;codecs=opus',
      'Pronunciation-Assessment': JSON.stringify({
        ReferenceText: referenceText,
        GradingSystem: 'HundredMark',
        Granularity: 'Phoneme',
        Dimension: 'Comprehensive',
        EnableMiscue: true,
      }),
    },
    body: audioBuffer,
  })

  if (!response.ok) {
    throw new Error(`Azure 评分请求失败: ${response.status}`)
  }

  const result = await response.json()

  // 解析结果
  if (result.RecognitionStatus !== 'Success' || !result.NBest || result.NBest.length === 0) {
    throw new Error('语音识别失败，请重新录制')
  }

  const nbest = result.NBest[0]
  const pronunciationAssessment = nbest.PronunciationAssessment

  const accuracyScore = pronunciationAssessment.AccuracyScore
  const fluencyScore = pronunciationAssessment.FluencyScore
  const completenessScore = pronunciationAssessment.CompletenessScore
  const prosodyScore = pronunciationAssessment.ProsodyScore

  // 提取单词级错误
  const words = (nbest.Words || []).map((w: any) => ({
    word: w.Word,
    accuracyScore: w.PronunciationAssessment?.AccuracyScore || 0,
    errorType: w.PronunciationAssessment?.ErrorType || 'None',
    phonemes: (w.Phonemes || []).map((p: any) => ({
      phoneme: p.Phoneme,
      accuracyScore: p.PronunciationAssessment?.AccuracyScore || 0,
      offset: p.Offset,
    })),
  }))

  return {
    accuracyScore,
    fluencyScore,
    completenessScore,
    prosodyScore,
    words,
  }
}