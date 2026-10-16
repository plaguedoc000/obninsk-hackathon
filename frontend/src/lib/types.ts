export type Pt = { x: number; y: number }

// Углы эталона по часовой стрелке, начиная с левого верхнего
export type Quad = [Pt, Pt, Pt, Pt]

export type Area = { id: string; points: Pt[]; closed: boolean }

export type Photo = {
  id: string
  name: string
  url: string
  width: number
  height: number
  status: 'loading' | 'ready'
  marker: Quad | null
  markerSource: 'auto' | 'manual' | null
  areas: Area[]
}

export type Tool = 'marker' | 'area'
