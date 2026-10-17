import { useEffect, useState } from 'react'
import { LogIn, LogOut } from 'lucide-react'
import { toast } from 'sonner'
import { api, type AuthState } from '@/lib/api'
import { startFlidaLogin } from '@/lib/flida'

// Как соседние кнопки шапки: на телефоне выше и только значок, подпись — с lg
const BUTTON =
  'flex h-10 items-center gap-2 border border-lab-sky/40 px-3 whitespace-nowrap transition-colors outline-none hover:bg-lab-blue/15 focus-visible:ring-2 focus-visible:ring-lab-blue focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-60 lg:h-9'

// Вход через Флида ID. Пока не вошли — «Войти», после входа — имя, по нажатию выход.
// Возврат от Флиды обрабатывает FlidaCallbackPage, сюда приходим уже с сессией
export default function AuthButton() {
  const [auth, setAuth] = useState<AuthState | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    api
      .me()
      .then((state) => alive && setAuth(state))
      // сервер недоступен — об этом уже сообщает главная страница
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // вернулись кнопкой «Назад» со страницы Флиды — браузер показывает страницу из кэша с неактивной кнопкой
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => e.persisted && setBusy(false)
    window.addEventListener('pageshow', onShow)
    return () => window.removeEventListener('pageshow', onShow)
  }, [])

  async function login() {
    if (!auth?.flida_client_id) {
      toast.error('Вход через Флида ID не настроен')
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

  if (auth?.user) {
    const label = `${auth.user.name} — выйти из аккаунта`
    return (
      <button type="button" onClick={logout} disabled={busy} title={label} aria-label={label} className={BUTTON}>
        <span className="hidden max-w-40 truncate lg:inline">{auth.user.name}</span>
        <LogOut className="size-4 shrink-0" aria-hidden="true" />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={login}
      disabled={!auth || busy}
      title="Войти через Флида ID"
      aria-label="Войти через Флида ID"
      className={BUTTON}
    >
      <LogIn className={busy ? 'size-4 shrink-0 animate-pulse' : 'size-4 shrink-0'} aria-hidden="true" />
      <span className="hidden lg:inline">ВОЙТИ</span>
    </button>
  )
}
