import type { Pt, Quad } from './types'

// Сторона эталона в миллиметрах
export const MARKER_MM = 10

export const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)

export const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))

// Площадь многоугольника по формуле шнурования
export function shoelace(points: Pt[]) {
  let s = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    s += a.x * b.y - b.x * a.y
  }
  return Math.abs(s) / 2
}

export function centroid(points: Pt[]): Pt {
  const n = points.length || 1
  return {
    x: points.reduce((s, p) => s + p.x, 0) / n,
    y: points.reduce((s, p) => s + p.y, 0) / n,
  }
}

export function sides(q: Quad) {
  return q.map((p, i) => dist(p, q[(i + 1) % 4]))
}

export type MarkerQuality = {
  ppm: number // пикселей фото в 1 мм
  sidePx: number
  errorPct: number // погрешность масштаба
  areaErrorPct: number
  small: boolean
  skewed: boolean
}

export function markerQuality(q: Quad): MarkerQuality {
  const s = sides(q)
  const mean = s.reduce((a, b) => a + b, 0) / 4
  const spread = (Math.max(...s) - Math.min(...s)) / mean
  const diag = dist(q[0], q[2]) / dist(q[1], q[3])
  const skew = Math.max(spread, Math.abs(1 - diag))
  // углы ставятся с точностью около 1,5 пикселя, плюс разброс сторон из-за наклона
  const errorPct = (1.5 / mean + spread / 2) * 100
  return {
    ppm: mean / MARKER_MM,
    sidePx: mean,
    errorPct,
    areaErrorPct: errorPct * 2,
    small: mean < 40,
    skewed: skew > 0.08,
  }
}

export function isConvex(q: Pt[]) {
  let sign = 0
  for (let i = 0; i < q.length; i++) {
    const a = q[i]
    const b = q[(i + 1) % q.length]
    const c = q[(i + 2) % q.length]
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x)
    if (Math.abs(cross) < 1e-9) continue
    if (sign === 0) sign = Math.sign(cross)
    else if (Math.sign(cross) !== sign) return false
  }
  return sign !== 0
}

// Решение системы линейных уравнений методом Гаусса
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[p][c])) p = r
    if (Math.abs(m[p][c]) < 1e-12) return null
    ;[m[c], m[p]] = [m[p], m[c]]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = m[r][c] / m[c][c]
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]
    }
  }
  return m.map((row, i) => row[n] / row[i])
}

// Проективное преобразование, которое переводит четыре точки src в четыре точки dst
export function homography(src: Pt[], dst: Pt[]): number[] | null {
  const a: number[][] = []
  const b: number[] = []
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]
    const { x: u, y: v } = dst[i]
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y])
    b.push(u)
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y])
    b.push(v)
  }
  const h = solve(a, b)
  return h ? [...h, 1] : null
}

export function applyH(h: number[], p: Pt): Pt {
  const w = h[6] * p.x + h[7] * p.y + h[8]
  return { x: (h[0] * p.x + h[1] * p.y + h[2]) / w, y: (h[3] * p.x + h[4] * p.y + h[5]) / w }
}

const SQUARE_MM: Pt[] = [
  { x: 0, y: 0 },
  { x: MARKER_MM, y: 0 },
  { x: MARKER_MM, y: MARKER_MM },
  { x: 0, y: MARKER_MM },
]

// Площадь в мм² с поправкой на перспективу: точки переводятся в миллиметры на плоскости эталона.
// Без наклона камеры это то же самое, что площадь_пикс × (мм/пикс)²
export function areaMm2(points: Pt[], marker: Quad) {
  const h = isConvex(marker) ? homography(marker, SQUARE_MM) : null
  if (!h) return shoelace(points) / markerQuality(marker).ppm ** 2
  return shoelace(points.map((p) => applyH(h, p)))
}

// Периметр замкнутого контура в мм, с той же поправкой на перспективу
export function perimeterMm(points: Pt[], marker: Quad) {
  const h = isConvex(marker) ? homography(marker, SQUARE_MM) : null
  const ppm = markerQuality(marker).ppm
  const mm = h ? points.map((p) => applyH(h, p)) : points.map((p) => ({ x: p.x / ppm, y: p.y / ppm }))
  return mm.reduce((s, p, i) => s + dist(p, mm[(i + 1) % mm.length]), 0)
}

// Пересекаются ли отрезки ab и cd (касание концами не считается)
function crosses(a: Pt, b: Pt, c: Pt, d: Pt) {
  const side = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  return side(a, b, c) * side(a, b, d) < 0 && side(c, d, a) * side(c, d, b) < 0
}

// Пересекает ли замкнутый контур сам себя. Такой контур бэкенд не примет
export function selfIntersects(points: Pt[]) {
  const n = points.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (crosses(points[i], points[i + 1], points[j], points[(j + 1) % n])) return true
    }
  }
  return false
}

// Упорядочивает углы по часовой стрелке, первым — левый верхний
export function orderQuad(points: Pt[]): Quad {
  const c = centroid(points)
  const sorted = [...points].sort((a, b) => Math.atan2(a.y - c.y, a.x - c.x) - Math.atan2(b.y - c.y, b.x - c.x))
  let first = 0
  sorted.forEach((p, i) => {
    if (p.x + p.y < sorted[first].x + sorted[first].y) first = i
  })
  return [0, 1, 2, 3].map((i) => sorted[(first + i) % 4]) as Quad
}

export function defaultMarker(width: number, height: number): Quad {
  const s = Math.min(width, height) * 0.15
  const cx = width / 2
  const cy = height / 2
  return [
    { x: cx - s / 2, y: cy - s / 2 },
    { x: cx + s / 2, y: cy - s / 2 },
    { x: cx + s / 2, y: cy + s / 2 },
    { x: cx - s / 2, y: cy + s / 2 },
  ]
}
