import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { Scan, StageFrame } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { clamp, perimeterMm, selfIntersects, simplifyPath, smoothPath, trimOverlap, untangle } from '@/lib/geometry'
import { snapToEdges } from '@/lib/snap'
import type { Photo, Pt, Quad, Tool } from '@/lib/types'

type Drag =
  | { kind: 'corner'; index: number }
  | { kind: 'marker'; start: Pt; orig: Quad }
  | { kind: 'point'; areaId: string; index: number }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'lasso' }
  | { kind: 'ruler'; a: Pt }

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
  ruler: Line | null
  onDragStart: () => void
  onMarkerChange: (q: Quad) => void
  onMarkerPoint: (p: Pt) => void
  onMovePoint: (areaId: string, index: number, p: Pt) => void
  onLasso: (points: Pt[]) => void
  onWand: (p: Pt) => void
  onRuler: (line: Line) => void
}

const RED = '#E01E3C'
const BLUE = '#5170FF'
// поля вокруг фото внутри рамки: 24 px по бокам, 30 сверху и снизу
const PAD_X = 24
const PAD_Y = 30
const LENS = 160
const LENS_ZOOM = 3

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
  ruler,
  onDragStart,
  onMarkerChange,
  onMarkerPoint,
  onMovePoint,
  onLasso,
  onWand,
  onRuler,
}: Props) {
  const { width: W, height: H, marker } = photo
  const frameRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<Drag | null>(null)
  const lassoRef = useRef<Pt[]>([])
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [center, setCenter] = useState<Pt>({ x: W / 2, y: H / 2 })
  const [mouse, setMouse] = useState<Pt | null>(null)
  const [dragging, setDragging] = useState(false)
  const [touch, setTouch] = useState(false)
  const [lassoPath, setLassoPath] = useState<Pt[] | null>(null)

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

  function toImage(e: { clientX: number; clientY: number }): Pt {
    const ctm = svgRef.current?.getScreenCTM()
    if (!ctm) return { x: 0, y: 0 }
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return { x: clamp(p.x, 0, W), y: clamp(p.y, 0, H) }
  }

  // захват указателя, чтобы перетаскивание не срывалось за краем фото
  function capture(pointerId: number) {
    try {
      svgRef.current?.setPointerCapture(pointerId)
    } catch {
      // указатель уже отпущен — захват не нужен
    }
  }

  function start(e: ReactPointerEvent, d: Drag) {
    capture(e.pointerId)
    drag.current = d
    setDragging(true)
  }

  // Перетаскивание уголка эталона, всей рамки или точки контура. Для «Назад» запоминаем, как было до него
  function grab(e: ReactPointerEvent, d: Drag) {
    if (e.button > 0 || busy) return
    e.stopPropagation()
    setTouch(e.pointerType !== 'mouse')
    onDragStart()
    start(e, d)
  }

  function onDown(e: ReactPointerEvent) {
    if (e.button > 0 || busy || !tool) return
    const p = toImage(e)
    setTouch(e.pointerType !== 'mouse')
    setMouse(p)
    if (tool === 'marker') {
      if (!marker) onMarkerPoint(p)
    } else if (tool === 'lasso') {
      lassoRef.current = [p]
      setLassoPath([p])
      start(e, { kind: 'lasso' })
    } else if (tool === 'ruler') {
      onRuler({ a: p, b: p })
      start(e, { kind: 'ruler', a: p })
    } else if (tool === 'area') {
      start(e, { kind: 'tap', x: e.clientX, y: e.clientY })
    }
  }

  function onMove(e: ReactPointerEvent) {
    const p = toImage(e)
    setMouse(p)
    const d = drag.current
    if (!d) return
    if (d.kind === 'lasso') {
      const last = lassoRef.current[lassoRef.current.length - 1]
      // точки не чаще чем раз в 2 пикселя экрана
      if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 2 * k) {
        lassoRef.current = [...lassoRef.current, p]
        setLassoPath(lassoRef.current)
      }
    } else if (d.kind === 'corner' && marker) {
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
    if (d?.kind === 'tap' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) onWand(toImage(e))
    if (d?.kind === 'lasso') {
      const pts = lassoRef.current
      lassoRef.current = []
      setLassoPath(null)
      if (pts.length >= 8) {
        const drawn = trimOverlap(pts, 20 * k)
        // оставляем только точки, которые меняют форму больше 0,3 пикселя экрана
        const finish = (line: Pt[]) => simplifyPath(line, 0.3 * k)
        // магнит: контур прилипает к краю объекта в пределах 24 пикселей экрана от линии
        const img = imgRef.current
        // на вогнутом крае прилипший контур бывает с петлёй в пару пикселей — вырезаем её, а не выбрасываем весь магнит
        const snapped = img?.complete ? untangle(finish(snapToEdges(img, smoothPath(drawn, 1), W, H, 24 * k))) : null
        // магнит не сработал (фото ещё не загрузилось) — берём линию как нарисована, сгладив дрожание руки и убрав петли
        onLasso(snapped && !selfIntersects(snapped) ? snapped : untangle(finish(smoothPath(drawn, 1))))
      }
    }
  }

  function onCancel() {
    drag.current = null
    setDragging(false)
    lassoRef.current = []
    setLassoPath(null)
  }

  // Контуры, эталон и линейка поверх фото. Рисуются и на фото, и в лупе — там без ручек.
  // u — пикселей фото в одном пикселе экрана для этого слоя
  function shapes(u: number, interactive: boolean) {
    const fill = mask ? 'rgba(224,30,60,.42)' : 'rgba(224,30,60,.06)'
    const glow = { filter: 'drop-shadow(0 0 5px rgba(81,112,255,.8))' }
    return (
      <>
        {photo.areas.map((area) =>
          area.closed ? (
            <polygon
              key={area.id}
              points={toPoints(area.points)}
              fill={fill}
              stroke={RED}
              strokeWidth={2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ) : null,
        )}
        {lassoPath && lassoPath.length > 1 && (
          <polyline
            points={toPoints(lassoPath)}
            fill={fill}
            stroke={RED}
            strokeWidth={2}
            strokeDasharray="7 5"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}

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

        {/* ручки точек контура — квадратики 12×12, их можно тянуть. У густого контура ручки не чаще чем через 14 px экрана */}
        {interactive &&
          tool === 'area' &&
          photo.areas.map((area) =>
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
  const cursor = tool === 'lasso' || tool === 'ruler' || tool === 'area' || (tool === 'marker' && !marker) ? 'crosshair' : 'default'
  const showLens = ready && !!mouse && !!tool && !busy && (!touch || dragging)

  // подпись линейки: сантиметры по эталону с поправкой на перспективу, без эталона — пиксели
  let rulerText = ''
  if (ruler) {
    const px = Math.hypot(ruler.b.x - ruler.a.x, ruler.b.y - ruler.a.y)
    rulerText = marker ? `${fmt(perimeterMm([ruler.a, ruler.b], marker) / 2 / 10, 2)} см` : `${Math.round(px)} px`
  }

  return (
    <StageFrame ref={frameRef}>
      {ready && (
        <div className="absolute shadow-[0_20px_60px_rgba(0,0,0,.6)]" style={{ left, top, width: W * s, height: H * s }}>
          <img
            ref={imgRef}
            src={photo.url}
            alt={photo.name}
            draggable={false}
            className="absolute inset-0 size-full bg-lab-paper select-none"
          />
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
