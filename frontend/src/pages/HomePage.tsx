import { useEffect, useState } from 'react'
import { api } from '@/lib/api'

export default function HomePage() {
  const [apiStatus, setApiStatus] = useState('проверяем…')

  useEffect(() => {
    api
      .health()
      .then((health) => setApiStatus(health.status === 'ok' ? 'работает' : health.status))
      .catch(() => setApiStatus('недоступен'))
  }, [])

  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-2 p-4 text-center">
      <h1 className="text-4xl font-semibold tracking-tight">Привет, мир</h1>
      <p className="text-muted-foreground">API: {apiStatus}</p>
    </main>
  )
}
