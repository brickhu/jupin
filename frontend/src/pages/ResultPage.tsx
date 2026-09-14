import { createSignal, createResource, Show, For } from 'solid-js'
import { useParams, useNavigate } from '@solidjs/router'
import { useAuth } from '../stores/auth'
import { api } from '../services/api'
import type { ReadingResult } from '../types'

export function ResultPage() {
  const params = useParams()
  const navigate = useNavigate()
  const { state } = useAuth()

  const [result] = createResource(() => api.getReadingDetail(Number(params.id)))
  const [showPaywall, setShowPaywall] = createSignal(false)
  const [shareUrl, setShareUrl] = createSignal('')

  const handleShare = async () => {
    try {
      const result = await fetch(`${import.meta.env.VITE_API_URL || ''}/api/share`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('token')}`,
        },
        body: JSON.stringify({ readingId: Number(params.id) }),
      }).then(r => r.json())

      setShareUrl(result.shareUrl)

      // 尝试使用 Web Share API
      if (navigator.share) {
        await navigator.share({
          title: '我的句说朗读评分',
          text: `我在句说朗读获得了 ${result.qualityScore} 分！`,
          url: result.shareUrl,
        })
      } else {
        // 复制链接
        await navigator.clipboard.writeText(result.shareUrl)
        alert('分享链接已复制到剪贴板')
      }
    } catch (err) {
      console.error('分享失败:', err)
    }
  }

  const hasDetail = () => {
    const r = result()
    return r && !r.message && r.errorDetail
  }

  const cefrLevel = (score: number): string => {
    if (score < 40) return 'A1'
    if (score < 55) return 'A2'
    if (score < 70) return 'B1'
    if (score < 85) return 'B2'
    if (score < 95) return 'C1'
    return 'C2'
  }

  const scoreColor = (score: number): string => {
    if (score >= 90) return 'text-green-600'
    if (score >= 70) return 'text-indigo-600'
    if (score >= 60) return 'text-yellow-600'
    if (score >= 30) return 'text-orange-600'
    return 'text-red-600'
  }

  const errorTypeLabel = (type: string): string => {
    switch (type) {
      case 'Mispronunciation':
        return '发音不准'
      case 'Omission':
        return '漏读'
      case 'Insertion':
        return '多读'
      case 'None':
        return '正确'
      default:
        return type
    }
  }

  return (
    <div class="min-h-screen pb-8">
      <Show
        when={!result.loading}
        fallback={
          <div class="flex items-center justify-center h-screen">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
          </div>
        }
      >
        <Show when={result()} fallback={<div class="p-4 text-center text-gray-500">结果不存在</div>}>
          <div class="p-4">
            {/* 分数环形图 */}
            <div class="text-center py-8">
              <div class="relative inline-flex items-center justify-center">
                <svg class="w-32 h-32 transform -rotate-90">
                  <circle
                    cx="64"
                    cy="64"
                    r="56"
                    fill="none"
                    stroke="#e5e7eb"
                    stroke-width="8"
                  />
                  <circle
                    cx="64"
                    cy="64"
                    r="56"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="8"
                    stroke-linecap="round"
                    class={scoreColor(Number(result()?.qualityScore))}
                    stroke-dasharray={`${(Number(result()?.qualityScore) / 100) * 352} 352`}
                  />
                </svg>
                <div class="absolute text-center">
                  <div class={`text-3xl font-bold ${scoreColor(Number(result()?.qualityScore))}`}>
                    {result()?.qualityScore}
                  </div>
                  <div class="text-xs text-gray-400">质量分</div>
                </div>
              </div>

              <Show when={result()?.isConquered}>
                <div class="mt-3 inline-flex items-center gap-1 bg-yellow-50 text-yellow-700 text-xs px-3 py-1 rounded-full">
                  ⭐ {result()?.isPerfect ? '完美攻克' : '已攻克'}
                </div>
              </Show>
            </div>

            {/* 核心数据卡片 */}
            <div class="grid grid-cols-2 gap-3 mb-6">
              <div class="bg-indigo-50 rounded-xl p-4 text-center">
                <div class="text-2xl font-bold text-indigo-600">
                  +{result()?.experienceGained || 0}
                </div>
                <div class="text-xs text-indigo-400 mt-1">经验分</div>
              </div>
              <div class="bg-green-50 rounded-xl p-4 text-center">
                <div class="text-2xl font-bold text-green-600">
                  {result()?.proficiencyAfter || '-'}
                </div>
                <div class="text-xs text-green-400 mt-1">
                  能力分 · {cefrLevel(Number(result()?.proficiencyAfter || 0))}
                </div>
              </div>
            </div>

            {/* 进度信息 */}
            <div class="bg-white rounded-xl border border-gray-100 p-4 mb-6">
              <div class="flex justify-between text-sm mb-1">
                <span class="text-gray-500">累计经验</span>
                <span class="text-gray-700 font-medium">{result()?.totalExperience || 0}</span>
              </div>
              <div class="flex justify-between text-sm mb-1">
                <span class="text-gray-500">称号</span>
                <span class="text-indigo-600 font-medium">{result()?.honorTitle || '朗读者'}</span>
              </div>
              <div class="flex justify-between text-sm">
                <span class="text-gray-500">连续打卡</span>
                <span class="text-gray-700 font-medium">{result()?.streakDays || 0} 天</span>
              </div>
            </div>

            {/* 付费墙 / 纠音详情 */}
            <Show
              when={hasDetail()}
              fallback={
                <div class="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-2xl p-6 text-center mb-6">
                  <p class="text-indigo-700 font-medium mb-2">解锁发音诊断</p>
                  <p class="text-sm text-indigo-400 mb-4">
                    查看逐句纠音、音素级错误标注和 AI 发音建议
                  </p>
                  <div class="flex gap-3">
                    <button
                      onClick={() => navigate('/subscribe')}
                      class="flex-1 py-2.5 rounded-xl bg-white text-indigo-600 font-medium text-sm border border-indigo-200 hover:bg-indigo-50 transition-colors"
                    >
                      Pro 月付 ¥29
                    </button>
                    <button
                      onClick={() => {
                        setShowPaywall(true)
                      }}
                      class="flex-1 py-2.5 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 transition-colors"
                    >
                      ¥0.99 解锁本篇
                    </button>
                  </div>
                </div>
              }
            >
              {/* 错误单词列表 */}
              <div class="mb-6">
                <h3 class="text-sm font-medium text-gray-700 mb-3">发音诊断</h3>
                <For each={result()?.errorDetail || []}>
                  {(error) => (
                    <div class="bg-white rounded-xl border border-gray-100 p-3 mb-2">
                      <div class="flex items-center justify-between mb-2">
                        <span class="text-lg font-semibold text-gray-800">{error.word}</span>
                        <span
                          class={`text-xs px-2 py-0.5 rounded-full ${
                            error.errorType === 'None'
                              ? 'bg-green-100 text-green-600'
                              : 'bg-red-100 text-red-600'
                          }`}
                        >
                          {errorTypeLabel(error.errorType)} ({error.accuracyScore}%)
                        </span>
                      </div>

                      {/* 音素级错误 */}
                      <Show when={error.phonemes?.length}>
                        <div class="flex flex-wrap gap-1 mb-2">
                          <For each={error.phonemes || []}>
                            {(phoneme) => (
                              <span
                                class={`text-xs px-1.5 py-0.5 rounded ${
                                  phoneme.accuracyScore >= 80
                                    ? 'bg-green-50 text-green-600'
                                    : 'bg-red-50 text-red-600'
                                }`}
                              >
                                /{phoneme.phoneme}/ ({phoneme.accuracyScore}%)
                              </span>
                            )}
                          </For>
                        </div>
                      </Show>

                      {/* AI 建议 */}
                      <Show when={result()?.aiSuggestions?.[`${error.word}_${error.errorType}`]}>
                        <p class="text-xs text-gray-500 bg-gray-50 rounded-lg p-2 mt-1">
                          {result()?.aiSuggestions?.[`${error.word}_${error.errorType}`]}
                        </p>
                      </Show>
                    </div>
                  )}
                </For>

                <Show when={!result()?.errorDetail?.length}>
                  <p class="text-sm text-green-600 text-center py-4">
                    太棒了！所有单词发音都很准确
                  </p>
                </Show>
              </div>
            </Show>

            {/* 操作按钮 */}
            <div class="flex gap-3">
              <button
                onClick={() => navigate('/')}
                class="flex-1 py-3 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 active:scale-[0.98] transition-all"
              >
                再读一篇
              </button>
              <button
                onClick={() => {
                  // 重新朗读同一篇
                  navigate('/')
                }}
                class="flex-1 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium hover:bg-gray-50 transition-colors"
              >
                重读本篇
              </button>
              <button
                onClick={handleShare}
                class="py-3 px-4 rounded-xl border border-indigo-200 text-indigo-600 font-medium hover:bg-indigo-50 transition-colors"
              >
                分享
              </button>
            </div>
          </div>
        </Show>
      </Show>
    </div>
  )
}