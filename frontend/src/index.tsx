import type { JSX } from 'solid-js'
import { render } from 'solid-js/web'
import { Router, Route, Navigate } from '@solidjs/router'
import { AuthProvider, useAuth } from './stores/auth'
import { Layout } from './components/Layout'
import { HomePage } from './pages/HomePage'
import { LoginPage } from './pages/LoginPage'
import { ResultPage } from './pages/ResultPage'
import { ProfilePage } from './pages/ProfilePage'
import { SubscribePage } from './pages/SubscribePage'
import { SharePage } from './pages/SharePage'
import './index.css'

function ProtectedRoute(props: { component: () => JSX.Element }) {
  const { state } = useAuth()
  if (!state.isAuthenticated) {
    return <Navigate href="/login" />
  }
  return <Layout>{props.component()}</Layout>
}

function PublicRoute(props: { component: () => JSX.Element }) {
  const { state } = useAuth()
  if (state.isAuthenticated) {
    return <Navigate href="/" />
  }
  return props.component()
}

render(
  () => (
    <AuthProvider>
      <div class="min-h-screen max-w-md mx-auto bg-white shadow-sm relative">
        <Router>
          <Route path="/login" component={() => <PublicRoute component={LoginPage} />} />
          <Route path="/share/:id" component={SharePage} />
          <Route path="/" component={() => <ProtectedRoute component={HomePage} />} />
          <Route path="/result/:id" component={() => <ProtectedRoute component={ResultPage} />} />
          <Route path="/profile" component={() => <ProtectedRoute component={ProfilePage} />} />
          <Route path="/subscribe" component={() => <ProtectedRoute component={SubscribePage} />} />
        </Router>
      </div>
    </AuthProvider>
  ),
  document.getElementById('root')!
)