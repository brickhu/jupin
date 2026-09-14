import { createSignal } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { api } from '../services/api'

export function SubscribePage() {
  const navigate = useNavigate()
  const [loading, setLoading] = createSignal(false)
  const [selectedPlan, setSelectedPlan] = createSignal<'monthly' | 'yearly'>('monthly')
  const [error, setError] = createSignal('')

  const handleSubscribe = async () => {
    setLoading(true)
    setError('')
    try {
      const result = await api.subscribe(selectedPlan())
      // 在真实环境中，这里会跳转到支付宝支付页面
      // MVP 阶段显示成功提示
      alert(`订单已创建: ${result.outTradeNo}\n请使用支付宝扫码支付`)
      navigate('/profile')
    } catch (err: any) {
      setError(err.message || '支付失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="min-h-screen bg-gray-50 pb-8">
      {/* 头部 */}
      <div class="bg-gradient-to-b from-indigo-500 to-indigo-600 text-white px-4 pt-8 pb-10 text-center">
        <h1 class="text-xl font-bold mb-2">升级 Pro</h1>
        <p class="text-white/70 text-sm">解锁全部功能，让进步看得见</p>
      </div>

      {/* 方案选择 */}
      <div class="px-4 -mt-6">
        <div class="grid grid-cols-2 gap-3 mb-6">
          <button
            onClick={() => setSelectedPlan('monthly')}
            class={`rounded-2xl p-4 text-center transition-all ${
              selectedPlan() === 'monthly'
                ? 'bg-white border-2 border-indigo-500 shadow-lg shadow-indigo-100'
                : 'bg-white border border-gray-200'
            }`}
          >
            <div class="text-2xl font-bold text-indigo-600">¥29</div>
            <div class="text-xs text-gray-500 mt-1">/ 月</div>
            <div class="text-xs text-indigo-400 mt-2">月度订阅</div>
          </button>

          <button
            onClick={() => setSelectedPlan('yearly')}
            class={`rounded-2xl p-4 text-center transition-all relative ${
              selectedPlan() === 'yearly'
                ? 'bg-white border-2 border-indigo-500 shadow-lg shadow-indigo-100'
                : 'bg-white border border-gray-200'
            }`}
          >
            <div class="absolute -top-2 -right-2 bg-amber-400 text-white text-xs px-2 py-0.5 rounded-full font-medium">
              省 45%
            </div>
            <div class="text-2xl font-bold text-indigo-600">¥199</div>
            <div class="text-xs text-gray-500 mt-1">/ 年</div>
            <div class="text-xs text-amber-500 mt-2">约 ¥16.6/月</div>
          </button>
        </div>

        {/* 权益列表 */}
        <div class="bg-white rounded-2xl p-6 mb-6">
          <h3 class="font-medium text-gray-800 mb-4">Pro 权益</h3>
          <ul class="space-y-3">
            <li class="flex items-center gap-3 text-sm text-gray-600">
              <span class="text-green-500">✓</span>
              每日 500 次评分提交（免费 5 次）
            </li>
            <li class="flex items-center gap-3 text-sm text-gray-600">
              <span class="text-green-500">✓</span>
              逐句纠音 + 音素级错误标注
            </li>
            <li class="flex items-center gap-3 text-sm text-gray-600">
              <span class="text-green-500">✓</span>
              AI 发音建议（中文教练指导）
            </li>
            <li class="flex items-center gap-3 text-sm text-gray-600">
              <span class="text-green-500">✓</span>
              三条数据趋势曲线
            </li>
            <li class="flex items-center gap-3 text-sm text-gray-600">
              <span class="text-green-500">✓</span>
              所有称号解锁
            </li>
            <li class="flex items-center gap-3 text-sm text-gray-600">
              <span class="text-green-500">✓</span>
              年度发音报告（年付专属）
            </li>
          </ul>
        </div>

        {/* 错误提示 */}
        {error() && (
          <div class="bg-red-50 text-red-600 text-sm px-4 py-2 rounded-lg mb-4">{error()}</div>
        )}

        {/* 支付按钮 */}
        <button
          onClick={handleSubscribe}
          disabled={loading()}
          class="w-full py-4 rounded-2xl bg-indigo-600 text-white font-medium text-lg transition-all hover:bg-indigo-700 active:scale-[0.98] shadow-lg shadow-indigo-200 disabled:opacity-50"
        >
          {loading() ? '处理中...' : `立即开通 ¥${selectedPlan() === 'monthly' ? '29' : '199'}`}
        </button>

        <p class="text-xs text-gray-400 text-center mt-4">
          订阅将通过支付宝周期扣款，可随时取消
        </p>
      </div>
    </div>
  )
}