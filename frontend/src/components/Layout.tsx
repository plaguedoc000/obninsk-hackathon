import { Link, NavLink, Outlet } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { PROJECT_NAME } from '@/config'
import { cn } from '@/lib/utils'

const LINKS = [
  { to: '/', label: 'Обращения' },
  { to: '/stats', label: 'Аналитика' },
]

export function Layout() {
  return (
    <div className="min-h-svh bg-muted/40">
      <header className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4">
          <Link to="/" className="flex shrink-0 items-center gap-2 font-semibold whitespace-nowrap">
            <span className="size-2.5 rounded-full bg-primary" />
            {PROJECT_NAME}
          </Link>
          <nav className="flex gap-1 text-sm">
            {LINKS.map((link) => (
              <NavLink
                key={link.to}
                to={link.to}
                end
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground',
                    isActive && 'bg-muted text-foreground',
                  )
                }
              >
                {link.label}
              </NavLink>
            ))}
          </nav>
          <a
            href="/api/docs"
            target="_blank"
            className="ml-auto text-sm text-muted-foreground hover:text-foreground"
          >
            API
          </a>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Outlet />
      </main>
      <Toaster richColors position="top-center" />
    </div>
  )
}
