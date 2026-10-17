import { fmt, today } from './format'
import { scaleOf, totalsOf } from './measure'
import { MARKER_COLOR, areaColor, loadImage } from './photos'
import type { Photo } from './types'

export function downloadBlob(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Одна картинка со всеми фото в одном масштабе: эталоны одинакового размера
export async function exportComparePng(photos: Photo[]) {
  const items = photos
    .filter((p) => p.marker)
    .map((photo) => ({ photo, ppm: scaleOf(photo)!.ppm }))
  if (!items.length) return

  // пикселей на 1 мм в итоговой картинке: не больше самого чёткого фото и не шире ~6000 пикселей
  const mmWidth = items.reduce((s, i) => s + i.photo.width / i.ppm, 0)
  const t = Math.min(Math.max(...items.map((i) => i.ppm)), 5600 / mmWidth)
  const sizes = items.map((i) => ({ w: (i.photo.width / i.ppm) * t, h: (i.photo.height / i.ppm) * t }))
  // отступы и шрифты растут вместе с картинкой, чтобы подписи читались
  const u = Math.max(1, sizes.reduce((s, x) => s + x.w, 0) / 1400)
  const pad = 48 * u
  const gap = 40 * u
  const top = 110 * u
  const caption = 80 * u
  const font = (px: number, weight = 400) => `${weight} ${Math.round(px * u)}px system-ui, sans-serif`

  const maxH = Math.max(...sizes.map((s) => s.h))
  const width = Math.round(pad * 2 + sizes.reduce((s, x) => s + x.w, 0) + gap * (items.length - 1))
  const height = Math.round(top + maxH + caption + pad)

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fbfaf6'
  ctx.fillRect(0, 0, width, height)

  ctx.fillStyle = '#23313d'
  ctx.font = font(30, 600)
  ctx.fillText('Сравнение в одном масштабе', pad, 58 * u)
  ctx.fillStyle = '#66707a'
  ctx.font = font(20)
  ctx.fillText(`Все фото приведены к масштабу ${fmt(t, 1)} пикс в 1 мм`, pad, 88 * u)

  // линейка 1 см
  const bar = 10 * t
  ctx.fillStyle = '#23313d'
  ctx.fillRect(width - pad - bar, 50 * u, bar, 8 * u)
  ctx.textAlign = 'center'
  ctx.fillText('1 см', width - pad - bar / 2, 88 * u)
  ctx.textAlign = 'start'

  let x = pad
  for (let n = 0; n < items.length; n++) {
    const { photo, ppm } = items[n]
    const { w, h } = sizes[n]
    const y = top + maxH - h
    ctx.drawImage(await loadImage(photo.url), x, y, w, h)

    const s = t / ppm
    const path = (pts: { x: number; y: number }[], closed = true) => {
      ctx.beginPath()
      pts.forEach((p, i) => (i ? ctx.lineTo(x + p.x * s, y + p.y * s) : ctx.moveTo(x + p.x * s, y + p.y * s)))
      if (closed) ctx.closePath()
    }
    ctx.lineWidth = 3 * u
    ctx.strokeStyle = MARKER_COLOR
    // эталон: квадрат или отрезок
    if (photo.segment) path([photo.segment.a, photo.segment.b], false)
    else path(photo.marker!)
    ctx.stroke()
    photo.areas.forEach((area, i) => {
      if (!area.closed) return
      ctx.strokeStyle = areaColor(i)
      path(area.points)
      ctx.stroke()
    })

    const total = totalsOf(photo).mm2
    ctx.fillStyle = '#23313d'
    ctx.font = font(20, 600)
    ctx.fillText(photo.name, x, top + maxH + 34 * u, w)
    ctx.fillStyle = '#66707a'
    ctx.font = font(18)
    ctx.fillText(total ? `Площадь: ${fmt(total, 1)} мм²` : `Исходно ${fmt(ppm, 2)} пикс в 1 мм`, x, top + maxH + 60 * u, w)
    x += w + gap
  }

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (blob) downloadBlob(`сравнение-${today()}.png`, blob)
}
