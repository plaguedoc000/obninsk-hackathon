// Фото хранятся на бэкенде: там ищется эталон и считаются площади. Здесь — состояние во вкладке

import type { ApiImage } from './api'
import { MARKER_MM } from './geometry'
import { markerSig, pointsSig } from './measure'
import type { Area, Photo, Pt, Quad } from './types'

let nextId = 1
export const newId = (prefix: string) => `${prefix}${nextId++}`

const IMAGE_EXT = /\.(jpe?g|png|webp|bmp|heic|heif|tiff?)$/i

export const isImageFile = (file: File) => file.type.startsWith('image/') || IMAGE_EXT.test(file.name)

export function createPhoto(file: File): Photo {
  return {
    id: newId('p'),
    serverId: null,
    name: file.name,
    url: URL.createObjectURL(file),
    width: 0,
    height: 0,
    status: 'loading',
    marker: null,
    markerMm: preferredMarkerMm(),
    segment: null,
    markerSource: null,
    server: null,
    areas: [],
  }
}

export const toQuad = (corners: [number, number][]) => corners.map(([x, y]) => ({ x, y })) as Quad

// Эталон и масштаб из ответа бэкенда. Эталона нет — сторону квадрата не трогаем: её выбрал человек
export function scaleFromServer(image: ApiImage): Pick<Photo, 'marker' | 'segment' | 'markerSource' | 'server'> & { markerMm?: number } {
  const cal = image.calibration
  if (!cal) return { marker: null, segment: null, markerSource: null, server: null }
  const marker = toQuad(cal.corners_px)
  const markerMm = cal.marker_size_mm ?? MARKER_MM
  const seg = cal.kind === 'segment' && cal.segment_px && cal.segment_mm ? cal.segment_px : null
  return {
    marker,
    markerMm,
    segment: seg ? { a: { x: seg[0][0], y: seg[0][1] }, b: { x: seg[1][0], y: seg[1][1] }, mm: cal.segment_mm! } : null,
    markerSource: cal.method,
    server: { sig: markerSig(marker, markerMm), pxPerMm: cal.px_per_mm, uncertaintyPct: cal.uncertainty_pct, warnings: cal.warnings },
  }
}

export type AreaLink = { areaId: string; serverId: string; sig: string }

// Фото, уже лежащее на сервере (после перезагрузки страницы). links — какая область какому измерению на сервере соответствует
export function photoFromServer(image: ApiImage): { photo: Photo; links: AreaLink[] } {
  const scale = scaleFromServer(image)
  const links: AreaLink[] = []
  const areas: Area[] = image.measurements
    .filter((m) => m.shape === 'polygon' && m.points)
    .map((m) => {
      const points = m.points!.map(([x, y]) => ({ x, y }))
      const id = newId('a')
      links.push({ areaId: id, serverId: m.id, sig: pointsSig(points) })
      return {
        id,
        points,
        closed: true,
        server:
          scale.marker && m.area_mm2 != null
            ? {
                sig: `${markerSig(scale.marker, scale.markerMm ?? MARKER_MM)}|${pointsSig(points)}`,
                areaMm2: m.area_mm2,
                perimeterMm: m.perimeter_mm ?? 0,
                uncertaintyPct: m.uncertainty_pct ?? 0,
                warnings: m.warnings,
              }
            : null,
      }
    })
  const photo: Photo = {
    id: newId('p'),
    serverId: image.id,
    name: image.filename,
    url: image.urls.file,
    width: image.width,
    height: image.height,
    status: 'ready',
    markerMm: preferredMarkerMm(),
    ...scale,
    areas,
  }
  return { photo, links }
}

// Сторона квадрата-эталона для новых фото: какую человек указал последней (в этом браузере), иначе 1 см
const MARKER_MM_KEY = 'onescale-marker-mm'
export function preferredMarkerMm() {
  try {
    const mm = Number(localStorage.getItem(MARKER_MM_KEY))
    return mm >= 0.5 && mm <= 1000 ? mm : MARKER_MM
  } catch {
    return MARKER_MM
  }
}

export function setPreferredMarkerMm(mm: number) {
  try {
    localStorage.setItem(MARKER_MM_KEY, String(mm))
  } catch {
    // хранилище недоступно (приватный режим) — просто не запоминаем
  }
}

// Своя группа на сервере у каждого браузера, чтобы на общем сайте не смешивать фото разных людей
let fallbackWorkspace = ''
export function workspaceId() {
  const make = () => `сессия-${Math.random().toString(36).slice(2, 10)}`
  try {
    let id = localStorage.getItem('onescale-workspace')
    if (!id) {
      id = make()
      localStorage.setItem('onescale-workspace', id)
    }
    return id
  } catch {
    fallbackWorkspace ||= make()
    return fallbackWorkspace
  }
}

// Загружает картинку. Событие load надёжнее img.decode(): decode может ждать, пока вкладка снова станет видимой
export function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Не удалось открыть фото'))
    img.src = url
  })
}

export const newArea = (point: Pt): Area => ({ id: newId('a'), points: [point], closed: false })

// Палитра «Лаборатории»: первая область — crimson, дальше sky blue, янтарь, бирюза, сирень, розовый
export const AREA_COLORS = ['#e01e3c', '#6495ed', '#f5a524', '#2dd4bf', '#a78bfa', '#f472b6']
// Эталон обводится синим, как --color-lab-blue в index.css
export const MARKER_COLOR = '#5170ff'

export const areaColor = (index: number) => AREA_COLORS[index % AREA_COLORS.length]
