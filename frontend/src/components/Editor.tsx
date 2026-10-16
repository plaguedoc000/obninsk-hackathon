import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import ImageStage, { MAX_ZOOM, type Line, type Norm } from '@/components/ImageStage'
import Workspace, { AreaRow, StageTitle, ToolRail } from '@/components/Workspace'
import { api } from '@/lib/api'
import { fmt } from '@/lib/format'
import { orderQuad, selfIntersects } from '@/lib/geometry'
import { totalsOf } from '@/lib/measure'
import { newId } from '@/lib/photos'
import type { Area, Photo, Pt, Tool } from '@/lib/types'

type Snapshot = Pick<Photo, 'marker' | 'markerSource' | 'areas'>

type Props = {
  photo: Photo
  norm: Norm | null
  picking: boolean
  onChange: (fn: (p: Photo) => Partial<Photo>) => void
}

// шаги кнопок «+» и «−»; колесом с Ctrl (⌘) масштаб меняется плавно
const ZOOMS = [1, 1.5, 2, 3, 4, 6, MAX_ZOOM]

// Рабочий экран одного фото: эталон, области (многоугольник по точкам или «Авто»), линейка и зум
export default function Editor({ photo, norm, picking, onChange }: Props) {
  // по умолчанию ни один инструмент не выбран
  const [tool, setTool] = useState<Tool | null>(null)
  const [mask, setMask] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [markerDraft, setMarkerDraft] = useState<Pt[]>([])
  // многоугольник, который сейчас рисуется в «Области»
  const [draft, setDraft] = useState<Pt[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [ruler, setRuler] = useState<Line | null>(null)
  const [busy, setBusy] = useState(false)

  // выбранная область; если её убрали «Назад», выбора просто нет
  const selected = photo.areas.find((a) => a.id === selectedId) ?? null
  // удалить можно выбранную область, а если область одна — её
  const toDelete = selected ?? (photo.areas.length === 1 ? photo.areas[0] : null)

  // «Назад» возвращает эталон и области к состоянию до последнего действия
  function remember() {
    const snap: Snapshot = { marker: photo.marker, markerSource: photo.markerSource, areas: photo.areas }
    setHistory((h) => [...h.slice(-49), snap])
  }

  function undo() {
    if (draft.length) {
      setDraft((d) => d.slice(0, -1))
      return
    }
    const last = history[history.length - 1]
    if (!last) return
    setHistory((h) => h.slice(0, -1))
    setMarkerDraft([])
    onChange(() => last)
  }

  // Новые области; replaceId — область, которую они заменяют (объединение в «Авто»)
  function addAreas(polys: Pt[][], replaceId?: string) {
    const ok = polys.filter((p) => p.length >= 3 && !selfIntersects(p))
    if (!ok.length) {
      toast.error(polys.some((p) => p.length >= 3) ? 'Контур пересекает сам себя — поправьте точки' : 'Область слишком маленькая')
      return false
    }
    const added: Area[] = ok.map((points) => ({ id: newId('a'), points, closed: true }))
    remember()
    onChange((ph) => ({ areas: [...ph.areas.filter((a) => a.id !== replaceId), ...added] }))
    setSelectedId(added[0].id)
    return true
  }

  function closeDraft() {
    if (draft.length < 3) {
      toast.error('Нужно хотя бы 3 точки, чтобы получилась область')
      return
    }
    if (addAreas([draft])) setDraft([])
  }

  function draftPoint(p: Pt) {
    setDraft((d) => [...d, p])
    setSelectedId(null)
  }

  // «Авто»: щелчок внутри объекта — сервер сам находит его контур. С Shift — объединяем с выбранной областью
  async function wand(p: Pt, add: boolean) {
    if (!photo.serverId) return
    const target = add ? selected : null
    setBusy(true)
    try {
      const res = await api.autocontour(photo.serverId, p, target ? [target.points] : undefined)
      res.warnings.forEach((w) => toast.warning(w.message))
      addAreas(
        res.contours_px.map((c) => c.map(([x, y]) => ({ x, y }))),
        target?.id,
      )
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось найти контур. Обведите объект в «Области»')
    } finally {
      setBusy(false)
    }
  }

  function deleteArea() {
    if (!toDelete) {
      if (photo.areas.length) toast.error('Выберите область, которую нужно удалить: щёлкните по ней')
      return
    }
    remember()
    onChange((ph) => ({ areas: ph.areas.filter((a) => a.id !== toDelete.id) }))
    setSelectedId(null)
  }

  // Эталон вручную: четыре щелчка по углам квадрата
  function markerPoint(p: Pt) {
    const next = [...markerDraft, p]
    if (next.length < 4) {
      setMarkerDraft(next)
      return
    }
    remember()
    onChange(() => ({ marker: orderQuad(next), markerSource: 'manual' }))
    setMarkerDraft([])
    setTool(null)
  }

  function movePoint(areaId: string, i: number, p: Pt) {
    onChange((ph) => ({ areas: ph.areas.map((a) => (a.id === areaId ? { ...a, points: a.points.map((q, j) => (j === i ? p : q)) } : a)) }))
  }

  function switchTool(next: Tool | null) {
    // ушли из «Области» посреди рисования: 3+ точки — замыкаем, иначе бросаем
    if (next !== 'area' && draft.length) {
      if (draft.length >= 3) closeDraft()
      else setDraft([])
    }
    setTool(next)
    if (next !== 'ruler') setRuler(null)
    if (next !== 'marker') setMarkerDraft([])
  }

  function zoomBy(step: 1 | -1) {
    setZoom((z) =>
      step > 0 ? (ZOOMS.find((v) => v > z + 1e-6) ?? MAX_ZOOM) : ([...ZOOMS].reverse().find((v) => v < z - 1e-6) ?? 1),
    )
  }

  // Горячие клавиши, как подписаны на кнопках; русская раскладка тоже работает
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"]')) return
      const key = e.key.toLowerCase()
      if ((key === 'z' || key === 'я') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        undo()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (key === 'escape') {
        if (draft.length) setDraft([])
        else if (selected) setSelectedId(null)
        else if (!picking) switchTool(null)
        return
      }
      const actions: Record<string, () => void> = {
        e: () => switchTool('marker'),
        у: () => switchTool('marker'),
        a: () => switchTool('area'),
        ф: () => switchTool('area'),
        w: () => switchTool('auto'),
        ц: () => switchTool('auto'),
        p: undo,
        з: undo,
        m: () => setMask((v) => !v),
        ь: () => setMask((v) => !v),
        r: () => switchTool('ruler'),
        к: () => switchTool('ruler'),
        '+': () => zoomBy(1),
        '=': () => zoomBy(1),
        '-': () => zoomBy(-1),
        ...(draft.length ? { enter: closeDraft } : {}),
        delete: () => (draft.length ? undo() : deleteArea()),
        backspace: () => (draft.length ? undo() : deleteArea()),
      }
      const action = actions[key]
      if (!action) return
      e.preventDefault()
      action()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const totals = totalsOf(photo)
  const area = photo.marker && totals.count ? fmt(totals.mm2, 1) : '—'

  return (
    <Workspace
      rail={
        <ToolRail
          tool={tool}
          mask={mask}
          canUndo={history.length > 0 || draft.length > 0}
          canDelete={!!toDelete}
          zoom={zoom}
          onTool={(t) => switchTool(tool === t ? null : t)}
          onUndo={undo}
          onDelete={deleteArea}
          onMask={() => setMask((v) => !v)}
          onZoom={zoomBy}
        />
      }
    >
      <StageTitle name={photo.name} normed={!!norm} />
      <ImageStage
        photo={photo}
        tool={tool}
        mask={mask}
        zoom={zoom}
        norm={norm}
        busy={busy}
        markerDraft={markerDraft}
        draft={draft}
        selectedId={selected?.id ?? null}
        ruler={ruler}
        onDragStart={remember}
        onMarkerChange={(marker) => onChange(() => ({ marker, markerSource: 'manual' }))}
        onMarkerPoint={markerPoint}
        onMovePoint={movePoint}
        onDraftPoint={draftPoint}
        onCloseDraft={closeDraft}
        onWand={wand}
        onSelectArea={setSelectedId}
        onRuler={setRuler}
        onZoom={setZoom}
      />
      <AreaRow value={area} />
    </Workspace>
  )
}
