import { createResource, Show } from 'solid-js'
import { useParams } from '@solidjs/router'

export function SharePage() {
  const params = useParams()

  const [shareData] = createResource(() =>
    fetch(`${import.meta.env.VITE_API_URL || ''}/api/share/${params.id}`).then(r => r.json())
  )

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

  return (
    <div class="min-h-screen bg-gradient-to-b from-indigo-50 to-white flex flex-col items-center justify-center px-6">
      <Show
        when={!shareData.loading}
        fallback={
          <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
        }
      >
        <Show
          when={shareData() && !shareData().error}
          fallback={
            <div class="text-center">
              <span class="text-4xl block mb-4">🔗</span>
              <p class="text-gray-500">分享不存在或已过期</p>
            </div>
          }
        >
          {/* 分享卡片 */}
          <div class="bg-white rounded-2xl shadow-xl p-8 w-full max-w-sm">
            {/* Logo */}
            <div class="text-center mb-6">
              <h1 class="text-2xl font-bold text-indigo-600">句说</h1>
              <p class="text-xs text-gray-400 mt-1">英文短句开口说，AI 辅助练口语</p>
            </div>

            {/* 分数展示 */}
            <div class="text-center mb-6">
              <div class={`text-5xl font-bold ${scoreColor(Number(shareData()?.qualityScore))}`}>
                {shareData()?.qualityScore}
              </div>
              <div class="text-sm text-gray-500 mt-1">朗读质量分</div>
            </div>

            {/* 进步数据 */}
            <div class="grid grid-cols-2 gap-3 mb-6">
              <div class="bg-indigo-50 rounded-xl p-3 text-center">
                <div class="text-lg font-bold text-indigo-600">
                  +{shareData()?.experienceGained}
                </div>
                <div class="text-xs text-indigo-400">经验分</div>
              </div>
              <div class="bg-green-50 rounded-xl p-3 text-center">
                <div class="text-lg font-bold text-green-600">
                  {shareData()?.proficiencyAfter}
                </div>
                <div class="text-xs text-green-400">
                  能力分 · {cefrLevel(Number(shareData()?.proficiencyAfter))}
                </div>
              </div>
            </div>

            {/* 朗读内容 */}
            <div class="bg-gray-50 rounded-xl p-4 mb-4">
              <p class="text-sm text-gray-700 leading-relaxed italic">
                "{shareData()?.articleContent}"
              </p>
              <Show when={shareData()?.articleAuthor}>
                <p class="text-xs text-gray-400 mt-2 text-right">
                  — {shareData()?.articleAuthor}
                </p>
              </Show>
            </div>

            {/* 用户信息 */}
            <div class="text-center">
              <p class="text-sm text-gray-500">
                {shareData()?.userHonorTitle} · 能力分 {shareData()?.userProficiencyScore}
              </p>
            </div>
          </div>

          {/* CTA */}
          <div class="mt-8 text-center">
            <p class="text-sm text-gray-400 mb-3">想提升你的英语发音吗？</p>
            <a
              href="/"
              class="inline-block px-6 py-3 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 transition-colors"
            >
              免费开始练习
            </a>
          </div>
        </Show>
      </Show>
    </div>
  )
}