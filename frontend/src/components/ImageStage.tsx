import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { fmt } from '@/lib/format'
import { centroid, clamp, selfIntersects, simplifyPath, smoothPath, trimOverlap } from '@/lib/geometry'
import { areaOf } from '@/lib/measure'
import { MARKER_COLOR, areaColor } from '@/lib/photos'
import { snapToEdges } from '@/lib/snap'
import type { Photo, Pt, Quad, Tool } from '@/lib/types'
import { cn } from '@/lib/utils'

type Drag =
  | { kind: 'corner'; index: number }
  | { kind: 'marker'; start: Pt; orig: Quad }
  | { kind: 'point'; areaId: string; index: number; moved: boolean; x: number; y: number }
  | { kind: 'tap'; x: number; y: number }
  | { kind: 'lasso' }

type Props = {
  photo: Photo
  tool: Tool
  draftId: string | null
  selectedAreaId: string | null
  onMarkerChange: (q: Quad) => void
  onAddPoint: (p: Pt) => void
  onMovePoint: (areaId: string, index: number, p: Pt) => void
  onPointTap: (areaId: string, index: number) => void
  onSelectArea: (id: string) => void
  lasso?: boolean
  onLasso?: (points: Pt[]) => void
}

const toPoints = (pts: Pt[]) => pts.map((p) => `${p.x},${p.y}`).join(' ')

export default function ImageStage({
  photo,
  tool,
  draftId,
  selectedAreaId,
  onMarkerChange,
  onAddPoint,
  onMovePoint,
  onPointTap,
  onSelectArea,
  lasso,
  onLasso,
}: Props) {
  const { width: W, height: H, marker } = photo
  const wrapRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const drag = useRef<Drag | null>(null)
  const [renderedW, setRenderedW] = useState(0)
  const [loupe, setLoupe] = useState<Pt | null>(null)
  const [hover, setHover] = useState<Pt | null>(null)
  const lassoRef = useRef<Pt[]>([])
  const [lassoPath, setLassoPath] = useState<Pt[] | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setRenderedW(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // сколько пикселей фото приходится на один пиксель экрана: так ручки и подписи не зависят от размера фото
  const k = renderedW ? W / renderedW : 1
  const handleR = 7 * k
  const hitR = 14 * k

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

  function begin(e: ReactPointerEvent, d: Drag) {
    e.stopPropagation()
    capture(e.pointerId)
    drag.current = d
  }

  function onBackgroundDown(e: ReactPointerEvent) {
    if (tool !== 'area' || e.button > 0) return
    capture(e.pointerId)
    // лассо: зажали и ведём — линия рисуется за пальцем или мышкой
    if (lasso && !draftId) {
      lassoRef.current = [toImage(e)]
      setLassoPath(lassoRef.current)
      drag.current = { kind: 'lasso' }
      return
    }
    drag.current = { kind: 'tap', x: e.clientX, y: e.clientY }
  }

  function onMove(e: ReactPointerEvent) {
    const d = drag.current
    const p = toImage(e)
    if (!d) {
      if (tool === 'area' && draftId && e.pointerType === 'mouse') setHover(p)
      return
    }
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
      setLoupe(p)
    } else if (d.kind === 'marker') {
      const xs = d.orig.map((c) => c.x)
      const ys = d.orig.map((c) => c.y)
      const dx = clamp(p.x - d.start.x, -Math.min(...xs), W - Math.max(...xs))
      const dy = clamp(p.y - d.start.y, -Math.min(...ys), H - Math.max(...ys))
      onMarkerChange(d.orig.map((c) => ({ x: c.x + dx, y: c.y + dy })) as Quad)
    } else if (d.kind === 'point') {
      if (!d.moved && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return
      d.moved = true
      onMovePoint(d.areaId, d.index, p)
      setLoupe(p)
    }
  }

  function onUp(e: ReactPointerEvent) {
    const d = drag.current
    drag.current = null
    setLoupe(null)
    if (d?.kind === 'tap' && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 8) onAddPoint(toImage(e))
    if (d?.kind === 'point' && !d.moved) onPointTap(d.areaId, d.index)
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
        const snapped = img?.complete ? finish(snapToEdges(img, smoothPath(drawn, 1), W, H, 24 * k)) : null
        // если магнит запутал контур в петлю, берём линию как нарисована, только сгладив дрожание руки
        onLasso?.(snapped && !selfIntersects(snapped) ? snapped : finish(smoothPath(drawn, 1)))
      }
    }
  }

  function onCancel() {
    drag.current = null
    setLoupe(null)
    lassoRef.current = []
    setLassoPath(null)
  }

  const label ={ fontSize: 13 * k, strokeWidth: 3.5 * k }

  return (
    <div
      ref={wrapRef}
      className="relative mx-auto w-full select-none"
      style={{ aspectRatio: `${W} / ${H}`, maxWidth: `min(100%, calc(max(320px, 100svh - 260px) * ${W / H}))` }}
    >
      <img
        ref={imgRef}
        src={photo.url}
        alt={photo.name}
        draggable={false}
        className="absolute inset-0 size-full bg-lab-paper"
      />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={cn('absolute inset-0 size-full overflow-visible', tool === 'area' && 'cursor-crosshair')}
        style={{ touchAction: tool === 'area' && lasso ? 'none' : 'pan-y pinch-zoom' }}
        onPointerDown={onBackgroundDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onCancel}
        onPointerLeave={() => setHover(null)}
      >
        {photo.areas.map((area, i) => {
          const color = areaColor(i)
          const selected = area.id === selectedAreaId
          const editable = tool === 'area' && (selected || !area.closed)
          const closable = !area.closed && area.points.length >= 3
          const c = centroid(area.points)
          return (
            <g key={area.id}>
              {area.closed ? (
                <polygon
                  points={toPoints(area.points)}
                  fill={color}
                  fillOpacity={selected ? 0.32 : 0.18}
                  stroke={color}
                  strokeWidth={selected ? 3 : 2}
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                  className={tool === 'area' ? 'cursor-pointer' : undefined}
                  style={{ pointerEvents: tool === 'area' ? 'auto' : 'none' }}
                  onPointerDown={(e) => {
                    if (draftId) return
                    e.stopPropagation()
                    onSelectArea(area.id)
                  }}
                />
              ) : (
                <polyline
                  points={toPoints(area.points)}
                  fill="none"
                  stroke={color}
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
              {area.id === draftId && hover && area.points.length > 0 && (
                <line
                  x1={area.points[area.points.length - 1].x}
                  y1={area.points[area.points.length - 1].y}
                  x2={hover.x}
                  y2={hover.y}
                  stroke={color}
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
              {editable &&
                area.points.map((p, j) => (
                  <g key={j}>
                    {/* пока контур рисуется, нажимается только первая точка — чтобы замкнуть его */}
                    {(area.closed || (j === 0 && closable)) && (
                      <circle
                        cx={p.x}
                        cy={p.y}
                        r={hitR}
                        fill="transparent"
                        className={area.closed ? 'cursor-move' : 'cursor-pointer'}
                        style={{ touchAction: 'none' }}
                        onPointerDown={(e) =>
                          begin(e, { kind: 'point', areaId: area.id, index: j, moved: false, x: e.clientX, y: e.clientY })
                        }
                      />
                    )}
                    <circle
                      cx={p.x}
                      cy={p.y}
                      r={j === 0 && closable ? handleR * 1.45 : handleR}
                      fill={j === 0 && !area.closed ? color : '#fff'}
                      stroke={color}
                      strokeWidth={2}
                      vectorEffect="non-scaling-stroke"
                      pointerEvents="none"
                    />
                  </g>
                ))}
              {area.closed && marker && (
                <text
                  x={c.x}
                  y={c.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill="#fff"
                  stroke="rgba(0,0,0,0.7)"
                  paintOrder="stroke"
                  fontWeight={600}
                  pointerEvents="none"
                  {...label}
                >
                  {fmt(areaOf(photo, area)!.mm2, 1)} мм²
                </text>
              )}
            </g>
          )
        })}

        {marker && (
          <g>
            <polygon
              points={toPoints(marker)}
              fill={MARKER_COLOR}
              fillOpacity={tool === 'marker' ? 0.15 : 0}
              stroke={MARKER_COLOR}
              strokeWidth={tool === 'marker' ? 2.5 : 2}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              className="cursor-move"
              style={{ pointerEvents: tool === 'marker' ? 'auto' : 'none', touchAction: 'none' }}
              onPointerDown={(e) => begin(e, { kind: 'marker', start: toImage(e), orig: marker })}
            />
            <text
              x={(marker[0].x + marker[1].x) / 2}
              y={Math.min(marker[0].y, marker[1].y) - 12 * k}
              textAnchor="middle"
              fill={MARKER_COLOR}
              stroke="#fff"
              paintOrder="stroke"
              fontWeight={600}
              pointerEvents="none"
              {...label}
            >
              1 см
            </text>
            {tool === 'marker' &&
              marker.map((p, i) => (
                <g key={i}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={hitR}
                    fill="transparent"
                    className="cursor-grab"
                    style={{ touchAction: 'none' }}
                    onPointerDown={(e) => {
                      begin(e, { kind: 'corner', index: i })
                      setLoupe(p)
                    }}
                  />
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={handleR}
                    fill="#fff"
                    stroke={MARKER_COLOR}
                    strokeWidth={2.5}
                    vectorEffect="non-scaling-stroke"
                    pointerEvents="none"
                  />
                </g>
              ))}
          </g>
        )}
        {lassoPath && lassoPath.length > 1 && (
          <polyline
            points={toPoints(lassoPath)}
            fill={areaColor(photo.areas.length)}
            fillOpacity={0.12}
            stroke={areaColor(photo.areas.length)}
            strokeWidth={2}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
            pointerEvents="none"
          />
        )}
      </svg>

      {loupe && renderedW > 0 && (
        <Loupe url={photo.url} point={loupe} k={k} width={renderedW} height={(renderedW * H) / W} />
      )}
    </div>
  )
}

// Лупа с перекрестием над пальцем: видно, куда точно встаёт уголок
function Loupe({ url, point, k, width, height }: { url: string; point: Pt; k: number; width: number; height: number }) {
  const zoom = 3
  const size = 120
  const px = point.x / k
  const py = point.y / k
  const above = py > size + 28
  return (
    <div
      className="pointer-events-none absolute z-10 overflow-hidden rounded-full border-2 border-lab-blue bg-white shadow-[0_0_24px_rgba(81,112,255,.5)]"
      style={{
        width: size,
        height: size,
        left: clamp(px - size / 2, -size / 3, width - (size * 2) / 3),
        top: above ? py - size - 28 : py + 28,
        backgroundImage: `url("${url}")`,
        backgroundRepeat: 'no-repeat',
        backgroundSize: `${width * zoom}px ${height * zoom}px`,
        backgroundPosition: `${size / 2 - px * zoom}px ${size / 2 - py * zoom}px`,
      }}
    >
      <div className="absolute top-1/2 left-0 h-px w-full bg-lab-red" />
      <div className="absolute top-0 left-1/2 h-full w-px bg-lab-red" />
    </div>
  )
}
