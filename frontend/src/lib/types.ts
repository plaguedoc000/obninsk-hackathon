export type Pt = { x: number; y: number }

// Углы эталона по часовой стрелке, начиная с левого верхнего
export type Quad = [Pt, Pt, Pt, Pt]

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
  marker: Quad | null
  markerSource: 'auto' | 'manual' | null
  server: ServerScale | null
  areas: Area[]
}

export type Tool = 'marker' | 'area'
