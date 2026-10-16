import { clamp } from './geometry'
import type { Pt } from './types'

// Магнитное лассо: контур, обведённый примерно, прилипает к краю объекта.
// Каждая точка сдвигается поперёк линии туда, где яркость или цвет меняются резче всего
export function snapToEdges(img: CanvasImageSource, path: Pt[], width: number, height: number, radius: number): Pt[] {
  if (path.length < 3) return path

  // считаем только кусок фото вокруг контура, большие фото уменьшаем — так быстро
  const pad = radius + 4
  const xs = path.map((p) => p.x)
  const ys = path.map((p) => p.y)
  const x0 = Math.max(0, Math.floor(Math.min(...xs) - pad))
  const y0 = Math.max(0, Math.floor(Math.min(...ys) - pad))
  const x1 = Math.min(width, Math.ceil(Math.max(...xs) + pad))
  const y1 = Math.min(height, Math.ceil(Math.max(...ys) + pad))
  const scale = Math.min(1, 1400 / Math.max(x1 - x0, y1 - y0))
  const w = Math.max(3, Math.round((x1 - x0) * scale))
  const h = Math.max(3, Math.round((y1 - y0) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return path
  ctx.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  // сила края в каждой точке: оператор Собеля по трём цветовым каналам
  const grad = new Float32Array(w * h)
  let maxGrad = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      let sum = 0
      for (let c = 0; c < 3; c++) {
        const v = (dx: number, dy: number) => data[((y + dy) * w + x + dx) * 4 + c]
        const gx = v(1, -1) + 2 * v(1, 0) + v(1, 1) - v(-1, -1) - 2 * v(-1, 0) - v(-1, 1)
        const gy = v(-1, 1) + 2 * v(0, 1) + v(1, 1) - v(-1, -1) - 2 * v(0, -1) - v(1, -1)
        sum += Math.hypot(gx, gy)
      }
      grad[y * w + x] = sum
      if (sum > maxGrad) maxGrad = sum
    }
  }
  if (!maxGrad) return path

  const local = path.map((p) => ({ x: (p.x - x0) * scale, y: (p.y - y0) * scale }))
  const R = Math.max(2, Math.round(radius * scale))
  const pts = resampleClosed(local, Math.max(1.5, R / 5))
  const n = pts.length
  const K = 2 * R + 1
  const at = (x: number, y: number) => {
    const ix = Math.round(x)
    const iy = Math.round(y)
    return ix < 1 || iy < 1 || ix >= w - 1 || iy >= h - 1 ? 0 : grad[iy * w + ix]
  }

  const normals = pts.map((_, i) => {
    const a = pts[(i - 1 + n) % n]
    const b = pts[(i + 1) % n]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    return { x: -(b.y - a.y) / len, y: (b.x - a.x) / len }
  })

  // сила края вдоль поперечных отрезков; нормируем по самому сильному краю рядом с линией
  const edge = new Float32Array(n * K)
  let top = 0
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < K; k++) {
      const t = k - R
      const g = at(pts[i].x + normals[i].x * t, pts[i].y + normals[i].y * t)
      edge[i * K + k] = g
      if (g > top) top = g
    }
  }
  if (!top) return path

  // Выбираем сдвиги всех точек сразу (динамическое программирование):
  // выгодно стоять на сильном крае и близко к нарисованной линии, но дорого резко прыгать между соседними точками.
  // Поэтому контур идёт по непрерывному краю объекта и не перескакивает на соседние предметы и надписи
  // Любой заметный край (от 30% самого сильного) считается полноценным: так контур встаёт на ближайший край,
  // а не на самый контрастный — надпись или чёрный эталон рядом не перетянут линию к себе
  const JUMP = 0.06
  const NEAR = 0.2
  const SAT = 0.3
  const cost = new Float32Array(n * K)
  const from = new Int16Array(n * K)
  const unit = (i: number, k: number) => {
    const e = edge[i * K + k] / top
    return -(e < 0.12 ? 0 : Math.min(1, e / SAT)) + (NEAR * Math.abs(k - R)) / R
  }
  for (let k = 0; k < K; k++) cost[k] = unit(0, k)
  for (let i = 1; i < n; i++) {
    for (let k = 0; k < K; k++) {
      let best = Infinity
      let arg = 0
      for (let q = 0; q < K; q++) {
        const c = cost[(i - 1) * K + q] + JUMP * Math.abs(k - q)
        if (c < best) {
          best = c
          arg = q
        }
      }
      cost[i * K + k] = best + unit(i, k)
      from[i * K + k] = arg
    }
  }
  let k = 0
  for (let q = 1; q < K; q++) if (cost[(n - 1) * K + q] < cost[(n - 1) * K + k]) k = q
  const smooth = new Array<number>(n)
  for (let i = n - 1; i >= 0; i--) {
    // край размыт на пару пикселей: встаём на его середину, где перепад сильнее всего
    let peak = k
    for (let q = Math.max(0, k - 3); q <= Math.min(K - 1, k + 3); q++) if (edge[i * K + q] > edge[i * K + peak]) peak = q
    // и уточняем середину до долей пикселя по трём соседним значениям (вершина параболы)
    let sub = 0
    if (peak > 0 && peak < K - 1) {
      const [l, c, r] = [edge[i * K + peak - 1], edge[i * K + peak], edge[i * K + peak + 1]]
      const den = l - 2 * c + r
      if (den < 0) sub = clamp((0.5 * (l - r)) / den, -0.5, 0.5)
    }
    smooth[i] = peak + sub - R
    k = from[i * K + k]
  }

  return pts.map((p, i) => ({
    x: (p.x + normals[i].x * smooth[i]) / scale + x0,
    y: (p.y + normals[i].y * smooth[i]) / scale + y0,
  }))
}

// Расставляет точки по замкнутой линии с равным шагом
function resampleClosed(points: Pt[], step: number): Pt[] {
  const out: Pt[] = [points[0]]
  let carry = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    let t = step - carry
    while (t <= len) {
      out.push({ x: a.x + ((b.x - a.x) * t) / len, y: a.y + ((b.y - a.y) * t) / len })
      t += step
    }
    carry = len - (t - step)
  }
  return out.length >= 3 ? out : points
}
