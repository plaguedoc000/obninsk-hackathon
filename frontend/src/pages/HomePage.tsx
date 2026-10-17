import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { ImagePlus } from 'lucide-react'
import { toast } from 'sonner'
import AppHeader from '@/components/AppHeader'
import CompareView from '@/components/CompareView'
import Editor from '@/components/Editor'
import EmptyState, { LoadingState } from '@/components/EmptyState'
import PhotoList, { PhotoStrip } from '@/components/PhotoList'
import { Shell } from '@/components/Workspace'
import { api } from '@/lib/api'
import { today } from '@/lib/format'
import { scaleOf } from '@/lib/measure'
import { compressForUpload } from '@/lib/compress'
import { createPhoto, isImageFile, photoFromServer, scaleFromServer, workspaceId } from '@/lib/photos'
import { downloadBlob } from '@/lib/report'
import type { Photo } from '@/lib/types'
import { useMobile } from '@/lib/useMobile'
import { useServerSync } from '@/lib/useServerSync'

type Patch = Partial<Photo> | ((p: Photo) => Partial<Photo>)

export default function HomePage() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  // «Масштабирование»: picking — идёт выбор фото, picked — выбранные по порядку, normIds — уже приведённые
  const [picking, setPicking] = useState(false)
  const mobile = useMobile()
  const [picked, setPicked] = useState<string[]>([])
  const [normIds, setNormIds] = useState<string[] | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const active = photos.find((p) => p.id === activeId) ?? photos[0] ?? null

  const updatePhoto = useCallback((id: string, patch: Patch) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p)))
  }, [])

  const sync = useServerSync(photos, updatePhoto)
  const photosRef = useRef(photos)
  useEffect(() => {
    photosRef.current = photos
  }, [photos])

  // Фото этого браузера уже лежат на сервере — показываем их после перезагрузки страницы
  const restored = useRef(false)
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    api
      .listImages(workspaceId())
      .then(({ images }) => {
        if (!images.length) return
        const items = images.map(photoFromServer)
        items.forEach(({ photo, links }) => sync.register(photo, links))
        setPhotos((prev) => [...items.map((i) => i.photo), ...prev])
      })
      .catch((e: Error) => toast.error(e.message))
  }, [sync])

  const addFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter(isImageFile)
      if (!images.length) {
        if (files.length) toast.error('Среди файлов нет фото. Выберите JPG, PNG, TIFF или HEIC')
        return
      }
      const created = images.map(createPhoto)
      setPhotos((prev) => [...prev, ...created])
      setActiveId(created[0].id)
      setPicking(false)

      const failed: string[] = []
      let missing = 0
      // по одному: сервер на каждом фото ищет эталон
      for (const [i, photo] of created.entries()) {
        try {
          const { images: [image] } = await api.uploadImage(await compressForUpload(images[i]), workspaceId())
          URL.revokeObjectURL(photo.url)
          // фото удалили, пока оно загружалось
          if (!photosRef.current.some((p) => p.id === photo.id)) {
            api.deleteImage(image.id).catch(() => {})
            continue
          }
          const ready: Photo = {
            ...photo,
            serverId: image.id,
            url: image.urls.file,
            width: image.width,
            height: image.height,
            status: 'ready',
            ...scaleFromServer(image),
          }
          sync.register(ready)
          updatePhoto(photo.id, ready)
          if (!ready.marker) missing++
        } catch (e) {
          failed.push(`${photo.name} — ${e instanceof Error ? e.message : 'ошибка'}`)
          setPhotos((prev) => prev.filter((p) => p.id !== photo.id))
        }
      }
      const ok = created.length - failed.length
      if (failed.length) toast.error(`Не удалось загрузить: ${failed.join('; ')}`)
      if (missing) toast.warning(`Эталон не найден на ${missing} из ${ok} фото — укажите его вручную`)
      else if (ok) toast.success(ok === 1 ? 'Эталон найден' : `Эталон найден на всех фото: ${ok}`)
    },
    [updatePhoto, sync],
  )

  // Вставка фото из буфера обмена
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const files = Array.from(e.clipboardData?.files ?? []).filter(isImageFile)
      if (files.length) addFiles(files)
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [addFiles])

  // C — выбрать фото для приведения к масштабу, Esc — отменить выбор
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const key = e.key.toLowerCase()
      if (key === 'escape' && picking) setPicking(false)
      else if ((key === 'c' || key === 'с') && photos.length) {
        e.preventDefault()
        toggleScaleMode()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function removePhoto(id: string) {
    const index = photos.findIndex((p) => p.id === id)
    const photo = photos[index]
    if (!photo) return
    const rest = photos.filter((p) => p.id !== id)
    setPhotos(rest)
    if (active?.id === id) setActiveId(rest[Math.min(index, rest.length - 1)]?.id ?? null)
    setPicked((prev) => prev.filter((x) => x !== id))
    if (normIds?.includes(id)) {
      const left = normIds.filter((x) => x !== id)
      setNormIds(left.length >= 2 ? left : null)
    }
    // с сервера удаляем, только когда кнопка «Вернуть» исчезла
    let undone = false
    const purge = () => {
      if (undone || !photo.serverId) return
      sync.forget(photo.id)
      api.deleteImage(photo.serverId).catch(() => {})
    }
    toast(`Фото «${photo.name}» удалено`, {
      onAutoClose: purge,
      onDismiss: purge,
      action: {
        label: 'Вернуть',
        onClick: () => {
          undone = true
          setPhotos((prev) => {
            const next = [...prev]
            next.splice(Math.min(index, next.length), 0, photo)
            return next
          })
        },
      },
    })
  }

  function toggleScaleMode() {
    if (picking) {
      setPicking(false)
      return
    }
    // выбор запоминается: при повторном входе отмечены те же фото, что и в прошлый раз
    if (!picked.length && normIds) setPicked(normIds)
    setPicking(true)
  }

  function togglePick(photo: Photo) {
    if (photo.status === 'loading') {
      toast.info('Фото ещё обрабатывается, подождите секунду')
      return
    }
    if (!photo.marker) {
      toast.error('На этом фото нет эталона. Откройте его и отметьте эталон (E)')
      return
    }
    setPicked((prev) => (prev.includes(photo.id) ? prev.filter((x) => x !== photo.id) : [...prev, photo.id]))
  }

  // «Выбрать все»: отмечает все фото с эталоном (уже отмеченные сохраняют свои номера), повторно — снимает всё
  function pickAll() {
    const ready = photos.filter((p) => p.marker && p.status === 'ready').map((p) => p.id)
    const all = ready.length > 0 && ready.every((id) => picked.includes(id))
    setPicked(all ? [] : [...picked.filter((id) => ready.includes(id)), ...ready.filter((id) => !picked.includes(id))])
  }

  function applyScale() {
    if (picked.length < 2) return
    setNormIds(picked)
    setPicking(false)
  }

  function resetScale() {
    setNormIds(null)
    setPicking(false)
  }

  // Отчёт собирает сервер: дожидаемся, пока туда дойдут последние правки
  async function saveReport() {
    const ids = photos.filter((p) => p.serverId && p.status === 'ready').map((p) => p.serverId!)
    if (!ids.length) {
      toast.error('Сначала добавьте фото')
      return
    }
    if (!photos.some((p) => p.areas.some((a) => a.closed))) {
      toast.error('Обведите хотя бы одну область: в отчёт попадают измерения')
      return
    }
    try {
      await sync.flush()
      downloadBlob(`отчёт-площадь-${today()}.csv`, await api.exportCsv(ids))
      toast.success('Отчёт сохранён в CSV')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось собрать отчёт')
    }
  }

  // «Сохранить файлы»: фото в общем масштабе с контурами и подписью. Если масштаб уже приведён — только эти фото
  async function saveFiles() {
    const list = (normIds ? photos.filter((p) => normIds.includes(p.id)) : photos).filter((p) => p.serverId && p.status === 'ready')
    const ready = list.filter((p) => p.marker)
    if (!list.length) {
      toast.error('Сначала добавьте фото')
      return
    }
    if (!ready.length) {
      toast.error('Нет фото с эталоном — масштаб применить не к чему. Отметьте эталон (E)')
      return
    }
    const id = toast.loading(ready.length === 1 ? 'Готовим фото…' : `Готовим ${ready.length} фото в одном масштабе…`)
    try {
      await sync.flush()
      const blob = await api.exportFiles(ready.map((p) => p.serverId!))
      const stem = ready[0].name.replace(/\.[^.]+$/, '')
      downloadBlob(blob.type.includes('zip') ? `фото-в-масштабе-${today()}.zip` : `${stem}-в-масштабе.jpg`, blob)
      const skipped = list.length - ready.length
      toast.success(`Сохранено фото: ${ready.length}${skipped ? `. Без эталона пропущено: ${skipped}` : ''}`, { id })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить фото', { id })
    }
  }

  function pickFiles() {
    fileInput.current?.click()
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  // Список фото в правой панели; на телефоне — лента миниатюр под фото
  const List = mobile ? PhotoStrip : PhotoList
  const panel = (
    <List
      photos={photos}
      activeId={active?.id ?? null}
      picking={picking}
      picked={picked}
      normIds={normIds}
      onOpen={setActiveId}
      onToggle={togglePick}
      onRemove={removePhoto}
      onAdd={pickFiles}
      onAddFolder={() => folderInput.current?.click()}
      onSelectAll={pickAll}
      onApply={applyScale}
      onReset={resetScale}
      onCancel={() => setPicking(false)}
    />
  )

  // Приведённое фото показываем в общем масштабе со всеми приведёнными
  const normPhotos = normIds ? photos.filter((p) => normIds.includes(p.id) && p.marker && p.width) : []
  const activeScale = active ? scaleOf(active) : null
  const norm =
    active && activeScale && normPhotos.length >= 2 && normPhotos.includes(active)
      ? { list: normPhotos.map((p) => ({ width: p.width, height: p.height, ppm: scaleOf(p)!.ppm })), ppm: activeScale.ppm }
      : null

  // В режиме «Масштабирование» вместо редактора — выбранные фото рядом, по порядку выбора
  const pickedPhotos = picked
    .map((id) => photos.find((p) => p.id === id))
    .filter((p): p is Photo => !!p && p.status === 'ready' && !!p.marker && !!p.width)

  let view
  if (picking) {
    view = <CompareView photos={pickedPhotos} />
  } else if (!active) {
    view = <EmptyState onPick={pickFiles} />
  } else if (active.status === 'ready') {
    view = (
      <Editor
        key={active.id}
        photo={active}
        norm={norm}
        picking={picking}
        onChange={(fn) => updatePhoto(active.id, fn)}
      />
    )
  } else {
    view = <LoadingState photo={active} />
  }

  return (
    <div
      className="lab-bg flex h-dvh flex-col overflow-hidden overscroll-none text-lab-text lg:h-svh"
      onDragEnter={(e) => {
        if (!hasFiles(e)) return
        dragDepth.current++
        setDragOver(true)
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragOver(false)
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        dragDepth.current = 0
        setDragOver(false)
        addFiles(Array.from(e.dataTransfer.files))
      }}
    >
      <AppHeader picking={picking} normalized={!!normIds} onScale={toggleScaleMode} onSaveCsv={saveReport} onSaveFiles={saveFiles} />
      <Shell panel={panel}>{view}</Shell>

      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-lab-blue/15 p-6 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-3 border-2 border-dashed border-lab-blue bg-lab-bg px-10 py-8 text-center shadow-[0_0_40px_rgba(81,112,255,.45)]">
            <ImagePlus className="size-8 text-lab-red" />
            <p className="font-mono text-sm tracking-[.08em]">ОТПУСТИТЕ, ЧТОБЫ ДОБАВИТЬ ФОТО</p>
          </div>
        </div>
      )}

      <input
        ref={fileInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
      <input
        ref={folderInput}
        type="file"
        multiple
        hidden
        {...{ webkitdirectory: '' }}
        onChange={(e) => {
          addFiles(Array.from(e.target.files ?? []))
          e.target.value = ''
        }}
      />
    </div>
  )
}
