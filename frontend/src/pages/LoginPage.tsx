import { createSignal, Show } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { useAuth } from '../stores/auth'
import { api } from '../services/api'

export function LoginPage() {
  const { login, register } = useAuth()
  const navigate = useNavigate()

  const [isRegister, setIsRegister] = createSignal(false)
  const [email, setEmail] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [code, setCode] = createSignal('')
  const [error, setError] = createSignal('')
  const [loading, setLoading] = createSignal(false)
  const [sendingCode, setSendingCode] = createSignal(false)
  const [codeSent, setCodeSent] = createSignal(false)
  const [countdown, setCountdown] = createSignal(0)

  const validate = (): string | null => {
    if (!email().trim()) return '请输入邮箱'
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email())) return '邮箱格式不正确'
    if (password().length < 6) return '密码至少 6 位'
    if (isRegister() && code().length !== 6) return '请输入 6 位验证码'
    return null
  }

  const startCountdown = () => {
    setCountdown(60)
    const timer = setInterval(() => {
      setCountdown((c) => {
        if (c <= 1) {
          clearInterval(timer)
          return 0
        }
        return c - 1
      })
    }, 1000)
  }

  const handleSendCode = async () => {
    if (!email().trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email())) {
      setError('请先输入正确的邮箱')
      return
    }

    setSendingCode(true)
    setError('')
    try {
      await api.sendCode(email())
      setCodeSent(true)
      startCountdown()
    } catch (err: any) {
      setError(err.message || '发送失败，请重试')
    } finally {
      setSendingCode(false)
    }
  }

  const handleSubmit = async (e: Event) => {
    e.preventDefault()
    setError('')

    const validationError = validate()
    if (validationError) {
      setError(validationError)
      return
    }

    setLoading(true)
    try {
      if (isRegister()) {
        await register(email(), password(), code())
      } else {
        await login(email(), password())
      }
      navigate('/')
    } catch (err: any) {
      setError(err.message || '操作失败，请重试')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div class="min-h-screen flex flex-col justify-center px-6 bg-gradient-to-b from-indigo-50 to-white">
      {/* Logo 区域 */}
      <div class="text-center mb-10">
        <h1 class="text-4xl font-bold text-indigo-600 mb-2">句说</h1>
        <p class="text-gray-500 text-sm">英文短句开口说，AI 辅助练口语</p>
      </div>

      {/* 表单 */}
      <form onSubmit={handleSubmit} class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">邮箱</label>
          <input
            type="email"
            value={email()}
            onInput={(e) => setEmail(e.currentTarget.value)}
            placeholder="请输入邮箱"
            autocomplete="email"
            class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all text-base"
          />
        </div>

        {/* 验证码（注册时显示） */}
        <Show when={isRegister()}>
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-1">验证码</label>
            <div class="flex gap-2">
              <input
                type="text"
                value={code()}
                onInput={(e) => setCode(e.currentTarget.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="6 位验证码"
                autocomplete="one-time-code"
                class="flex-1 px-4 py-3 rounded-xl border border-gray-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all text-base"
              />
              <button
                type="button"
                onClick={handleSendCode}
                disabled={sendingCode() || countdown() > 0}
                class="px-4 py-3 rounded-xl bg-indigo-50 text-indigo-600 font-medium text-sm whitespace-nowrap transition-all hover:bg-indigo-100 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {sendingCode() ? '发送中...' : countdown() > 0 ? `${countdown()}s` : codeSent() ? '重新发送' : '发送验证码'}
              </button>
            </div>
          </div>
        </Show>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-1">密码</label>
          <input
            type="password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
            placeholder="请输入密码（至少 6 位）"
            autocomplete={isRegister() ? 'new-password' : 'current-password'}
            class="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-100 outline-none transition-all text-base"
          />
        </div>

        {/* 错误提示 */}
        <Show when={error()}>
          <div class="bg-red-50 text-red-600 text-sm px-4 py-2 rounded-lg">{error()}</div>
        </Show>

        {/* 提交按钮 */}
        <button
          type="submit"
          disabled={loading()}
          class="w-full py-3 rounded-xl bg-indigo-600 text-white font-medium text-base transition-all hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {loading() ? '处理中...' : isRegister() ? '注册' : '登录'}
        </button>
      </form>

      {/* 切换登录/注册 */}
      <div class="text-center mt-6">
        <button
          onClick={() => {
            setIsRegister(!isRegister())
            setError('')
            setCode('')
            setCodeSent(false)
            setCountdown(0)
          }}
          class="text-indigo-600 text-sm hover:underline"
        >
          {isRegister() ? '已有账号？去登录' : '没有账号？去注册'}
        </button>
      </div>

      {/* 底部说明 */}
      <p class="text-center text-xs text-gray-400 mt-10">
        注册即表示同意服务条款和隐私政策
      </p>
    </div>
  )
}