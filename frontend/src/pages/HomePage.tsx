import { createSignal, createResource, Show, For } from 'solid-js'
import { useAuth } from '../stores/auth'
import { api } from '../services/api'
import { Recorder } from '../components/Recorder'
import type { Article } from '../types'

export function HomePage() {
  const { state } = useAuth()
  const [showRecorder, setShowRecorder] = createSignal(false)

  const [articles] = createResource(() => api.getTodayArticles().then(r => r.articles))
  const [currentIndex, setCurrentIndex] = createSignal(0)

  const cefrLevel = (score: number): string => {
    if (score < 40) return 'A1'
    if (score < 55) return 'A2'
    if (score < 70) return 'B1'
    if (score < 85) return 'B2'
    if (score < 95) return 'C1'
    return 'C2'
  }

  const difficultyColor = (d: number): string => {
    if (d < 1.5) return 'bg-green-100 text-green-700'
    if (d < 2.5) return 'bg-yellow-100 text-yellow-700'
    if (d < 3.5) return 'bg-orange-100 text-orange-700'
    return 'bg-red-100 text-red-700'
  }

  const startReading = (article: Article) => {
    sessionStorage.setItem('currentArticle', JSON.stringify(article))
    setShowRecorder(true)
  }

  return (
    <div class="flex flex-col min-h-screen">
      {/* 顶部用户信息 */}
      <header class="px-4 pt-4 pb-2">
        <div class="flex items-center justify-between">
          <div>
            <h1 class="text-xl font-bold text-gray-900">句说</h1>
            <p class="text-xs text-gray-400 mt-1">
              {state.user?.proficiencyScore && Number(state.user.proficiencyScore) > 0
                ? `能力分 ${state.user.proficiencyScore} · ${cefrLevel(Number(state.user.proficiencyScore))}`
                : '开始你的第一次朗读'}
            </p>
            <Show when={state.user?.streakDays && state.user.streakDays > 0}>
              <p class="text-xs text-amber-500 mt-0.5">
                🔥 连续 {state.user.streakDays} 天打卡
              </p>
            </Show>
          </div>
          <div class="text-right min-w-0">
            <div class="text-sm text-indigo-600 font-medium truncate">{state.user?.nickname || state.user?.email || '用户'}</div>
            <div class="text-xs text-gray-400">{state.user?.honorTitle || '朗读者'} · 经验 {state.user?.totalExperience || 0}</div>
          </div>
        </div>
      </header>

      {/* 文章卡片区域 */}
      <div class="flex-1 px-4 py-4">
        <Show
          when={!articles.loading}
          fallback={
            <div class="flex items-center justify-center h-64">
              <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600"></div>
            </div>
          }
        >
          <Show
            when={articles()?.length}
            fallback={
              <div class="flex flex-col items-center justify-center h-64 text-gray-400">
                <span class="text-4xl mb-4">📚</span>
                <p>暂无推荐内容</p>
                <p class="text-xs mt-1">敬请期待更多精彩文章</p>
              </div>
            }
          >
            {/* 文章滑动指示器 */}
            <div class="flex gap-1 justify-center mb-4">
              <For each={articles()}>
                {(_, i) => (
                  <button
                    class={`w-2 h-2 rounded-full transition-all ${
                      i() === currentIndex() ? 'bg-indigo-600 w-6' : 'bg-gray-300'
                    }`}
                    onClick={() => setCurrentIndex(i())}
                  />
                )}
              </For>
            </div>

            {/* 文章卡片 */}
            <div class="relative overflow-hidden">
              <div
                class="flex transition-transform duration-300 ease-out"
                style={`transform: translateX(-${currentIndex() * 100}%)`}
              >
                <For each={articles()}>
                  {(article) => (
                    <div class="w-full flex-shrink-0 px-1">
                      <div class="bg-white rounded-2xl shadow-sm border border-gray-100 p-6">
                        {/* 难度标签 */}
                        <div class="flex items-center gap-2 mb-4">
                          <span class={`text-xs px-2 py-0.5 rounded-full font-medium ${difficultyColor(Number(article.difficulty))}`}>
                            难度 {article.difficulty}
                          </span>
                          <span class="text-xs text-gray-400">{article.wordCount} 词</span>
                          <Show when={article.author}>
                            <span class="text-xs text-gray-400">— {article.author}</span>
                          </Show>
                        </div>

                        {/* 英文内容 */}
                        <p class="text-lg leading-relaxed text-gray-800 font-serif mb-4">
                          {article.content}
                        </p>

                        {/* 中文翻译 */}
                        <Show when={article.translation}>
                          <p class="text-sm text-gray-400 leading-relaxed border-l-2 border-indigo-200 pl-3">
                            {article.translation}
                          </p>
                        </Show>

                        {/* 经验分提示 */}
                        <div class="mt-4">
                          <span class="text-xs text-indigo-500">
                            经验 +{Math.round(Number(article.difficulty) * 100)}
                          </span>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </Show>
      </div>

      {/* 底部操作区 */}
      <div class="px-4 py-4 pb-8">
        <Show when={articles()?.length}>
          <button
            onClick={() => {
              const article = articles()![currentIndex()]
              startReading(article)
            }}
            class="w-full py-4 rounded-2xl bg-indigo-600 text-white font-medium text-lg transition-all hover:bg-indigo-700 active:scale-[0.98] shadow-lg shadow-indigo-200"
          >
            开始朗读
          </button>
        </Show>

        {/* 滑动操作提示 */}
        <Show when={(articles()?.length || 0) > 1}>
          <div class="flex justify-between mt-4">
            <button
              onClick={() => setCurrentIndex(Math.max(0, currentIndex() - 1))}
              disabled={currentIndex() === 0}
              class="text-sm text-gray-400 disabled:opacity-30"
            >
              上一句
            </button>
            <button
              onClick={() => setCurrentIndex(Math.min((articles()?.length || 1) - 1, currentIndex() + 1))}
              disabled={currentIndex() === (articles()?.length || 1) - 1}
              class="text-sm text-indigo-500 disabled:opacity-30"
            >
              下一句
            </button>
          </div>
        </Show>
      </div>

      {/* 录音弹窗 */}
      <Show when={showRecorder()}>
        <Recorder />
      </Show>
    </div>
  )
}