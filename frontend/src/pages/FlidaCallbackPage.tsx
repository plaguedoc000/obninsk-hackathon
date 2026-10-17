import { useEffect } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { api } from '@/lib/api'
import { finishFlidaLogin } from '@/lib/flida'

// Сюда Флида возвращает после входа: /flida/oauth2/callback?code=…&state=…
// Меняем код на сессию сайта и уходим на главную
export default function FlidaCallbackPage() {
  const navigate = useNavigate()

  useEffect(() => {
    let alive = true
    api
      .me()
      .then(({ flida_client_id }) => {
        if (!flida_client_id) throw new Error('Вход через Флида ID не настроен')
        return finishFlidaLogin(flida_client_id)
      })
      .then((user) => alive && toast.success(`Вы вошли: ${user.name}`))
      .catch((e: Error) => alive && toast.error(e.message))
      .finally(() => alive && navigate('/', { replace: true }))
    return () => {
      alive = false
    }
  }, [navigate])

  return <p className="py-24 text-center text-muted-foreground">Входим через Флида ID…</p>
}
