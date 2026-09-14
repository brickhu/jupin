import { createSignal, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useRecorder } from '../hooks/useRecorder'
import { api } from '../services/api'
import type { Article } from '../types'

export function Recorder() {
  const { state, startRecording, stopRecording, reset } = useRecorder(30)
  const navigate = useNavigate()
  const [submitting, setSubmitting] = createSignal(false)
  const [submitError, setSubmitError] = createSignal('')

  const handleStart = async () => {
    await startRecording()
  }

  const handleStop = () => {
    stopRecording()
  }

  const handleSubmit = async () => {
    const blob = state().audioBlob
    const articleStr = sessionStorage.getItem('currentArticle')
    if (!blob || !articleStr) return

    const article: Article = JSON.parse(articleStr)
    setSubmitting(true)
    setSubmitError('')

    try {
      const result = await api.scoreReading(blob, article.id)
      navigate(`/result/${result.readingId}`)
    } catch (err: any) {
      setSubmitError(err.message || '评分失败，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  const handleRetry = () => {
    reset()
  }

  return (
    <div class="fixed inset-0 bg-black/60 flex items-end justify-center z-50" onClick={(e) => {
      if (e.target === e.currentTarget && state().status === 'idle') reset()
    }}>
      <div class="bg-white rounded-t-3xl w-full max-w-md p-6 pb-10 animate-slide-up">
        {/* 空闲状态：开始录音按钮 */}
        <Show when={state().status === 'idle'}>
          <div class="text-center">
            <p class="text-gray-500 text-sm mb-6">点击下方按钮开始朗读</p>
            <button
              onClick={handleStart}
              class="w-20 h-20 rounded-full bg-indigo-600 text-white flex items-center justify-center mx-auto shadow-lg shadow-indigo-200 hover:bg-indigo-700 active:scale-95 transition-all"
            >
              <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </button>
            <p class="text-xs text-gray-400 mt-3">最长录音 30 秒</p>
          </div>
        </Show>

        {/* 请求权限中 */}
        <Show when={state().status === 'requesting'}>
          <div class="text-center py-8">
            <div class="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600 mx-auto"></div>
            <p class="text-gray-500 text-sm mt-4">正在请求麦克风权限...</p>
          </div>
        </Show>

        {/* 录音中 */}
        <Show when={state().status === 'recording'}>
          <div class="text-center">
            <div class="flex items-center justify-center gap-2 mb-4">
              <span class="w-3 h-3 rounded-full bg-red-500 animate-pulse"></span>
              <span class="text-red-500 font-medium text-sm">录音中</span>
            </div>
            <p class="text-2xl font-mono font-bold text-gray-800 mb-6">
              {state().duration}s / 30s
            </p>
            <button
              onClick={handleStop}
              class="w-16 h-16 rounded-full bg-red-500 text-white flex items-center justify-center mx-auto hover:bg-red-600 active:scale-95 transition-all"
            >
              <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                <rect x="6" y="6" width="12" height="12" rx="1" />
              </svg>
            </button>
            <p class="text-xs text-gray-400 mt-3">点击停止并提交评分</p>
          </div>
        </Show>

        {/* 录音完成 */}
        <Show when={state().status === 'stopped'}>
          <div class="text-center">
            <div class="w-16 h-16 rounded-full bg-green-100 text-green-600 flex items-center justify-center mx-auto mb-4">
              <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p class="text-gray-700 font-medium mb-1">录音完成</p>
            <p class="text-sm text-gray-400 mb-6">时长 {state().duration} 秒</p>

            <Show when={submitError()}>
              <div class="bg-red-50 text-red-600 text-sm px-4 py-2 rounded-lg mb-4">{submitError()}</div>
            </Show>

            <div class="flex gap-3">
              <button
                onClick={handleRetry}
                class="flex-1 py-3 rounded-xl border border-gray-200 text-gray-600 font-medium hover:bg-gray-50 transition-colors"
              >
                重新录制
              </button>
              <button
                onClick={handleSubmit}
                disabled={submitting()}
                class="flex-1 py-3 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 active:scale-[0.98] transition-all disabled:opacity-50"
              >
                {submitting() ? '评分中...' : '提交评分'}
              </button>
            </div>
          </div>
        </Show>

        {/* 错误状态 */}
        <Show when={state().status === 'error'}>
          <div class="text-center py-4">
            <div class="w-16 h-16 rounded-full bg-red-100 text-red-500 flex items-center justify-center mx-auto mb-4">
              <svg class="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
              </svg>
            </div>
            <p class="text-gray-700 font-medium mb-1">录音失败</p>
            <p class="text-sm text-gray-400 mb-6">{state().error}</p>
            <button
              onClick={handleRetry}
              class="px-8 py-3 rounded-xl bg-indigo-600 text-white font-medium hover:bg-indigo-700 transition-colors"
            >
              重试
            </button>
          </div>
        </Show>
      </div>
    </div>
  )
}