// Все запросы к бэкенду идут через этот файл. Типы повторяют ответы backend/app/main.py
// Все координаты — в пикселях фото с бэкенда (urls.file), а не экрана

export type ApiWarning = { code: string; message: string }

export type Health = { status: string; version: string; images: number; heic_supported: boolean }

export type ApiCalibration = {
  kind?: 'square' | 'segment'
  corners_px: [number, number][]
  // эталон-отрезок: два конца и длина в мм
  segment_px?: [number, number][]
  segment_mm?: number
  method: 'auto' | 'manual'
  px_per_mm: number
  uncertainty_pct: number
  perspective_used: boolean
  warnings: ApiWarning[]
}

export type ApiMeasurement = {
  id: string
  label: string | null
  shape: 'polygon' | 'circle' | 'ellipse'
  points?: [number, number][]
  area_mm2: number | null
  perimeter_mm: number | null
  uncertainty_pct: number | null
  warnings: ApiWarning[]
}

export type ApiImage = {
  id: string
  filename: string
  width: number
  height: number
  status: 'uploaded' | 'marker_not_found' | 'marker_found' | 'calibrated'
  urls: { file: string; preview: string; original: string }
  detection: { found: boolean } | null
  calibration: ApiCalibration | null
  measurements: ApiMeasurement[]
}

type Upload = { images: ApiImage[]; errors: { filename: string; message: string }[] }

async function send(path: string, init?: RequestInit): Promise<Response> {
  const json = typeof init?.body === 'string'
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      ...init,
      headers: json ? { 'Content-Type': 'application/json', ...init?.headers } : init?.headers,
    })
  } catch {
    throw new Error('Сервер недоступен. Проверьте интернет или что бэкенд запущен')
  }
  if (!res.ok) {
    let message = `Ошибка сервера: ${res.status}`
    try {
      const body = await res.json()
      const detail = body?.detail
      if (typeof detail === 'string') message = detail
      else if (detail?.message) message = detail.message
    } catch {
      // ответ не JSON — оставляем код ошибки
    }
    throw new Error(message)
  }
  return res
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  return (await send(path, init)).json() as Promise<T>
}

const pairs = (pts: { x: number; y: number }[]) => pts.map((p) => [p.x, p.y])
const ids = (list: string[]) => `image_ids=${list.map(encodeURIComponent).join(',')}`

export const api = {
  health: () => request<Health>('/health'),

  // Фото одного браузера лежат на сервере в своей группе, см. workspaceId() в photos.ts
  listImages: (group: string) => request<{ images: ApiImage[] }>(`/images?group=${encodeURIComponent(group)}`),

  // Сервер сразу ищет эталон и калибрует масштаб
  uploadImage: (file: File, group: string) => {
    const form = new FormData()
    form.append('files', file)
    form.append('group', group)
    return request<Upload>('/images', { method: 'POST', body: form })
  },

  deleteImage: (id: string) => send(`/images/${id}`, { method: 'DELETE' }),

  detect: (id: string) => request<ApiImage>(`/images/${id}/detect`, { method: 'POST', body: '{}' }),

  setCorners: (id: string, corners: { x: number; y: number }[]) =>
    request<ApiImage>(`/images/${id}/calibration`, { method: 'PUT', body: JSON.stringify({ corners: pairs(corners) }) }),

  // Эталон-отрезок: два конца и сколько это мм
  setSegment: (id: string, seg: { a: { x: number; y: number }; b: { x: number; y: number }; mm: number }) =>
    request<ApiImage>(`/images/${id}/calibration`, {
      method: 'PUT',
      body: JSON.stringify({ segment: pairs([seg.a, seg.b]), segment_mm: seg.mm }),
    }),

  addArea: (id: string, points: { x: number; y: number }[], label: string) =>
    request<ApiMeasurement>(`/images/${id}/measurements`, {
      method: 'POST',
      body: JSON.stringify({ shape: 'polygon', points: pairs(points), label }),
    }),

  updateArea: (id: string, mid: string, points: { x: number; y: number }[]) =>
    request<ApiMeasurement>(`/images/${id}/measurements/${mid}`, {
      method: 'PATCH',
      body: JSON.stringify({ shape: 'polygon', points: pairs(points) }),
    }),

  deleteArea: (id: string, mid: string) => send(`/images/${id}/measurements/${mid}`, { method: 'DELETE' }),

  // «Волшебная палочка»: щелчок внутри объекта — сервер находит его контур.
  // union — уже выделенные области: новая заливка объединится с ними (контуров может стать несколько)
  autocontour: (id: string, point: { x: number; y: number }, union?: { x: number; y: number }[][]) =>
    request<{ points_px: [number, number][]; contours_px: [number, number][][]; warnings: ApiWarning[] }>(`/images/${id}/autocontour`, {
      method: 'POST',
      body: JSON.stringify({ point: [point.x, point.y], union: union?.map(pairs) }),
    }),

  // дата в таблице — по часам пользователя
  exportCsv: async (list: string[]) => (await send(`/export.csv?${ids(list)}&tz=${-new Date().getTimezoneOffset()}`)).blob(),

  // «Сохранить файлы»: фото в общем масштабе с контурами и подписью. Одно фото — JPG, несколько — ZIP
  exportFiles: async (list: string[]) => (await send(`/export/files?${ids(list)}&tz=${-new Date().getTimezoneOffset()}`)).blob(),

  // Архив: CSV, отчёт JSON и фото в общем масштабе с сеткой 1 см
  exportZip: async (list: string[]) => (await send(`/export.zip?${ids(list)}`)).blob(),
}
