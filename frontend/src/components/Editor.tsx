import { useEffect, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import ImageStage, { type Line, type Norm } from '@/components/ImageStage'
import Workspace, { AreaRow, StageTitle, ToolRail } from '@/components/Workspace'
import { api } from '@/lib/api'
import { fmt } from '@/lib/format'
import { orderQuad, selfIntersects } from '@/lib/geometry'
import { totalsOf } from '@/lib/measure'
import { newId } from '@/lib/photos'
import type { Photo, Pt, Tool } from '@/lib/types'

type Snapshot = Pick<Photo, 'marker' | 'markerSource' | 'areas'>

type Props = {
  photo: Photo
  panel: ReactNode
  norm: Norm | null
  picking: boolean
  onChange: (fn: (p: Photo) => Partial<Photo>) => void
}

const ZOOMS = [1, 1.5, 2, 3]

// Рабочий экран одного фото: эталон, контур области (щелчком, лассо или правкой точек), линейка и зум
export default function Editor({ photo, panel, norm, picking, onChange }: Props) {
  const [tool, setTool] = useState<Tool | null>(photo.marker ? 'lasso' : 'marker')
  const [mask, setMask] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [history, setHistory] = useState<Snapshot[]>([])
  const [markerDraft, setMarkerDraft] = useState<Pt[]>([])
  const [ruler, setRuler] = useState<Line | null>(null)
  const [busy, setBusy] = useState(false)

  // «Назад» возвращает эталон и контур к состоянию до последнего действия
  function remember() {
    const snap: Snapshot = { marker: photo.marker, markerSource: photo.markerSource, areas: photo.areas }
    setHistory((h) => [...h.slice(-49), snap])
  }

  function undo() {
    const last = history[history.length - 1]
    if (!last) return
    setHistory((h) => h.slice(0, -1))
    setMarkerDraft([])
    onChange(() => last)
  }

  // У фото один контур: новый заменяет прежний
  function setOutline(points: Pt[]) {
    if (points.length < 3) {
      toast.error('Контур слишком маленький. Обведите объект крупнее')
      return
    }
    if (selfIntersects(points)) {
      toast.error('Контур пересекает сам себя. Обведите объект ещё раз, без петель')
      return
    }
    remember()
    onChange(() => ({ areas: [{ id: newId('a'), points, closed: true }] }))
  }

  function clearOutline() {
    if (!photo.areas.length) return
    remember()
    onChange(() => ({ areas: [] }))
  }

  // «Область»: щелчок внутри объекта — сервер сам находит его контур
  async function wand(p: Pt) {
    if (!photo.serverId) return
    setBusy(true)
    try {
      const res = await api.autocontour(photo.serverId, p)
      res.warnings.forEach((w) => toast.warning(w.message))
      setOutline(res.points_px.map(([x, y]) => ({ x, y })))
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось найти контур. Обведите объект лассо')
    } finally {
      setBusy(false)
    }
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
    setTool('lasso')
  }

  function movePoint(areaId: string, i: number, p: Pt) {
    onChange((ph) => ({ areas: ph.areas.map((a) => (a.id === areaId ? { ...a, points: a.points.map((q, j) => (j === i ? p : q)) } : a)) }))
  }

  function switchTool(next: Tool | null) {
    setTool(next)
    if (next !== 'ruler') setRuler(null)
    if (next !== 'marker') setMarkerDraft([])
  }

  function zoomBy(step: 1 | -1) {
    setZoom((z) => ZOOMS[clampIndex(ZOOMS.indexOf(z) + step)])
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
        if (!picking) switchTool(null)
        return
      }
      const actions: Record<string, () => void> = {
        e: () => switchTool('marker'),
        у: () => switchTool('marker'),
        a: () => switchTool('area'),
        ф: () => switchTool('area'),
        p: undo,
        з: undo,
        m: () => setMask((v) => !v),
        ь: () => setMask((v) => !v),
        l: () => switchTool('lasso'),
        д: () => switchTool('lasso'),
        r: () => switchTool('ruler'),
        к: () => switchTool('ruler'),
        '+': () => zoomBy(1),
        '=': () => zoomBy(1),
        '-': () => zoomBy(-1),
        delete: clearOutline,
        backspace: clearOutline,
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
  const area = photo.marker && totals.count ? fmt(totals.mm2 / 100, 2) : '—'

  return (
    <Workspace
      rail={
        <ToolRail
          tool={tool}
          mask={mask}
          canUndo={history.length > 0}
          zoom={zoom}
          onTool={(t) => switchTool(tool === t ? null : t)}
          onUndo={undo}
          onMask={() => setMask((v) => !v)}
          onZoom={zoomBy}
        />
      }
      panel={panel}
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
        ruler={ruler}
        onDragStart={remember}
        onMarkerChange={(marker) => onChange(() => ({ marker, markerSource: 'manual' }))}
        onMarkerPoint={markerPoint}
        onMovePoint={movePoint}
        onLasso={setOutline}
        onWand={wand}
        onRuler={setRuler}
      />
      <AreaRow value={area} />
    </Workspace>
  )
}

const clampIndex = (i: number) => Math.min(ZOOMS.length - 1, Math.max(0, i))
