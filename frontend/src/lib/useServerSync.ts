import { useCallback, useEffect, useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { api, type ApiImage, type ApiMeasurement } from './api'
import { pointsSig } from './measure'
import { scaleFromServer, type AreaLink } from './photos'
import type { Area, Photo } from './types'

type Patch = Partial<Photo> | ((p: Photo) => Partial<Photo>)

// Что уже лежит на сервере для одного фото: отпечаток углов эталона и области (id на сервере + отпечаток точек)
type Synced = { marker: string | null; areas: Map<string, { serverId: string; sig: string }> }

const DELAY = 400 // мс тишины после перетаскивания, прежде чем отправить изменения

const fromMeasurement = (markerSig: string, sig: string, m: ApiMeasurement): Area['server'] =>
  m.area_mm2 == null
    ? null
    : {
        sig: `${markerSig}|${sig}`,
        areaMm2: m.area_mm2,
        perimeterMm: m.perimeter_mm ?? 0,
        uncertaintyPct: m.uncertainty_pct ?? 0,
        warnings: m.warnings,
      }

const syncError = (e: unknown) => {
  toast.error(e instanceof Error ? e.message : 'Не удалось сохранить изменения на сервере', { id: 'sync-error' })
}

// Отправляет на бэкенд изменения эталона и областей и забирает обратно точные площади.
// Запросы одного фото идут строго по очереди, чтобы площадь считалась по свежему эталону
export function useServerSync(photos: Photo[], updatePhoto: (id: string, patch: Patch) => void) {
  const photosRef = useRef(photos)
  const synced = useRef(new Map<string, Synced>())
  const timers = useRef(new Map<string, number>())
  const queues = useRef(new Map<string, Promise<void>>())

  useEffect(() => {
    photosRef.current = photos
  }, [photos])

  const run = useCallback((photoId: string, job: () => Promise<void>) => {
    const next = (queues.current.get(photoId) ?? Promise.resolve()).then(job).catch(syncError)
    queues.current.set(photoId, next)
    return next
  }, [])

  // Обновляет масштаб и площади по ответу сервера об этом фото.
  // sentSig — отпечаток углов, которые мы сами отправили: тогда рамку не трогаем,
  // чтобы она не прыгала под пальцем. Без sentSig (поиск эталона) рамку берём с сервера
  const applyImage = useCallback(
    (photoId: string, image: ApiImage, sentSig?: string) => {
      const state = synced.current.get(photoId)
      if (!state) return
      const scale = scaleFromServer(image)
      const markerSig = scale.server ? (sentSig ?? scale.server.sig) : null
      state.marker = markerSig
      const byServerId = new Map(image.measurements.map((m) => [m.id, m]))
      updatePhoto(photoId, (p) => ({
        ...(sentSig ? { server: scale.server && { ...scale.server, sig: sentSig } } : scale),
        areas: p.areas.map((a) => {
          const entry = state.areas.get(a.id)
          const m = entry && byServerId.get(entry.serverId)
          return m && markerSig ? { ...a, server: fromMeasurement(markerSig, entry.sig, m) } : a
        }),
      }))
    },
    [updatePhoto],
  )

  // Запомнить фото, которое только что пришло с сервера (загрузка или восстановление после перезагрузки)
  const register = useCallback((photo: Photo, links: AreaLink[] = []) => {
    synced.current.set(photo.id, {
      marker: photo.server?.sig ?? null,
      areas: new Map(links.map((l) => [l.areaId, { serverId: l.serverId, sig: l.sig }])),
    })
  }, [])

  const reconcile = useCallback(
    async (photoId: string) => {
      const photo = photosRef.current.find((p) => p.id === photoId)
      const state = synced.current.get(photoId)
      if (!photo?.serverId || !state) return
      const id = photo.serverId

      // 1. эталон (квадрат или отрезок): пересчёт масштаба пересчитывает и все сохранённые области
      if (photo.marker) {
        const sig = pointsSig(photo.marker)
        if (sig !== state.marker) {
          const image = photo.segment ? await api.setSegment(id, photo.segment) : await api.setCorners(id, photo.marker)
          applyImage(photoId, image, sig)
        }
      }

      // 2. удалённые области
      const closed = photo.areas.filter((a) => a.closed)
      for (const [areaId, entry] of [...state.areas]) {
        if (closed.some((a) => a.id === areaId)) continue
        await api.deleteArea(id, entry.serverId).catch(() => {})
        state.areas.delete(areaId)
      }

      // 3. новые и изменённые области
      for (const area of closed) {
        const sig = pointsSig(area.points)
        const entry = state.areas.get(area.id)
        if (entry?.sig === sig) continue
        const label = `Область ${photo.areas.indexOf(area) + 1}`
        const m = entry ? await api.updateArea(id, entry.serverId, area.points) : await api.addArea(id, area.points, label)
        state.areas.set(area.id, { serverId: m.id, sig })
        const markerSig = state.marker
        if (markerSig) {
          updatePhoto(photoId, (p) => ({
            areas: p.areas.map((a) => (a.id === area.id ? { ...a, server: fromMeasurement(markerSig, sig, m) } : a)),
          }))
        }
      }
    },
    [applyImage, updatePhoto],
  )

  const needsSync = useCallback((photo: Photo) => {
    const state = synced.current.get(photo.id)
    if (!photo.serverId || !state || photo.status !== 'ready') return false
    if (photo.marker && pointsSig(photo.marker) !== state.marker) return true
    const closed = photo.areas.filter((a) => a.closed)
    if (closed.some((a) => state.areas.get(a.id)?.sig !== pointsSig(a.points))) return true
    return [...state.areas.keys()].some((id) => !closed.some((a) => a.id === id))
  }, [])

  useEffect(() => {
    for (const photo of photos) {
      if (!needsSync(photo)) continue
      window.clearTimeout(timers.current.get(photo.id))
      timers.current.set(
        photo.id,
        window.setTimeout(() => {
          timers.current.delete(photo.id)
          run(photo.id, () => reconcile(photo.id))
        }, DELAY),
      )
    }
  }, [photos, needsSync, reconcile, run])

  // Дождаться, пока все изменения дойдут до сервера (перед выгрузкой отчёта)
  const flush = useCallback(async () => {
    for (const [photoId, timer] of [...timers.current]) {
      window.clearTimeout(timer)
      timers.current.delete(photoId)
      run(photoId, () => reconcile(photoId))
    }
    for (const photo of photosRef.current) if (needsSync(photo)) run(photo.id, () => reconcile(photo.id))
    await Promise.all(queues.current.values())
  }, [needsSync, reconcile, run])

  const forget = useCallback((photoId: string) => {
    window.clearTimeout(timers.current.get(photoId))
    timers.current.delete(photoId)
    synced.current.delete(photoId)
    queues.current.delete(photoId)
  }, [])

  return useMemo(() => ({ register, applyImage, run, flush, forget }), [register, applyImage, run, flush, forget])
}
