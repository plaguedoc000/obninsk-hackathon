// Все запросы к бэкенду идут через этот файл. Типы повторяют модели из backend/app/models.py

export type IssueStatus = 'new' | 'in_progress' | 'done'

export type Issue = {
  id: number
  title: string
  description: string
  category: string
  lat: number | null
  lng: number | null
  status: IssueStatus
  ai_comment: string | null
  created_at: string
}

export type IssueCreate = Pick<Issue, 'title' | 'description' | 'category' | 'lat' | 'lng'>
export type IssueUpdate = Partial<Pick<Issue, 'title' | 'description' | 'category' | 'status'>>

export type CountItem = { name: string; count: number }
export type Stats = { total: number; by_category: CountItem[]; by_status: CountItem[] }

export const STATUS_LABELS: Record<IssueStatus, string> = {
  new: 'Новое',
  in_progress: 'В работе',
  done: 'Решено',
}

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
  listIssues: () => request<Issue[]>('/issues'),
  categories: () => request<string[]>('/issues/categories'),
  createIssue: (data: IssueCreate) =>
    request<Issue>('/issues', { method: 'POST', body: JSON.stringify(data) }),
  updateIssue: (id: number, data: IssueUpdate) =>
    request<Issue>(`/issues/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
  deleteIssue: (id: number) => request<void>(`/issues/${id}`, { method: 'DELETE' }),
  askAi: (id: number) => request<Issue>(`/issues/${id}/ai`, { method: 'POST' }),
  stats: () => request<Stats>('/stats'),
}

// Бэкенд отдаёт время в UTC без часового пояса
export function formatDate(value: string) {
  const date = new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value}Z`)
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })
}
