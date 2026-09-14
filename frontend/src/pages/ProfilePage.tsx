import { createSignal, createResource, createEffect, Show, For, onMount } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useAuth } from '../stores/auth'
import { api } from '../services/api'
import { Chart, registerables } from 'chart.js'

Chart.register(...registerables)

export function ProfilePage() {
  const { state, logout, refreshUser } = useAuth()
  const navigate = useNavigate()

  const [proficiency] = createResource(() => api.getProficiency())
  const [experience] = createResource(() => api.getExperience())
  const [history] = createResource(() => api.getReadingHistory())
  const [activeTab, setActiveTab] = createSignal('overview')
  const [editingNickname, setEditingNickname] = createSignal(false)
  const [nicknameInput, setNicknameInput] = createSignal('')
  const [savingNickname, setSavingNickname] = createSignal(false)

  let proficiencyCanvas: HTMLCanvasElement | undefined
  let scatterCanvas: HTMLCanvasElement | undefined
  let expCanvas: HTMLCanvasElement | undefined
  let chartInstances: Chart[] = []
  let nicknameInputRef: HTMLInputElement | undefined

  const isPaid = () => {
    return state.user?.subscriptionEnd && new Date(state.user.subscriptionEnd) > new Date()
  }

  const cefrLevel = (score: number): string => {
    if (score < 40) return 'A1'
    if (score < 55) return 'A2'
    if (score < 70) return 'B1'
    if (score < 85) return 'B2'
    if (score < 95) return 'C1'
    return 'C2'
  }

  // 计算显示名：有昵称用昵称，否则显示完整邮箱/手机号
  const displayName = () => {
    const u = state.user
    if (u?.nickname) return u.nickname
    return u?.email || ''
  }

  // 真人头像首字母
  const avatarLetter = () => displayName()[0]?.toUpperCase() || '?'

  const startEditNickname = () => {
    setNicknameInput(state.user?.nickname || '')
    setEditingNickname(true)
    setTimeout(() => nicknameInputRef?.focus(), 50)
  }

  const saveNickname = async () => {
    const trimmed = nicknameInput().trim()
    if (!trimmed || trimmed === state.user?.nickname) {
      setEditingNickname(false)
      return
    }
    setSavingNickname(true)
    try {
      await api.updateProfile({ nickname: trimmed })
      await refreshUser()
      setEditingNickname(false)
    } catch {
      // 静默失败
    } finally {
      setSavingNickname(false)
    }
  }

  const renderCharts = async () => {
    if (!isPaid()) return

    // 销毁旧图表
    chartInstances.forEach(c => c.destroy())
    chartInstances = []

    try {
      // 能力分曲线
      if (proficiencyCanvas) {
        const curveData = await api.getProficiencyCurve()
        const pChart = new Chart(proficiencyCanvas, {
          type: 'line',
          data: {
            labels: curveData.data.map((d: any) => d.date),
            datasets: [{
              label: '能力分',
              data: curveData.data.map((d: any) => d.score),
              borderColor: '#4F46E5',
              backgroundColor: 'rgba(79, 70, 229, 0.1)',
              fill: true,
              tension: 0.4,
              pointRadius: 2,
            }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              y: { min: 0, max: 100 },
            },
          },
        })
        chartInstances.push(pChart)
      }

      // 质量分散点图
      if (scatterCanvas) {
        const scatterData = await api.getQualityScatter()
        const sChart = new Chart(scatterCanvas, {
          type: 'bubble',
          data: {
            datasets: [{
              label: '质量分',
              data: scatterData.data.map((d: any) => ({
                x: new Date(d.createdAt).getTime(),
                y: d.qualityScore,
                r: d.difficulty * 3,
              })),
              backgroundColor: 'rgba(79, 70, 229, 0.5)',
            }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
            scales: {
              y: { min: 0, max: 100 },
            },
          },
        })
        chartInstances.push(sChart)
      }

      // 经验分累计曲线
      if (expCanvas) {
        const expData = await api.getExperienceCurve()
        const eChart = new Chart(expCanvas, {
          type: 'line',
          data: {
            labels: expData.data.map((d: any) => d.date),
            datasets: [{
              label: '累计经验',
              data: expData.data.map((d: any) => d.experience),
              borderColor: '#F59E0B',
              backgroundColor: 'rgba(245, 158, 11, 0.1)',
              fill: true,
              tension: 0.4,
              pointRadius: 2,
            }],
          },
          options: {
            responsive: true,
            plugins: { legend: { display: false } },
          },
        })
        chartInstances.push(eChart)
      }
    } catch {
      // 图表渲染失败静默处理
    }
  }

  const tabs = [
    { key: 'overview', label: '概览' },
    { key: 'history', label: '历史' },
  ]

  return (
    <div class="min-h-screen pb-8">
      {/* 用户信息头部 */}
      <div class="bg-gradient-to-b from-indigo-500 to-indigo-600 text-white px-4 pt-8 pb-6">
        <div class="flex items-center justify-between mb-4">
          <h1 class="text-lg font-bold">我的</h1>
          <button
            onClick={logout}
            class="text-white/70 text-sm hover:text-white transition-colors"
          >
            退出登录
          </button>
        </div>

        <div class="flex items-center gap-4">
          <div
            class="w-16 h-16 rounded-full bg-white/20 flex items-center justify-center text-2xl cursor-default shrink-0"
            onClick={startEditNickname}
          >
            {avatarLetter()}
          </div>
          <div class="flex-1 min-w-0">
            <Show
              when={editingNickname()}
              fallback={
                <div class="flex items-center gap-2">
                  <p class="font-medium text-lg truncate">{displayName()}</p>
                  <button
                    onClick={startEditNickname}
                    class="text-white/60 hover:text-white text-xs shrink-0"
                    title="修改昵称"
                  >
                    ✏️
                  </button>
                </div>
              }
            >
              <div class="flex items-center gap-2">
                <input
                  ref={nicknameInputRef}
                  type="text"
                  value={nicknameInput()}
                  onInput={(e) => setNicknameInput(e.currentTarget.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') saveNickname(); if (e.key === 'Escape') setEditingNickname(false) }}
                  onBlur={saveNickname}
                  maxLength={32}
                  class="bg-white/20 text-white rounded-lg px-3 py-1.5 text-base w-full outline-none placeholder:text-white/40"
                  placeholder="请输入昵称"
                  disabled={savingNickname()}
                />
                <Show when={savingNickname()}>
                  <span class="text-white/60 text-xs animate-spin">⏳</span>
                </Show>
              </div>
            </Show>
            <p class="text-white/70 text-sm">
              {state.user?.honorTitle || '朗读者'} · {cefrLevel(Number(state.user?.proficiencyScore || 0))}
            </p>
          </div>
        </div>

        {/* 数据概览 */}
        <div class="grid grid-cols-3 gap-3 mt-6">
          <div class="bg-white/10 rounded-xl p-3 text-center">
            <div class="text-xl font-bold">{state.user?.proficiencyScore || '-'}</div>
            <div class="text-xs text-white/70">能力分</div>
          </div>
          <div class="bg-white/10 rounded-xl p-3 text-center">
            <div class="text-xl font-bold">{state.user?.totalExperience || 0}</div>
            <div class="text-xs text-white/70">经验分</div>
          </div>
          <div class="bg-white/10 rounded-xl p-3 text-center">
            <div class="text-xl font-bold">{proficiency()?.totalConquered || 0}</div>
            <div class="text-xs text-white/70">已攻克</div>
          </div>
        </div>
      </div>

      {/* Tab 切换 */}
      <div class="flex border-b border-gray-200 bg-white">
        <For each={tabs}>
          {(tab) => (
            <button
              onClick={() => setActiveTab(tab.key)}
              class={`flex-1 py-3 text-sm font-medium text-center transition-colors ${
                activeTab() === tab.key
                  ? 'text-indigo-600 border-b-2 border-indigo-600'
                  : 'text-gray-500'
              }`}
            >
              {tab.label}
            </button>
          )}
        </For>
      </div>

      {/* 概览 Tab */}
      <Show when={activeTab() === 'overview'}>
        <div class="p-4">
          <Show
            when={isPaid()}
            fallback={
              <div class="bg-gradient-to-r from-indigo-50 to-purple-50 rounded-2xl p-6 text-center mb-4">
                <p class="text-indigo-700 font-medium mb-2">解锁完整数据面板</p>
                <p class="text-sm text-indigo-400 mb-4">
                  查看能力分曲线、质量趋势图和经验累计曲线
                </p>
                <button
                  onClick={() => navigate('/subscribe')}
                  class="px-6 py-2.5 rounded-xl bg-indigo-600 text-white font-medium text-sm hover:bg-indigo-700 transition-colors"
                >
                  开通 Pro ¥29/月
                </button>
              </div>
            }
          >
            <div class="space-y-6">
              {/* 能力分曲线 */}
              <div class="bg-white rounded-xl border border-gray-100 p-4">
                <h3 class="text-sm font-medium text-gray-700 mb-3">能力分趋势（近 90 天）</h3>
                <canvas ref={proficiencyCanvas} height="200"></canvas>
              </div>

              {/* 质量分散点图 */}
              <div class="bg-white rounded-xl border border-gray-100 p-4">
                <h3 class="text-sm font-medium text-gray-700 mb-3">质量分散点（近 30 次）</h3>
                <canvas ref={scatterCanvas} height="200"></canvas>
              </div>

              {/* 经验分累计曲线 */}
              <div class="bg-white rounded-xl border border-gray-100 p-4">
                <h3 class="text-sm font-medium text-gray-700 mb-3">经验分累计</h3>
                <canvas ref={expCanvas} height="200"></canvas>
              </div>
            </div>
          </Show>

          {/* 攻克徽章 */}
          <div class="bg-white rounded-xl border border-gray-100 p-4 mt-4">
            <h3 class="text-sm font-medium text-gray-700 mb-3">攻克徽章</h3>
            <div class="flex items-center gap-4">
              <div class="flex-1 bg-yellow-50 rounded-lg p-3 text-center">
                <div class="text-2xl">⭐</div>
                <div class="text-sm font-medium text-yellow-700 mt-1">
                  {proficiency()?.totalConquered || 0}
                </div>
                <div class="text-xs text-yellow-500">已攻克</div>
              </div>
              <div class="flex-1 bg-amber-50 rounded-lg p-3 text-center">
                <div class="text-2xl">👑</div>
                <div class="text-sm font-medium text-amber-700 mt-1">
                  {proficiency()?.totalPerfect || 0}
                </div>
                <div class="text-xs text-amber-500">完美攻克</div>
              </div>
              <div class="flex-1 bg-indigo-50 rounded-lg p-3 text-center">
                <div class="text-2xl">🔥</div>
                <div class="text-sm font-medium text-indigo-700 mt-1">
                  {experience()?.streakDays || 0}
                </div>
                <div class="text-xs text-indigo-400">连续打卡</div>
              </div>
            </div>
          </div>
        </div>
      </Show>

      {/* 历史 Tab */}
      <Show when={activeTab() === 'history'}>
        <div class="p-4">
          <Show
            when={!history.loading}
            fallback={
              <div class="flex justify-center py-8">
                <div class="animate-spin rounded-full h-6 w-6 border-b-2 border-indigo-600"></div>
              </div>
            }
          >
            <Show
              when={history()?.readings?.length}
              fallback={
                <div class="text-center py-8 text-gray-400">
                  <span class="text-3xl block mb-2">📝</span>
                  <p>暂无朗读记录</p>
                </div>
              }
            >
              <For each={history()?.readings || []}>
                {(reading: any) => (
                  <div class="bg-white rounded-xl border border-gray-100 p-4 mb-3">
                    <div class="flex items-center justify-between mb-2">
                      <span class="text-sm text-gray-500">
                        {new Date(reading.createdAt).toLocaleDateString('zh-CN')}
                      </span>
                      <span class="text-sm font-bold text-indigo-600">
                        {reading.qualityScore} 分
                      </span>
                    </div>
                    <p class="text-sm text-gray-700 line-clamp-2">{reading.articleContent}</p>
                    <div class="flex items-center gap-3 mt-2 text-xs text-gray-400">
                      <span>经验 +{reading.experienceGained}</span>
                      <Show when={reading.articleDifficulty}>
                        <span>难度 {reading.articleDifficulty}</span>
                      </Show>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </Show>
        </div>
      </Show>

      {/* 图表渲染 */}
      <Show when={activeTab() === 'overview' && isPaid()}>
        {(() => { renderCharts(); return null })()}
      </Show>
    </div>
  )
}