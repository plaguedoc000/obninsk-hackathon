export type Pt = { x: number; y: number }

// Углы эталона по часовой стрелке, начиная с левого верхнего
export type Quad = [Pt, Pt, Pt, Pt]

// Эталон-отрезок: два конца и его длина в мм (например, по шкале линейки на фото)
export type Segment = { a: Pt; b: Pt; mm: number }

export type Warning = { code: string; message: string }

// Что посчитал бэкенд. sig — для каких углов эталона (и точек области) посчитано:
// если с тех пор что-то подвинули, число устарело и до ответа сервера показываем расчёт в браузере
export type ServerScale = { sig: string; pxPerMm: number; uncertaintyPct: number; warnings: Warning[] }
export type ServerArea = { sig: string; areaMm2: number; perimeterMm: number; uncertaintyPct: number; warnings: Warning[] }

export type Area = { id: string; points: Pt[]; closed: boolean; server?: ServerArea | null }

export type Photo = {
  id: string
  serverId: string | null // id фото на бэкенде, пока фото загружается — null
  name: string
  url: string
  width: number
  height: number
  status: 'loading' | 'ready'
  // Квадрат эталона. Если эталон — отрезок, здесь «виртуальный» квадрат 1×1 см в его масштабе (segmentQuad):
  // по нему считаются площади, а на фото рисуется сам отрезок
  marker: Quad | null
  segment: Segment | null
  markerSource: 'auto' | 'manual' | null
  server: ServerScale | null
  areas: Area[]
}

// marker — эталон, area — многоугольник по точкам, auto — область «волшебной палочкой», ruler — линейка
export type Tool = 'marker' | 'area' | 'auto' | 'ruler'
