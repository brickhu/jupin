const API_URL = import.meta.env.VITE_API_URL || ''

function getToken(): string | null {
  return localStorage.getItem('token')
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  }

  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }

  // 如果是 FormData，不设置 Content-Type（让浏览器自动设置）
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json'
  }

  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    headers,
  })

  if (res.status === 401) {
    localStorage.removeItem('token')
    window.location.href = '/login'
    throw new Error('未登录')
  }

  const data = await res.json()

  if (!res.ok) {
    throw new Error(data.error || data.message || '请求失败')
  }

  return data as T
}

export const api = {
  // Auth
  login: (email: string, password: string) =>
    request<{ token: string; user: any }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, code: string) =>
    request<{ token: string; user: any }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, code }),
    }),

  sendCode: (email: string) =>
    request<{ message: string }>('/api/auth/send-code', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  // User
  getMe: () => request<any>('/api/user/me'),
  updateProfile: (data: { nickname?: string }) =>
    request<any>('/api/user/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getProficiency: () => request<any>('/api/user/proficiency'),
  getExperience: () => request<any>('/api/user/experience'),

  // Articles
  getTodayArticles: () => request<{ articles: any[] }>('/api/articles/today'),
  getArticle: (id: number) => request<{ article: any }>(`/api/articles/${id}`),
  getArticles: (params?: { page?: number; minD?: number; maxD?: number }) => {
    const searchParams = new URLSearchParams()
    if (params?.page) searchParams.set('page', String(params.page))
    if (params?.minD) searchParams.set('minD', String(params.minD))
    if (params?.maxD) searchParams.set('maxD', String(params.maxD))
    return request<any>(`/api/articles/list?${searchParams}`)
  },

  // Readings
  scoreReading: (audio: Blob, articleId: number) => {
    const formData = new FormData()
    formData.append('audio', audio, 'recording.wav')
    formData.append('articleId', String(articleId))
    return request<any>('/api/readings/score', {
      method: 'POST',
      body: formData,
    })
  },
  getReadingDetail: (id: number) => request<any>(`/api/readings/${id}/detail`),
  getReadingHistory: (page = 1) =>
    request<any>(`/api/readings/history?page=${page}&limit=10`),

  // Stats (paid)
  getProficiencyCurve: () => request<any>('/api/stats/proficiency-curve'),
  getQualityScatter: () => request<any>('/api/stats/quality-scatter'),
  getExperienceCurve: () => request<any>('/api/stats/experience-curve'),

  // Payment
  unlockArticle: (articleId: number) =>
    request<any>('/api/payment/unlock', {
      method: 'POST',
      body: JSON.stringify({ articleId }),
    }),
  subscribe: (plan: 'monthly' | 'yearly') =>
    request<any>('/api/payment/subscribe', {
      method: 'POST',
      body: JSON.stringify({ plan }),
    }),
  getPaymentStatus: (id: string) => request<any>(`/api/payment/status/${id}`),
}