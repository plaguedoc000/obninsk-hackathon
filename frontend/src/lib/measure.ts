// Какие числа показывать. Главный расчёт делает бэкенд (точнее: углы эталона с долями пикселя,
// оценка погрешности, предупреждения). Пока ответ не пришёл — например, во время перетаскивания —
// показываем быстрый расчёт в браузере из geometry.ts
import { areaMm2, markerQuality, perimeterMm } from './geometry'
import type { Area, Photo, Pt, Warning } from './types'

const r2 = (v: number) => Math.round(v * 100) / 100

// Отпечаток точек: по нему видно, для каких координат посчитано число с сервера
export const pointsSig = (pts: Pt[]) => pts.map((p) => `${r2(p.x)},${r2(p.y)}`).join(';')

export type Scale = {
  ppm: number // пикселей фото в 1 мм
  sidePx: number
  areaErrorPct: number
  small: boolean
  skewed: boolean
  warnings: Warning[] // предупреждения бэкенда об эталоне
  fromServer: boolean
}

export function scaleOf(photo: Photo): Scale | null {
  if (!photo.marker) return null
  const local = markerQuality(photo.marker)
  const s = photo.server
  if (s && s.sig === pointsSig(photo.marker)) {
    return { ...local, ppm: s.pxPerMm, areaErrorPct: s.uncertaintyPct, warnings: s.warnings, fromServer: true }
  }
  return { ...local, warnings: [], fromServer: false }
}

export type AreaValue = { mm2: number; perimeterMm: number; errorPct: number; warnings: Warning[]; fromServer: boolean }

export function areaOf(photo: Photo, area: Area): AreaValue | null {
  if (!photo.marker) return null
  const s = area.server
  if (s && s.sig === `${pointsSig(photo.marker)}|${pointsSig(area.points)}`) {
    return { mm2: s.areaMm2, perimeterMm: s.perimeterMm, errorPct: s.uncertaintyPct, warnings: s.warnings, fromServer: true }
  }
  return {
    mm2: areaMm2(area.points, photo.marker),
    perimeterMm: perimeterMm(area.points, photo.marker),
    errorPct: markerQuality(photo.marker).areaErrorPct,
    warnings: [],
    fromServer: false,
  }
}

// Сумма по всем замкнутым областям фото
export function totalsOf(photo: Photo) {
  const values = photo.areas.filter((a) => a.closed).map((a) => areaOf(photo, a))
  const ok = values.filter((v): v is AreaValue => v !== null)
  const warnings = new Map<string, Warning>()
  ok.forEach((v) => v.warnings.forEach((w) => warnings.set(w.code, w)))
  return {
    count: ok.length,
    mm2: ok.reduce((s, v) => s + v.mm2, 0),
    perimeterMm: ok.reduce((s, v) => s + v.perimeterMm, 0),
    errorPct: ok.length ? Math.max(...ok.map((v) => v.errorPct)) : 0,
    warnings: [...warnings.values()],
  }
}
