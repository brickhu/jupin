import { ParentComponent } from 'solid-js'
import { A, useLocation } from '@solidjs/router'

export const Layout: ParentComponent = (props) => {
  const location = useLocation()

  const navItems = [
    { path: '/', label: '首页', icon: '📖' },
    { path: '/profile', label: '我的', icon: '👤' },
  ]

  return (
    <div class="flex flex-col min-h-screen">
      <main class="flex-1 pb-16">{props.children}</main>
      <nav class="fixed bottom-0 left-0 right-0 max-w-md mx-auto bg-white border-t border-gray-200 flex justify-around py-2 safe-area-bottom">
        {navItems.map((item) => (
          <A
            href={item.path}
            class={`flex flex-col items-center text-xs gap-1 px-4 py-1 rounded-lg transition-colors ${
              location.pathname === item.path
                ? 'text-indigo-600'
                : 'text-gray-500'
            }`}
          >
            <span class="text-lg">{item.icon}</span>
            <span>{item.label}</span>
          </A>
        ))}
      </nav>
    </div>
  )
}