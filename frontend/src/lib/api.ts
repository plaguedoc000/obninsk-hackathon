// Все запросы к бэкенду идут через этот файл. Типы повторяют модели из backend/app/models.py

export type Health = { status: string; llm: string }

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  })
  if (!res.ok) {
    let message = `Ошибка сервера: ${res.status}`
    try {
      const body = await res.json()
      if (body?.detail) message = typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail)
    } catch {
      // ответ не JSON — оставляем код ошибки
    }
    throw new Error(message)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

export const api = {
  health: () => request<Health>('/health'),
}

// Бэкенд отдаёт время в UTC без часового пояса
export function formatDate(value: string) {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}
