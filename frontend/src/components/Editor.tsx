import { useEffect, useState, type ReactNode } from 'react'
import { Check, ScanSearch, SquareDashed, Trash2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import ImageStage from '@/components/ImageStage'
import ResultPanel from '@/components/ResultPanel'
import Workspace, { AreaIcon, HudFrame, MarkerIcon, RailButton, RailDivider } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { defaultMarker } from '@/lib/geometry'
import { scaleOf } from '@/lib/measure'
import { newArea } from '@/lib/photos'
import type { Area, Photo, Pt, Tool } from '@/lib/types'

type Props = {
  photo: Photo
  index: number
  count: number
  canCompare: boolean
  strip: ReactNode
  onChange: (fn: (p: Photo) => Partial<Photo>) => void
  onRedetect: () => void
  onCompare: () => void
  onSave: () => void
}

// Рабочий экран одного фото: шаг 1 — эталон, шаг 2 — области
export default function Editor({ photo, index, count, canCompare, strip, onChange, onRedetect, onCompare, onSave }: Props) {
  const [tool, setTool] = useState<Tool>(photo.areas.length && photo.marker ? 'area' : 'marker')
  const [draftId, setDraftId] = useState<string | null>(photo.areas.find((a) => !a.closed)?.id ?? null)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const draft = photo.areas.find((a) => a.id === draftId) ?? null
  const closedCount = photo.areas.filter((a) => a.closed).length
  const quality = scaleOf(photo)

  const setAreas = (fn: (areas: Area[]) => Area[]) => onChange((p) => ({ areas: fn(p.areas) }))

  function finishDraft() {
    if (!draft) return
    if (draft.points.length < 3) {
      toast.error('Нужно хотя бы 3 точки, чтобы получилась область')
      return
    }
    setAreas((areas) => areas.map((a) => (a.id === draft.id ? { ...a, closed: true } : a)))
    setSelectedId(draft.id)
    setDraftId(null)
  }

  function cancelDraft() {
    if (!draft) return
    setAreas((areas) => areas.filter((a) => a.id !== draft.id))
    setDraftId(null)
  }

  function undoPoint() {
    if (!draft) return
    if (draft.points.length <= 1) return cancelDraft()
    setAreas((areas) => areas.map((a) => (a.id === draft.id ? { ...a, points: a.points.slice(0, -1) } : a)))
  }

  function addPoint(p: Pt) {
    if (draft) {
      setAreas((areas) => areas.map((a) => (a.id === draft.id ? { ...a, points: [...a.points, p] } : a)))
      return
    }
    const area = newArea(p)
    setAreas((areas) => [...areas, area])
    setDraftId(area.id)
    setSelectedId(null)
  }

  function movePoint(areaId: string, i: number, p: Pt) {
    setAreas((areas) => areas.map((a) => (a.id === areaId ? { ...a, points: a.points.map((q, j) => (j === i ? p : q)) } : a)))
  }

  function pointTap(areaId: string, i: number) {
    if (draft && areaId === draft.id && i === 0) finishDraft()
    else if (!draft) setSelectedId(areaId)
  }

  function deleteArea(id: string) {
    setAreas((areas) => areas.filter((a) => a.id !== id))
    if (selectedId === id) setSelectedId(null)
    if (draftId === id) setDraftId(null)
  }

  function switchTool(next: Tool) {
    if (next === tool) return
    if (draft) {
      if (draft.points.length >= 3) finishDraft()
      else cancelDraft()
    }
    setTool(next)
  }

  function placeManually() {
    onChange((p) => ({ marker: defaultMarker(p.width, p.height), markerSource: 'manual' }))
    setTool('marker')
  }

  // Горячие клавиши на компьютере
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (tool !== 'area') return
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable="true"]')) return
      if (e.key === 'Enter' && draft) {
        e.preventDefault()
        finishDraft()
      } else if (e.key === 'Escape') {
        if (draft) cancelDraft()
        else setSelectedId(null)
      } else if ((e.key === 'z' || e.key === 'я') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        undoPoint()
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        if (draft) {
          e.preventDefault()
          undoPoint()
        } else if (selectedId) {
          e.preventDefault()
          deleteArea(selectedId)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Подсказка и большая кнопка всегда говорят, что делать дальше
  let hint: string
  let cta: { label: string; onClick: () => void; disabled?: boolean }
  if (tool === 'marker') {
    if (!photo.marker) {
      hint = 'Квадрат не найден. Поставьте рамку вручную и подвиньте уголки на углы квадрата 1×1 см.'
      cta = { label: 'ПОСТАВИТЬ ЭТАЛОН', onClick: placeManually }
    } else {
      hint =
        photo.markerSource === 'auto'
          ? 'Эталон найден сам. Проверьте, что уголки синей рамки совпадают с углами квадрата.'
          : 'Подвиньте уголки рамки на углы квадрата 1×1 см. Рамку можно перетащить целиком.'
      cta = { label: 'К ОБЛАСТИ', onClick: () => switchTool('area') }
    }
  } else if (draft) {
    hint =
      draft.points.length < 3
        ? `Точек: ${draft.points.length}. Ставьте точки дальше по краю образца.`
        : `Точек: ${draft.points.length}. Нажмите на первую точку или «Замкнуть контур». Enter — готово, Esc — отмена.`
    cta = { label: 'ЗАМКНУТЬ КОНТУР', onClick: finishDraft, disabled: draft.points.length < 3 }
  } else if (closedCount) {
    hint = selectedId
      ? 'Точки выбранной области можно двигать. Нажмите на фото — начнётся новая область.'
      : 'Нажмите на фото, чтобы обвести ещё одну область, или выберите готовую.'
    cta = canCompare ? { label: 'СРАВНИТЬ ФОТО', onClick: onCompare } : { label: 'СОХРАНИТЬ ОТЧЁТ', onClick: onSave }
  } else {
    hint = 'Нажимайте на фото по краю образца, точка за точкой, а затем замкните контур.'
    cta = { label: 'ОБВЕДИТЕ ОБЛАСТЬ', onClick: () => {}, disabled: true }
  }

  const status = {
    marker: photo.marker ? (photo.markerSource === 'auto' ? 'найден' : 'вручную') : 'нет',
    area: draft ? `рисуется · ${draft.points.length} т.` : closedCount ? `${closedCount} шт.` : 'нет',
    scale: quality ? `${fmt(quality.ppm, 2)} px/мм` : '—',
  }

  return (
    <Workspace
      rail={
        <>
          <RailButton label="ЭТАЛОН" icon={<MarkerIcon />} active={tool === 'marker'} onClick={() => switchTool('marker')} />
          <RailButton label="ОБЛАСТЬ" icon={<AreaIcon />} tone="red" active={tool === 'area'} onClick={() => switchTool('area')} />
          <RailDivider />
          {tool === 'marker' ? (
            <>
              <RailButton label="НАЙТИ" icon={<ScanSearch />} onClick={onRedetect} title="Найти эталон заново" />
              <RailButton label="ВРУЧНУЮ" icon={<SquareDashed />} onClick={placeManually} title="Поставить рамку вручную" />
            </>
          ) : (
            <>
              <RailButton label="НАЗАД" icon={<Undo2 />} onClick={undoPoint} disabled={!draft} title="Убрать последнюю точку" />
              <RailButton
                label="ГОТОВО"
                icon={<Check />}
                tone="red"
                active={!!draft && draft.points.length >= 3}
                onClick={finishDraft}
                disabled={!draft}
                title="Замкнуть контур"
              />
              <RailButton
                label="УДАЛИТЬ"
                icon={<Trash2 />}
                onClick={() => selectedId && deleteArea(selectedId)}
                disabled={!selectedId || !!draft}
                title="Удалить выбранную область"
              />
            </>
          )}
        </>
      }
      panel={
        <>
          <ResultPanel
            photo={photo}
            quality={quality}
            cta={cta}
            hint={hint}
            selectedId={selectedId}
            draftId={draftId}
            onSelect={(id) => {
              setTool('area')
              if (!draft) setSelectedId(id)
            }}
            onDelete={deleteArea}
          />
          {strip}
        </>
      }
    >
      <div className="flex justify-between gap-3 font-mono text-[13px] text-lab-text/70">
        <span className="min-w-0 truncate">{photo.name}</span>
        <span className="shrink-0">
          ФОТО {index + 1} / {count}
        </span>
      </div>

      {/* рамка с уголками облегает фото: ширина как у фото плюс поля 18 px */}
      <HudFrame
        className="mx-auto w-full"
        style={{ maxWidth: `min(100%, calc(max(320px, 100svh - 260px) * ${photo.width / photo.height} + 36px))` }}
      >
        <ImageStage
          photo={photo}
          tool={tool}
          draftId={draftId}
          selectedAreaId={selectedId}
          onMarkerChange={(marker) => onChange(() => ({ marker, markerSource: 'manual' }))}
          onAddPoint={addPoint}
          onMovePoint={movePoint}
          onPointTap={pointTap}
          onSelectArea={setSelectedId}
        />
      </HudFrame>

      <div className="flex flex-wrap gap-x-7 gap-y-1 font-mono text-[13px] text-lab-text/75">
        <span>
          <span className="text-lab-sky">ЭТАЛОН</span> {status.marker}
        </span>
        <span>
          <span className="text-lab-red">ОБЛАСТЬ</span> {status.area}
        </span>
        <span>МАСШТАБ {status.scale}</span>
      </div>
    </Workspace>
  )
}
