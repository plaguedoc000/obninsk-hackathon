import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import ImageStage, { MAX_ZOOM, type Line, type Norm } from '@/components/ImageStage'
import Workspace, { AreaRow, StageTitle, ToolRail, UNDO_ARROW } from '@/components/Workspace'
import { api } from '@/lib/api'
import { fmt } from '@/lib/format'
import { orderQuad, segmentQuad, selfIntersects } from '@/lib/geometry'
import { totalsOf } from '@/lib/measure'
import { newId } from '@/lib/photos'
import type { Area, Photo, Pt, Segment, Tool } from '@/lib/types'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'

type Snapshot = Pick<Photo, 'marker' | 'segment' | 'markerSource' | 'areas'>

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
  const mobile = useMobile()
  // «Авто» на телефоне: новая область или добавить к выбранной — вместо Shift+щелчка на компьютере
  const [addMode, setAddMode] = useState(false)

  // выбранная область; если её убрали «Назад», выбора просто нет
  const selected = photo.areas.find((a) => a.id === selectedId) ?? null
  // удалить можно выбранную область, а если область одна — её
  const toDelete = selected ?? (photo.areas.length === 1 ? photo.areas[0] : null)

  // «Назад» возвращает эталон и области к состоянию до последнего действия
  function remember() {
    const snap: Snapshot = { marker: photo.marker, segment: photo.segment, markerSource: photo.markerSource, areas: photo.areas }
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
    onChange(() => ({ marker: orderQuad(next), segment: null, markerSource: 'manual' }))
    setMarkerDraft([])
    setTool(null)
  }

  // Эталон-отрезок: вместо квадрата — отрезок известной длины (например, по шкале линейки на фото)
  function setSegment(seg: Segment) {
    onChange(() => ({ segment: seg, marker: segmentQuad(seg), markerSource: 'manual' }))
  }

  // «Отрезок»: протянутая линия становится эталоном указанной длины
  function rulerToSegment(mm: number) {
    if (!ruler) return
    if (Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y) < 4) {
      toast.error('Отрезок слишком короткий — протяните линию по шкале линейки')
      return
    }
    remember()
    setSegment({ a: ruler.a, b: ruler.b, mm })
    setRuler(null)
  }

  function segmentLength(mm: number) {
    if (!photo.segment || mm === photo.segment.mm) return
    remember()
    setSegment({ ...photo.segment, mm })
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
    if (next !== 'auto') setAddMode(false)
    // линия линейки или черновик отрезка не переносятся в другой инструмент
    setRuler(null)
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
        s: () => switchTool('segment'),
        ы: () => switchTool('segment'),
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
  const canUndo = history.length > 0 || draft.length > 0

  // Телефон: подсказка к инструменту — что сделать пальцем дальше
  let hint: string
  if (tool === 'marker') hint = markerDraft.length ? `Угол ${markerDraft.length + 1} из 4` : photo.marker && !photo.segment ? 'Тяните уголки рамки' : 'Нажмите 4 угла квадрата'
  else if (tool === 'segment') hint = photo.segment ? 'Тяните концы или исправьте мм' : 'Протяните линию по шкале'
  else if (tool === 'auto') hint = addMode ? (selected ? 'Нажмите, что добавить' : 'Нажмите на объект') : 'Нажмите на объект'
  else if (tool === 'area') hint = draft.length ? `Точек: ${draft.length}` : 'Ставьте точки по краю'
  else if (tool === 'ruler') hint = 'Протяните линию'
  else hint = photo.marker ? 'Два пальца — приблизить и сдвинуть' : 'Эталон не найден — нажмите «Эталон»'

  return (
    <Workspace
      rail={
        <ToolRail
          tool={tool}
          mask={mask}
          canUndo={canUndo}
          canDelete={!!toDelete}
          zoom={zoom}
          onTool={(t) => switchTool(tool === t ? null : t)}
          onUndo={undo}
          onDelete={deleteArea}
          onMask={() => setMask((v) => !v)}
          onZoom={zoomBy}
          refTool={photo.segment ? 'segment' : 'marker'}
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
        addMode={mobile && addMode && !!selected}
        ruler={ruler}
        onDragStart={remember}
        onMarkerChange={(marker) => onChange(() => ({ marker, segment: null, markerSource: 'manual' }))}
        onMarkerPoint={markerPoint}
        onSegmentChange={setSegment}
        onSegmentLength={segmentLength}
        onRulerToSegment={rulerToSegment}
        onMovePoint={movePoint}
        onDraftPoint={draftPoint}
        onCloseDraft={closeDraft}
        onWand={(p, add) => wand(p, add || (mobile && addMode))}
        onSelectArea={setSelectedId}
        onRuler={setRuler}
        onZoom={setZoom}
        overlay={
          mobile && (
            <div className="pointer-events-none absolute bottom-2 left-2 z-10 border border-lab-red bg-lab-bg/90 px-2.5 py-1.5 font-mono text-[13px] font-semibold whitespace-nowrap text-white shadow-[0_0_14px_rgba(224,30,60,.45)]">
              S = {area} мм²
            </div>
          )
        }
      />
      <AreaRow value={area} />
      {/* телефон: строка под фото — переключатели инструмента, подсказка, «Замкнуть», «Удалить», «Назад» */}
      {mobile && (
        <div className="flex h-11 shrink-0 items-center gap-1.5 font-mono text-[10px] font-semibold tracking-[.06em]">
          {(tool === 'marker' || tool === 'segment') && (
            <Toggle
              tone="blue"
              options={[
                ['КВАДРАТ', tool === 'marker', () => switchTool('marker')],
                ['ОТРЕЗОК', tool === 'segment', () => switchTool('segment')],
              ]}
            />
          )}
          {tool === 'auto' && (
            <Toggle
              tone="red"
              options={[
                ['НОВАЯ', !addMode, () => setAddMode(false)],
                ['ДОБАВИТЬ', addMode, () => setAddMode(true)],
              ]}
            />
          )}
          <span className="line-clamp-2 min-w-0 flex-1 text-[11px] leading-tight font-medium tracking-normal text-lab-text/70">{hint}</span>
          {tool === 'area' && draft.length >= 3 && (
            <button type="button" onClick={closeDraft} className="flex h-10 shrink-0 touch-manipulation items-center bg-lab-red px-3 text-white">
              ЗАМКНУТЬ
            </button>
          )}
          {toDelete && !draft.length && (
            <button
              type="button"
              onClick={deleteArea}
              className="flex h-10 shrink-0 touch-manipulation items-center border border-lab-red/70 px-2.5 text-[#FFB3BF]"
            >
              УДАЛИТЬ
            </button>
          )}
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            aria-label="Назад"
            className="flex size-11 shrink-0 touch-manipulation items-center justify-center border border-lab-sky/30 text-lab-red disabled:opacity-30"
          >
            <span className="flex size-5">{UNDO_ARROW}</span>
          </button>
        </div>
      )}
    </Workspace>
  )
}

// Переключатель из двух-трёх кнопок в строке под фото (телефон)
function Toggle({ tone, options }: { tone: 'blue' | 'red'; options: [string, boolean, () => void][] }) {
  return (
    <div className={cn('flex shrink-0 border', tone === 'blue' ? 'border-lab-blue/60' : 'border-lab-red/60')}>
      {options.map(([label, on, pick]) => (
        <button
          key={label}
          type="button"
          onClick={pick}
          aria-pressed={on}
          className={cn(
            'flex h-10 touch-manipulation items-center px-2.5',
            on ? (tone === 'blue' ? 'bg-lab-blue text-white' : 'bg-lab-red text-white') : 'text-lab-text/70',
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
