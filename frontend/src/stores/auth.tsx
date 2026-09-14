import { createContext, useContext, createSignal, type ParentComponent } from 'solid-js'
import { createStore } from 'solid-js/store'
import { api } from '../services/api'

interface User {
  id: number
  email: string
  nickname?: string
  proficiencyScore: number
  totalExperience: number
  honorTitle: string
  subscriptionEnd?: string
}

interface AuthState {
  user: User | null
  token: string | null
  isAuthenticated: boolean
}

const AuthContext = createContext<{
  state: AuthState
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, code: string) => Promise<void>
  logout: () => void
  refreshUser: () => Promise<void>
}>()

export const AuthProvider: ParentComponent = (props) => {
  const [state, setState] = createStore<AuthState>({
    user: null,
    token: localStorage.getItem('token'),
    isAuthenticated: !!localStorage.getItem('token'),
  })

  const login = async (email: string, password: string) => {
    const data = await api.login(email, password)
    localStorage.setItem('token', data.token)
    setState({ token: data.token, user: data.user, isAuthenticated: true })
  }

  const register = async (email: string, password: string, code: string) => {
    const data = await api.register(email, password, code)
    localStorage.setItem('token', data.token)
    setState({ token: data.token, user: data.user, isAuthenticated: true })
  }

  const logout = () => {
    localStorage.removeItem('token')
    setState({ token: null, user: null, isAuthenticated: false })
  }

  const refreshUser = async () => {
    try {
      const data = await api.getMe()
      setState({ user: data })
    } catch {
      // 静默失败
    }
  }

  return (
    <AuthContext.Provider value={{ state, login, register, logout, refreshUser }}>
      {props.children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}