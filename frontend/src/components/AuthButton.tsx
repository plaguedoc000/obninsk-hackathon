import { useEffect, useState } from 'react'
import { LogIn, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { api, type AuthState } from '@/lib/api'
import { finishFlidaLogin, isFlidaCallback, startFlidaLogin } from '@/lib/flida'
import { cn } from '@/lib/utils'

const BUTTON =
  'flex h-9 items-center gap-2 border border-lab-sky/40 px-3 font-mono text-xs font-medium tracking-[.08em] whitespace-nowrap transition-colors outline-none hover:bg-lab-blue/15 focus-visible:ring-2 focus-visible:ring-lab-blue focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-60'

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')

// Вход через Флида ID. Пока не вошли — «Войти», после входа — имя, по нажатию выход
export default function AuthButton({ className }: { className?: string }) {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .me()
      .then(async (state) => {
        if (!alive) return
        setAuth(state)
        if (!state.flida_client_id || !isFlidaCallback()) return
        setBusy(true)
        try {
          const user = await finishFlidaLogin(state.flida_client_id)
          if (alive) setAuth({ ...state, user })
        } catch (e) {
          if (alive) toast.error((e as Error).message)
        } finally {
          if (alive) setBusy(false)
        }
      })
      // сервер недоступен — об этом уже сообщает главная страница
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // вернулись кнопкой «Назад» со страницы Флиды — браузер показывает страницу из кэша с крутящейся кнопкой
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && setBusy(false)
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])

  async function login() {
    if (!auth?.flida_client_id) {
      toast.error('Вход через Флида ID не настроен: заполните FLIDA_CLIENT_ID в .env на сервере')
      return
    }
    setBusy(true)
    try {
      await startFlidaLogin(auth.flida_client_id)
    } catch (e) {
      toast.error((e as Error).message)
      setBusy(false)
    }
  }

  async function logout() {
    setBusy(true)
    try {
      await api.logout()
      setAuth((a) => a && { ...a, user: null })
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (auth?.user)
    return (
      <button
        type="button"
        onClick={logout}
        disabled={busy}
        title={`${auth.user.name} — выйти из аккаунта`}
        aria-label={`${auth.user.name} — выйти из аккаунта`}
        className={cn(BUTTON, className)}
      >
        {/* на телефоне рядом с логотипом место только для инициалов */}
        <span className="sm:hidden">{initials(auth.user.name)}</span>
        <span className="max-w-40 truncate max-sm:hidden">{auth.user.name}</span>
        <LogOut className="size-4 shrink-0" aria-hidden="true" />
      </button>
    )

  return (
    <button
      type="button"
      onClick={login}
      disabled={!auth || busy}
      title="Войти через Флида ID"
      aria-label="Войти через Флида ID"
      className={cn(BUTTON, className)}
    >
      <LogIn className={cn('size-4 shrink-0', busy && 'animate-pulse')} aria-hidden="true" />
      <span className="max-sm:hidden">ВОЙТИ</span>
    </button>
  )
}
