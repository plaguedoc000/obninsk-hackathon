import { centroid, dist, orderQuad, shoelace } from './geometry'
import type { Pt, Quad } from './types'

const MAX_SIDE = 1600
const MAX_DARK = 110

// Ищет на фото тёмный квадрат-эталон. Возвращает его углы в пикселях исходного фото или null
export function detectMarker(img: CanvasImageSource, width: number, height: number): Quad | null {
  const k = Math.min(1, MAX_SIDE / Math.max(width, height))
  const w = Math.max(1, Math.round(width * k))
  const h = Math.max(1, Math.round(height * k))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.drawImage(img, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)

  const n = w * h
  const gray = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) {
    const g = (data[i * 4] * 77 + data[i * 4 + 1] * 150 + data[i * 4 + 2] * 29) >> 8
    gray[i] = g
    hist[g]++
  }
  const threshold = Math.min(otsu(hist, n), MAX_DARK)

  const seen = new Uint8Array(n)
  const stack = new Int32Array(n)
  const minArea = Math.max(64, n * 0.0002)
  const maxArea = n * 0.25
  let best: { quad: Pt[]; score: number; area: number } | null = null

  for (let start = 0; start < n; start++) {
    if (seen[start] || gray[start] > threshold) continue
    let top = 0
    stack[top++] = start
    seen[start] = 1
    let count = 0
    let border = false
    // крайние точки пятна по осям и по диагоналям
    let sMin = Infinity, sMinI = 0, sMax = -Infinity, sMaxI = 0
    let dMin = Infinity, dMinI = 0, dMax = -Infinity, dMaxI = 0
    let xMin = Infinity, xMinI = 0, xMax = -Infinity, xMaxI = 0
    let yMin = Infinity, yMinI = 0, yMax = -Infinity, yMaxI = 0

    const push = (j: number) => {
      if (!seen[j] && gray[j] <= threshold) {
        seen[j] = 1
        stack[top++] = j
      }
    }

    while (top) {
      const i = stack[--top]
      count++
      const x = i % w
      const y = (i - x) / w
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true
      const s = x + y
      const d = x - y
      if (s < sMin) {
        sMin = s
        sMinI = i
      }
      if (s > sMax) {
        sMax = s
        sMaxI = i
      }
      if (d < dMin) {
        dMin = d
        dMinI = i
      }
      if (d > dMax) {
        dMax = d
        dMaxI = i
      }
      if (x < xMin) {
        xMin = x
        xMinI = i
      }
      if (x > xMax) {
        xMax = x
        xMaxI = i
      }
      if (y < yMin) {
        yMin = y
        yMinI = i
      }
      if (y > yMax) {
        yMax = y
        yMaxI = i
      }
      if (x > 0) push(i - 1)
      if (x < w - 1) push(i + 1)
      if (y > 0) push(i - w)
      if (y < h - 1) push(i + w)
    }

    if (border || count < minArea || count > maxArea) continue

    const toPt = (i: number): Pt => ({ x: (i % w) + 0.5, y: Math.floor(i / w) + 0.5 })
    // два набора углов: для квадрата «ровно» и для квадрата, повёрнутого почти на 45°
    for (const corners of [
      [sMinI, dMaxI, sMaxI, dMinI],
      [yMinI, xMaxI, yMaxI, xMinI],
    ]) {
      const quad = corners.map(toPt)
      const area = shoelace(quad)
      if (area < 1) continue
      const fill = count / area
      const s = quad.map((p, j) => dist(p, quad[(j + 1) % 4]))
      const ratio = Math.min(...s) / Math.max(...s)
      const diag = dist(quad[0], quad[2]) / dist(quad[1], quad[3])
      const diagRatio = Math.min(diag, 1 / diag)
      const score = Math.max(0, 1 - Math.abs(1 - fill) * 2) * ratio * diagRatio
      if (score < 0.7) continue
      if (!best || score > best.score + 0.03 || (score > best.score - 0.03 && area > best.area)) {
        // подгоняем рамку по площади пятна: крайние пиксели занижают сторону примерно на пиксель
        const c = centroid(quad)
        const grow = Math.sqrt(count / area)
        best = { quad: quad.map((p) => ({ x: c.x + (p.x - c.x) * grow, y: c.y + (p.y - c.y) * grow })), score, area }
      }
    }
  }

  if (!best) return null
  return orderQuad(best.quad.map((p) => ({ x: p.x / k, y: p.y / k })))
}

// Порог яркости по методу Оцу
function otsu(hist: Uint32Array, total: number) {
  let sum = 0
  for (let t = 0; t < 256; t++) sum += t * hist[t]
  let sumB = 0
  let wB = 0
  let best = 0
  let threshold = 0
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += t * hist[t]
    const between = wB * wF * (sumB / wB - (sum - sumB) / wF) ** 2
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}
