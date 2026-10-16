import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import AppHeader from '@/components/AppHeader'
import CompareView from '@/components/CompareView'
import Editor from '@/components/Editor'
import EmptyState from '@/components/EmptyState'
import PhotoList from '@/components/PhotoList'
import Workspace, { AreaIcon, HudFrame, MarkerIcon, RailButton } from '@/components/Workspace'
import { api } from '@/lib/api'
import { makeDemoFiles } from '@/lib/demo'
import { today } from '@/lib/format'
import { createPhoto, isImageFile, photoFromServer, scaleFromServer, workspaceId } from '@/lib/photos'
import { downloadBlob } from '@/lib/report'
import type { Photo } from '@/lib/types'
import { useServerSync } from '@/lib/useServerSync'
import { cn } from '@/lib/utils'

type Patch = Partial<Photo> | ((p: Photo) => Partial<Photo>)

export default function HomePage() {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [compareIds, setCompareIds] = useState<string[] | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const [loadingDemo, setLoadingDemo] = useState(false)
  const dragDepth = useRef(0)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const active = photos.find((p) => p.id === activeId) ?? photos[0] ?? null
  const comparePhotos = compareIds ? photos.filter((p) => compareIds.includes(p.id) && p.marker) : []

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
      setCompareIds(null)
      setSelecting(false)

      const failed: string[] = []
      let missing = 0
      // по одному: сервер на каждом фото ищет эталон
      for (const [i, photo] of created.entries()) {
        try {
          const { images: [image] } = await api.uploadImage(images[i], workspaceId())
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

  useEffect(() => {
    if (!selecting) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSelecting(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selecting])

  async function loadDemo() {
    setLoadingDemo(true)
    try {
      await addFiles(await makeDemoFiles())
    } finally {
      setLoadingDemo(false)
    }
  }

  function redetect(photo: Photo) {
    const serverId = photo.serverId
    if (!serverId) return
    sync.run(photo.id, async () => {
      const image = await api.detect(serverId)
      if (!image.detection?.found || !image.calibration) {
        toast.error('Квадрат не найден. Поставьте эталон вручную')
        return
      }
      // поиск сам калибрует масштаб по найденному квадрату
      sync.applyImage(photo.id, image)
      updatePhoto(photo.id, { markerSource: 'auto' })
      toast.success('Эталон найден')
    })
  }

  function removePhoto(id: string) {
    const index = photos.findIndex((p) => p.id === id)
    const photo = photos[index]
    if (!photo) return
    const rest = photos.filter((p) => p.id !== id)
    setPhotos(rest)
    if (active?.id === id) setActiveId(rest[Math.min(index, rest.length - 1)]?.id ?? null)
    if (compareIds?.includes(id)) {
      const left = compareIds.filter((x) => x !== id)
      setCompareIds(left.length >= 2 ? left : null)
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
    if (selecting) {
      setSelecting(false)
      return
    }
    if (photos.filter((p) => p.marker).length < 2) {
      toast.error('Нужно хотя бы два фото с эталоном, чтобы сравнить их')
      return
    }
    setSelected(new Set(compareIds ?? []))
    setSelecting(true)
  }

  function toggleSelected(photo: Photo) {
    if (photo.status === 'loading') {
      toast.info('Фото ещё обрабатывается, подождите секунду')
      return
    }
    if (!photo.marker) {
      toast.error('На этом фото нет эталона. Откройте его и поставьте эталон вручную')
      return
    }
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(photo.id)) next.delete(photo.id)
      else next.add(photo.id)
      return next
    })
  }

  function confirmSelection() {
    if (selected.size < 2) {
      toast.error(selected.size === 0 ? 'Отметьте два фото или больше' : 'Отметьте ещё хотя бы одно фото')
      return
    }
    setCompareIds(photos.filter((p) => selected.has(p.id)).map((p) => p.id))
    setSelecting(false)
  }

  // Отчёт собирает сервер: дожидаемся, пока туда дойдут последние правки
  async function download(kind: 'csv' | 'zip', list: Photo[]) {
    const ids = list.filter((p) => p.serverId && p.status === 'ready').map((p) => p.serverId!)
    if (!ids.length) {
      toast.error('Сначала добавьте фото')
      return
    }
    if (!list.some((p) => p.areas.some((a) => a.closed))) {
      toast.error('Обведите хотя бы одну область: в отчёт попадают измерения')
      return
    }
    try {
      await sync.flush()
      if (kind === 'csv') downloadBlob(`отчёт-площадь-${today()}.csv`, await api.exportCsv(ids))
      else downloadBlob(`отчёт-масштаб-${today()}.zip`, await api.exportZip(ids))
      toast.success(kind === 'csv' ? 'Отчёт сохранён в CSV' : 'Архив с фото в общем масштабе сохранён')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось собрать отчёт')
    }
  }

  const saveReport = () => download('csv', photos)

  function pickFiles() {
    if (!selecting) fileInput.current?.click()
  }

  const hasFiles = (e: DragEvent) => e.dataTransfer.types.includes('Files')

  // Список фото в правой панели — один и тот же на всех экранах
  const strip = (
    <PhotoList
      photos={photos}
      highlightIds={compareIds ?? (active ? [active.id] : [])}
      selecting={selecting}
      selected={selected}
      onOpen={(id) => {
        setActiveId(id)
        setCompareIds(null)
      }}
      onToggle={toggleSelected}
      onSelectAll={() => {
        const ready = photos.filter((p) => p.marker).map((p) => p.id)
        const all = ready.every((id) => selected.has(id))
        setSelected(new Set(all ? [] : ready))
      }}
      onRemove={removePhoto}
      onAdd={pickFiles}
      onConfirm={confirmSelection}
      onCancel={() => setSelecting(false)}
    />
  )

  let view
  if (comparePhotos.length >= 2) {
    view = (
      <CompareView
        photos={comparePhotos}
        strip={strip}
        onClose={() => setCompareIds(null)}
        onZip={() => download('zip', comparePhotos)}
      />
    )
  } else if (active?.status === 'ready') {
    view = (
      <Editor
        key={active.id}
        photo={active}
        index={photos.indexOf(active)}
        count={photos.length}
        strip={strip}
        onChange={(fn) => updatePhoto(active.id, fn)}
        onRedetect={() => redetect(active)}
      />
    )
  } else if (active) {
    view = (
      <Workspace
        rail={
          <>
            <RailButton label="ЭТАЛОН" icon={<MarkerIcon />} onClick={() => {}} disabled />
            <RailButton label="ОБЛАСТЬ" icon={<AreaIcon />} onClick={() => {}} disabled />
          </>
        }
        panel={strip}
      >
        <HudFrame>
          <div className="flex min-h-[50svh] flex-col items-center justify-center gap-3 font-mono text-[13px] text-lab-text/70">
            <Loader2 className="size-8 animate-spin text-lab-red" />
            ОТКРЫВАЕМ ФОТО И ИЩЕМ ЭТАЛОН…
          </div>
        </HudFrame>
      </Workspace>
    )
  } else {
    view = (
      <EmptyState
        strip={strip}
        onPick={pickFiles}
        onPickFolder={() => folderInput.current?.click()}
        onDemo={loadDemo}
        loadingDemo={loadingDemo}
      />
    )
  }

  return (
    <div
      className={cn('lab-bg flex min-h-svh flex-col text-lab-text lg:h-svh lg:overflow-hidden', selecting && 'pt-28 lg:pt-0')}
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
      <AppHeader selecting={selecting} onSave={saveReport} onScale={toggleScaleMode} />
      {view}

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
