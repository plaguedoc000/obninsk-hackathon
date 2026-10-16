import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Scan, StageFrame } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { clamp, perimeterMm } from '@/lib/geometry'
import type { Photo, Pt, Quad, Tool } from '@/lib/types'

type Drag =
  | { kind: 'corner'; index: number }
  | { kind: 'marker'; start: Pt; orig: Quad }
  | { kind: 'point'; areaId: string; index: number }
  | { kind: 'tap'; x: number; y: number; shift: boolean }
  | { kind: 'ruler'; a: Pt }

type Pan = { x: number; y: number; cx: number; cy: number }

export type Line = { a: Pt; b: Pt }

// Фото, приведённые к общему масштабу: размеры и пикселей в 1 мм у каждого и у этого фото
export type Norm = { list: { width: number; height: number; ppm: number }[]; ppm: number }

type Props = {
  photo: Photo
  tool: Tool | null
  mask: boolean
  zoom: number
  norm: Norm | null
  busy: boolean
  markerDraft: Pt[]
  draft: Pt[]
  selectedId: string | null
  ruler: Line | null
  onDragStart: () => void
  onMarkerChange: (q: Quad) => void
  onMarkerPoint: (p: Pt) => void
  onMovePoint: (areaId: string, index: number, p: Pt) => void
  onDraftPoint: (p: Pt) => void
  onCloseDraft: () => void
  onWand: (p: Pt, add: boolean) => void
  onSelectArea: (id: string) => void
  onRuler: (line: Line) => void
  onZoom: (zoom: number) => void
}

const RED = '#E01E3C'
const BLUE = '#5170FF'
// поля вокруг фото внутри рамки: 24 px по бокам, 30 сверху и снизу
const PAD_X = 24
const PAD_Y = 30
const LENS = 160
const LENS_ZOOM = 3
export const MAX_ZOOM = 8

const toPoints = (pts: Pt[]) => pts.map((p) => `${p.x},${p.y}`).join(' ')

// Точки контура не ближе gap друг к другу (с номерами в исходном контуре) — для ручек
function sparse(points: Pt[], gap: number) {
  const out: { p: Pt; i: number }[] = []
  points.forEach((p, i) => {
    const last = out[out.length - 1]?.p
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= gap) out.push({ p, i })
  })
  const first = out[0]?.p
  const end = out[out.length - 1]?.p
  if (out.length > 3 && first && end && Math.hypot(first.x - end.x, first.y - end.y) < gap) out.pop()
  return out
}

export default function ImageStage({
  photo,
  tool,
  mask,
  zoom,
  norm,
  busy,
  markerDraft,
  draft,
  selectedId,
  ruler,
  onDragStart,
  onMarkerChange,
  onMarkerPoint,
  onMovePoint,
  onDraftPoint,
  onCloseDraft,
  onWand,
  onSelectArea,
  onRuler,
  onZoom,
}: Props) {
  const { width: W, height: H, marker } = photo
  const frameRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<Drag | null>(null)
  const pan = useRef<Pan | null>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [center, setCenter] = useState<Pt>({ x: W / 2, y: H / 2 })
  const [mouse, setMouse] = useState<Pt | null>(null)
  const [dragging, setDragging] = useState(false)
  const [panning, setPanning] = useState(false)
  const [touch, setTouch] = useState(false)

  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Масштаб: фото вписано в рамку. Если фото приведены к общему масштабу, у всех одинаково мм на пиксель экрана —
  // берём самый мелкий масштаб, при котором влезает каждое из них
  const fitOf = (w: number, h: number) => Math.max(0.001, Math.min((size.w - 2 * PAD_X) / w, (size.h - 2 * PAD_Y) / h))
  const base = norm ? Math.min(...norm.list.map((n) => fitOf(n.width, n.height) * n.ppm)) / norm.ppm : fitOf(W, H)
  const s = base * zoom
  // сколько пикселей фото приходится на один пиксель экрана: ручки и линии одного размера на любом фото
  const k = 1 / s

  // при увеличении видна часть фото; её центр не даём увести за край
  const hx = size.w / 2 / s
  const hy = size.h / 2 / s
  const cx = W <= 2 * hx ? W / 2 : clamp(center.x, hx, W - hx)
  const cy = H <= 2 * hy ? H / 2 : clamp(center.y, hy, H - hy)
  const left = size.w / 2 - cx * s
  const top = size.h / 2 - cy * s

  // Ctrl (⌘ на Mac) + колесо — масштаб вокруг курсора. Слушатель «не пассивный», иначе браузер увеличит всю страницу
  const view = useRef({ s, base, cx, cy, zoom, w: size.w, h: size.h, onZoom })
  useLayoutEffect(() => {
    view.current = { s, base, cx, cy, zoom, w: size.w, h: size.h, onZoom }
  })
  useEffect(() => {
    const el = frameRef.current
    if (!el) return
    const frame: HTMLDivElement = el
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const v = view.current
      const next = clamp(v.zoom * Math.exp(-e.deltaY * 0.0025), 1, MAX_ZOOM)
      if (next === v.zoom) return
      const r = frame.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      // точка фото под курсором остаётся под курсором
      const px = v.cx + (mx - v.w / 2) / v.s
      const py = v.cy + (my - v.h / 2) / v.s
      const s2 = v.base * next
      setCenter({ x: px - (mx - v.w / 2) / s2, y: py - (my - v.h / 2) / s2 })
      v.onZoom(next)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  function toImage(e: { clientX: number; clientY: number }): Pt {
    const ctm = svgRef.current?.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) }
  }

  // захват указателя, чтобы перетаскивание не срывалось за краем фото
  function capture(el: Element | null, pointerId: number) {
    try {
      el?.setPointerCapture(pointerId)
    } catch {
      // указатель уже отпущен — захват не нужен
    }
  }

  function start(e: ReactPointerEvent, d: Drag) {
    e.stopPropagation()
    capture(svgRef.current, e.pointerId)
    drag.current = d
    setDragging(true)
  }

  // Перетаскивание уголка эталона, всей рамки или точки контура. Для «Назад» запоминаем, как было до него
  function grab(e: ReactPointerEvent, d: Drag) {
    if (e.button > 0 || busy) return
    setTouch(e.pointerType !== 'mouse')
    onDragStart()
    start(e, d)
  }

  // Лапка: правой (или средней) кнопкой фото двигается всегда, левой — когда инструмент не выбран
  function onPanDown(e: ReactPointerEvent<HTMLDivElement>) {
    if (zoom <= 1 || (e.button === 0 && tool) || e.button > 2) return
    e.preventDefault()
    capture(e.currentTarget, e.pointerId)
    pan.current = { x: e.clientX, y: e.clientY, cx, cy }
    setPanning(true)
  }

  function onPanMove(e: ReactPointerEvent<HTMLDivElement>) {
    const p = pan.current
    if (p) setCenter({ x: p.cx - (e.clientX - p.x) / s, y: p.cy - (e.clientY - p.y) / s })
  }

  function onPanUp() {
    pan.current = null
    setPanning(false)
  }

  function onDown(e: ReactPointerEvent) {
    // правая кнопка и «лапка» без инструмента уходят выше, в onPanDown
    if (e.button > 0 || busy || !tool) return
    const p = toImage(e)
    setTouch(e.pointerType !== 'mouse')
    setMouse(p)
    if (tool === 'marker') {
      e.stopPropagation()
      if (!marker) onMarkerPoint(p)
    } else if (tool === 'ruler') {
      onRuler({ a: p, b: p })
      start(e, { kind: 'ruler', a: p })
    } else {
      start(e, { kind: 'tap', x: e.clientX, y: e.clientY, shift: e.shiftKey })
    }
  }

  function onMove(e: ReactPointerEvent) {
    const p = toImage(e)
    setMouse(p)
    const d = drag.current
    if (!d) return
    if (d.kind === 'corner' && marker) {
      const q = [...marker] as Quad
      q[d.index] = p
      onMarkerChange(q)
    } else if (d.kind === 'marker') {
      const xs = d.orig.map((c) => c.x)
      const ys = d.orig.map((c) => c.y)
      const dx = clamp(p.x - d.start.x, -Math.min(...xs), W - Math.max(...xs))
      const dy = clamp(p.y - d.start.y, -Math.min(...ys), H - Math.max(...ys))
      onMarkerChange(d.orig.map((c) => ({ x: c.x + dx, y: c.y + dy })) as Quad)
    } else if (d.kind === 'point') {
      onMovePoint(d.areaId, d.index, p)
    } else if (d.kind === 'ruler') {
      onRuler({ a: d.a, b: p })
    }
  }

  function onUp(e: ReactPointerEvent) {
    const d = drag.current
    drag.current = null
    setDragging(false)
    if (touch) setMouse(null)
    // щелчок, а не протяжка: ставим точку многоугольника или зовём «волшебную палочку»
    if (d?.kind === 'tap' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) {
      if (tool === 'area') onDraftPoint(toImage(e))
      else if (tool === 'auto') onWand(toImage(e), d.shift)
    }
  }

  function onCancel() {
    drag.current = null
    setDragging(false)
  }

  // Готовую область можно выбрать щелчком: без инструмента, в «Области» (пока ничего не рисуется) и в «Авто».
  // В «Авто» с Shift щелчок уходит палочке — добавить к выбранной области
  const selectable = !tool || tool === 'auto' || (tool === 'area' && !draft.length)

  // Контуры, эталон и линейка поверх фото. Рисуются и на фото, и в лупе — там без ручек.
  // u — пикселей фото в одном пикселе экрана для этого слоя
  function shapes(u: number, interactive: boolean) {
    const glow = { filter: 'drop-shadow(0 0 5px rgba(81,112,255,.8))' }
    const last = draft[draft.length - 1]
    return (
      <>
        {photo.areas.map((area) => {
          if (!area.closed) return null
          const selected = area.id === selectedId
          const fill = mask ? 'rgba(224,30,60,.42)' : selected ? 'rgba(224,30,60,.16)' : 'rgba(224,30,60,.06)'
          return (
            <polygon
              key={area.id}
              points={toPoints(area.points)}
              fill={fill}
              stroke={RED}
              strokeWidth={selected ? 3 : 2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className={interactive && selectable ? 'cursor-pointer' : undefined}
              pointerEvents={interactive && selectable ? 'all' : 'none'}
              onPointerDown={
                interactive
                  ? (e) => {
                      if (e.button > 0 || busy || (tool === 'auto' && e.shiftKey)) return
                      e.stopPropagation()
                      onSelectArea(area.id)
                    }
                  : undefined
              }
            />
          )
        })}

        {/* многоугольник, который сейчас рисуется: пунктир по точкам и линия к курсору */}
        {draft.length > 0 && (
          <g pointerEvents="none">
            <polyline
              points={toPoints(draft)}
              fill="none"
              stroke={RED}
              strokeWidth={2}
              strokeDasharray="7 5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {mouse && tool === 'area' && last && (
              <line
                x1={last.x}
                y1={last.y}
                x2={mouse.x}
                y2={mouse.y}
                stroke={RED}
                strokeWidth={1.5}
                strokeDasharray="4 4"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </g>
        )}
        {draft.map((p, i) => {
          const closer = i === 0 && draft.length >= 3
          return (
            <g key={i}>
              <circle
                cx={p.x}
                cy={p.y}
                r={(closer ? 8 : 5) * u}
                fill={closer ? RED : '#04050F'}
                stroke={closer ? '#fff' : RED}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
              {/* щелчок по первой точке замыкает контур */}
              {interactive && closer && (
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={14 * u}
                  fill="transparent"
                  className="cursor-pointer"
                  onPointerDown={(e) => {
                    if (e.button > 0) return
                    e.stopPropagation()
                    onCloseDraft()
                  }}
                />
              )}
            </g>
          )
        })}

        {marker && (
          <polygon
            points={toPoints(marker)}
            fill="transparent"
            stroke={BLUE}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            className="cursor-move"
            pointerEvents={interactive && tool === 'marker' ? 'all' : 'none'}
            onPointerDown={interactive ? (e) => grab(e, { kind: 'marker', start: toImage(e), orig: marker }) : undefined}
          />
        )}
        {(marker ?? markerDraft).map((c, i) => (
          <g key={i}>
            <circle cx={c.x} cy={c.y} r={7 * u} fill={BLUE} stroke="#fff" strokeWidth={2} vectorEffect="non-scaling-stroke" style={glow} pointerEvents="none" />
            {interactive && marker && tool === 'marker' && (
              <circle
                cx={c.x}
                cy={c.y}
                r={14 * u}
                fill="transparent"
                className="cursor-grab"
                onPointerDown={(e) => grab(e, { kind: 'corner', index: i })}
              />
            )}
          </g>
        ))}

        {/* ручки точек выбранной области — квадратики 12×12, их можно тянуть. У густого контура ручки не чаще чем через 14 px экрана */}
        {interactive &&
          tool === 'area' &&
          !draft.length &&
          photo.areas
            .filter((area) => area.id === selectedId)
            .map((area) =>
              sparse(area.points, 14 * u).map(({ p, i }) => (
                <g key={`${area.id}-${i}`}>
                  <rect
                    x={p.x - 6 * u}
                    y={p.y - 6 * u}
                    width={12 * u}
                    height={12 * u}
                    fill="#04050F"
                    stroke={RED}
                    strokeWidth={2}
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={10 * u}
                    fill="transparent"
                    className="cursor-move"
                    onPointerDown={(e) => grab(e, { kind: 'point', areaId: area.id, index: i })}
                  />
                </g>
              )),
            )}

        {interactive && ruler && (
          <g pointerEvents="none">
            <line
              x1={ruler.a.x}
              y1={ruler.a.y}
              x2={ruler.b.x}
              y2={ruler.b.y}
              stroke="#6495ED"
              strokeWidth={2}
              strokeDasharray="6 4"
              vectorEffect="non-scaling-stroke"
            />
            {[ruler.a, ruler.b].map((p, i) => (
              <circle key={i} cx={p.x} cy={p.y} r={5 * u} fill="#04050F" stroke="#6495ED" strokeWidth={2} vectorEffect="non-scaling-stroke" />
            ))}
          </g>
        )}
      </>
    )
  }

  const ready = size.w > 0 && W > 0
  // при увеличении без инструмента курсор — лапка; во время перетаскивания — сжатая лапка
  const cursor = panning
    ? 'grabbing'
    : !tool
      ? zoom > 1
        ? 'grab'
        : 'default'
      : tool === 'marker' && marker
        ? 'default'
        : 'crosshair'
  const showLens = ready && !!mouse && !!tool && !busy && !panning && (!touch || dragging)

  // подпись линейки: сантиметры по эталону с поправкой на перспективу, без эталона — пиксели
  let rulerText = ''
  if (ruler) {
    const px = Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y)
    rulerText = marker ? `${fmt(perimeterMm([ruler.a, ruler.b], marker) / 2 / 10, 2)} см` : `${Math.round(px)} px`
  }

  return (
    <StageFrame ref={frameRef}>
      <div
        className="absolute inset-0"
        style={{ cursor }}
        onPointerDown={onPanDown}
        onPointerMove={onPanMove}
        onPointerUp={onPanUp}
        onPointerCancel={onPanUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        {ready && (
          <div className="absolute shadow-[0_20px_60px_rgba(0,0,0,.6)]" style={{ left, top, width: W * s, height: H * s }}>
            <img src={photo.url} alt={photo.name} draggable={false} className="absolute inset-0 size-full bg-lab-paper select-none" />
            <svg
              ref={svgRef}
              viewBox={`0 0 ${W} ${H}`}
              className="absolute inset-0 size-full overflow-visible"
              style={{ cursor, touchAction: tool ? 'none' : 'pan-y pinch-zoom' }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onPointerCancel={onCancel}
              onPointerLeave={() => !dragging && setMouse(null)}
            >
              {shapes(k, true)}
            </svg>
            {busy && <Scan />}
          </div>
        )}
      </div>

      {ready && ruler && rulerText && Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y) > 0 && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-[140%] bg-lab-blue px-2 py-1 font-mono text-xs font-semibold whitespace-nowrap text-white shadow-[0_0_14px_rgba(81,112,255,.6)]"
          style={{ left: left + ((ruler.a.x + ruler.b.x) / 2) * s, top: top + ((ruler.a.y + ruler.b.y) / 2) * s }}
        >
          {rulerText}
        </div>
      )}

      {showLens && mouse && <Lens photo={photo} point={mouse} s={s} left={left} top={top} size={size} shapes={shapes} />}

      {ready && zoom > 1 && <Minimap photo={photo} view={{ x0: cx - hx, x1: cx + hx, y0: cy - hy, y1: cy + hy }} onCenter={setCenter} />}
    </StageFrame>
  )
}

type LensProps = {
  photo: Photo
  point: Pt
  s: number
  left: number
  top: number
  size: { w: number; h: number }
  shapes: (u: number, interactive: boolean) => ReactNode
}

// Лупа ×3 рядом с курсором: видно, куда точно встаёт уголок или точка
function Lens({ photo, point, s, left, top, size, shapes }: LensProps) {
  const L = s * LENS_ZOOM
  const sx = left + point.x * s
  const sy = top + point.y * s
  const lensL = sx + 24 + LENS > size.w ? sx - LENS - 24 : sx + 24
  const lensT = sy - LENS - 24 < 0 ? sy + 24 : sy - LENS - 24
  return (
    <div
      className="pointer-events-none absolute z-10 size-40 overflow-hidden rounded-full border-2 border-lab-blue bg-black shadow-[0_0_0_4px_rgba(4,5,15,.85),0_0_30px_rgba(81,112,255,.6)]"
      style={{ left: lensL, top: lensT }}
    >
      <div
        className="absolute"
        style={{ left: LENS / 2 - point.x * L, top: LENS / 2 - point.y * L, width: photo.width * L, height: photo.height * L }}
      >
        <img src={photo.url} alt="" className="absolute inset-0 size-full bg-lab-paper" />
        <svg viewBox={`0 0 ${photo.width} ${photo.height}`} className="absolute inset-0 size-full overflow-visible">
          {shapes(1 / L, false)}
        </svg>
      </div>
      <div className="absolute top-14 left-[79px] h-12 w-0.5 bg-lab-blue" />
      <div className="absolute top-[79px] left-14 h-0.5 w-12 bg-lab-blue" />
      <div className="absolute inset-x-0 bottom-3 text-center font-mono text-[10px] font-semibold text-white [text-shadow:0_0_4px_#000]">
        ×3
      </div>
    </div>
  )
}

// Мини-карта при увеличении: где сейчас смотрим. Нажмите или ведите по ней, чтобы сдвинуть вид
function Minimap({ photo, view, onCenter }: { photo: Photo; view: { x0: number; x1: number; y0: number; y1: number }; onCenter: (p: Pt) => void }) {
  const { width: W, height: H } = photo
  const m = Math.min(144 / W, 96 / H)
  const ox = (144 - W * m) / 2
  const oy = (96 - H * m) / 2
  const x0 = clamp(view.x0, 0, W)
  const x1 = clamp(view.x1, 0, W)
  const y0 = clamp(view.y0, 0, H)
  const y1 = clamp(view.y1, 0, H)
  const pressed = useRef(false)

  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect()
    onCenter({ x: (e.clientX - r.left - ox) / m, y: (e.clientY - r.top - oy) / m })
  }

  return (
    <div className="absolute right-4 bottom-4 z-10 h-[100px] w-[148px] border border-lab-blue/50 bg-lab-bg p-[2px]">
      <div
        className="relative h-24 w-36 cursor-pointer touch-none overflow-hidden"
        onPointerDown={(e) => {
          pressed.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          move(e)
        }}
        onPointerMove={(e) => pressed.current && move(e)}
        onPointerUp={() => (pressed.current = false)}
      >
        <img src={photo.url} alt="" draggable={false} className="absolute" style={{ left: ox, top: oy, width: W * m, height: H * m }} />
        <div
          className="absolute border-2 border-lab-blue bg-lab-blue/15"
          style={{ left: ox + x0 * m, top: oy + y0 * m, width: (x1 - x0) * m, height: (y1 - y0) * m }}
        />
      </div>
    </div>
  )
}
