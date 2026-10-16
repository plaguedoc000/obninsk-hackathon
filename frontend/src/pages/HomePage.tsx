import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react'
import { ImagePlus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import AppHeader from '@/components/AppHeader'
import CompareView from '@/components/CompareView'
import Editor from '@/components/Editor'
import EmptyState from '@/components/EmptyState'
import PhotoList from '@/components/PhotoList'
import Workspace, { AreaIcon, HudFrame, MarkerIcon, RailButton } from '@/components/Workspace'
import { makeDemoFiles } from '@/lib/demo'
import { analyzePhoto, createPhoto, isImageFile } from '@/lib/photos'
import { downloadCsv } from '@/lib/report'
import type { Photo } from '@/lib/types'
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
  const hasPhotos = photos.length > 0

  const updatePhoto = useCallback((id: string, patch: Patch) => {
    setPhotos((prev) => prev.map((p) => (p.id === id ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p)))
  }, [])

  const addFiles = useCallback(
    async (files: File[]) => {
      const images = files.filter(isImageFile)
      if (!images.length) {
        if (files.length) toast.error('Среди файлов нет фото. Выберите JPG или PNG')
        return
      }
      const created = images.map(createPhoto)
      setPhotos((prev) => [...prev, ...created])
      setActiveId(created[0].id)
      setCompareIds(null)
      setSelecting(false)

      const failed: string[] = []
      let missing = 0
      // по одному, чтобы браузер не подвисал на больших фото
      for (const photo of created) {
        try {
          const { width, height, marker } = await analyzePhoto(photo.url)
          updatePhoto(photo.id, { width, height, marker, markerSource: marker ? 'auto' : null, status: 'ready' })
          if (!marker) missing++
        } catch {
          failed.push(photo.name)
          setPhotos((prev) => prev.filter((p) => p.id !== photo.id))
        }
      }
      const ok = created.length - failed.length
      if (failed.length) toast.error(`Не удалось открыть: ${failed.join(', ')}. Сохраните фото в JPG или PNG`)
      if (missing) toast.warning(`Эталон не найден на ${missing} из ${ok} фото — укажите его вручную`)
      else if (ok) toast.success(ok === 1 ? 'Эталон найден' : `Эталон найден на всех фото: ${ok}`)
    },
    [updatePhoto],
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

  // Фото хранятся только во вкладке: предупреждаем перед закрытием
  useEffect(() => {
    if (!hasPhotos) return
    const onLeave = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [hasPhotos])

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

  async function redetect(photo: Photo) {
    const { marker } = await analyzePhoto(photo.url)
    if (!marker) {
      toast.error('Квадрат не найден. Поставьте эталон вручную')
      return
    }
    updatePhoto(photo.id, { marker, markerSource: 'auto' })
    toast.success('Эталон найден')
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
    toast(`Фото «${photo.name}» удалено`, {
      action: {
        label: 'Вернуть',
        onClick: () =>
          setPhotos((prev) => {
            const next = [...prev]
            next.splice(Math.min(index, next.length), 0, photo)
            return next
          }),
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

  function saveReport() {
    if (!hasPhotos) {
      toast.error('Сначала добавьте фото')
      return
    }
    downloadCsv(photos.filter((p) => p.status === 'ready'))
    toast.success('Отчёт сохранён в CSV')
  }

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
    view = <CompareView photos={comparePhotos} strip={strip} onClose={() => setCompareIds(null)} />
  } else if (active?.status === 'ready') {
    view = (
      <Editor
        key={active.id}
        photo={active}
        index={photos.indexOf(active)}
        count={photos.length}
        canCompare={photos.filter((p) => p.marker).length >= 2}
        strip={strip}
        onChange={(fn) => updatePhoto(active.id, fn)}
        onRedetect={() => redetect(active)}
        onCompare={toggleScaleMode}
        onSave={saveReport}
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
      className={cn('lab-bg flex min-h-svh flex-col text-lab-text lg:h-svh lg:overflow-hidden', selecting && 'pb-28 lg:pb-0')}
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
