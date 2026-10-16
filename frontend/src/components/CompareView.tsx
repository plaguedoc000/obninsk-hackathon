import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, FileArchive, ImageDown, ZoomIn, ZoomOut } from 'lucide-react'
import { toast } from 'sonner'
import Workspace, { BigValue, HudFrame, PanelLabel, RailButton, RailDivider, StatRow } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { scaleOf, totalsOf } from '@/lib/measure'
import { MARKER_COLOR, areaColor } from '@/lib/photos'
import { exportComparePng } from '@/lib/report'
import type { Photo } from '@/lib/types'

type Props = { photos: Photo[]; strip: ReactNode; onClose: () => void; onZip: () => void }

const clampZoom = (z: number) => Math.min(2.5, Math.max(0.25, Math.round(z * 100) / 100))

// Все фото в одном масштабе: 1 см на экране одинаковый, поэтому квадраты-эталоны одного размера
export default function CompareView({ photos, strip, onClose, onZip }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [boxW, setBoxW] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [exporting, setExporting] = useState(false)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(([entry]) => setBoxW(entry.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const items = photos
    .filter((p) => p.marker)
    .map((photo) => {
      const ppm = scaleOf(photo)!.ppm
      const total = totalsOf(photo).mm2
      return { photo, ppm, wmm: photo.width / ppm, total }
    })
  const refPpm = Math.max(...items.map((i) => i.ppm))
  const maxWmm = Math.max(...items.map((i) => i.wmm))
  const gap = 16
  const perRow = boxW >= 640 ? 2 : 1
  // пикселей экрана на 1 мм — общий для всех фото
  const s = boxW ? ((boxW - gap * (perRow - 1)) / perRow / maxWmm) * zoom : 0

  async function download() {
    setExporting(true)
    try {
      await exportComparePng(photos)
    } catch {
      toast.error('Не удалось собрать картинку. Попробуйте ещё раз')
    } finally {
      setExporting(false)
    }
  }

  return (
    <Workspace
      rail={
        <>
          <RailButton label="НАЗАД" icon={<ArrowLeft />} onClick={onClose} title="Вернуться к фото" />
          <RailButton label="PNG" icon={<ImageDown />} onClick={download} disabled={exporting} title="Скачать картинку сравнения" />
          <RailButton label="ZIP" icon={<FileArchive />} onClick={onZip} title="Архив с сервера: CSV и фото в общем масштабе с сеткой 1 см" />
          <RailDivider />
          <RailButton label="КРУПНЕЕ" icon={<ZoomIn />} onClick={() => setZoom((z) => clampZoom(z + 0.25))} disabled={zoom >= 2.5} />
          <RailButton label="МЕЛЬЧЕ" icon={<ZoomOut />} onClick={() => setZoom((z) => clampZoom(z - 0.25))} disabled={zoom <= 0.25} />
        </>
      }
      panel={strip}
    >
      <div className="flex justify-between gap-3 font-mono text-[13px] text-lab-text/70">
        <span>СРАВНЕНИЕ В ОДНОМ МАСШТАБЕ</span>
        <span className="shrink-0">{items.length} ФОТО</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-7 gap-y-3 border border-lab-sky/20 px-4 py-3 font-mono text-[13px]">
        <span className="flex items-center gap-2.5">
          <span className="h-1.5 border-x-2 border-lab-text bg-lab-text/80" style={{ width: Math.max(4, 10 * s) }} />1 см
        </span>
        <label className="flex min-w-0 flex-1 basis-48 items-center gap-3 text-lab-text/60">
          РАЗМЕР
          <input
            type="range"
            min={0.25}
            max={2.5}
            step={0.05}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="min-w-0 flex-1 accent-lab-red"
          />
          <span className="w-12 text-right text-lab-text">{fmt(zoom * 100, 0)} %</span>
        </label>
      </div>

      <HudFrame className="min-w-0">
        <div ref={boxRef} className="overflow-x-auto pb-1">
          <div className="flex flex-wrap items-end" style={{ gap }}>
            {s > 0 &&
              items.map(({ photo, ppm, wmm, total }) => {
                const w = wmm * s
                const factor = refPpm / ppm
                return (
                  <figure key={photo.id} className="shrink-0" style={{ width: Math.max(w, 150) }}>
                    <div
                      className="relative overflow-hidden border border-lab-sky/25 bg-lab-paper"
                      style={{ width: w, aspectRatio: `${photo.width} / ${photo.height}` }}
                    >
                      <img src={photo.url} alt={photo.name} className="absolute inset-0 size-full" draggable={false} />
                      <svg viewBox={`0 0 ${photo.width} ${photo.height}`} className="absolute inset-0 size-full">
                        {photo.areas.map(
                          (a, i) =>
                            a.closed && (
                              <polygon
                                key={a.id}
                                points={a.points.map((p) => `${p.x},${p.y}`).join(' ')}
                                fill={areaColor(i)}
                                fillOpacity={0.15}
                                stroke={areaColor(i)}
                                strokeWidth={2}
                                vectorEffect="non-scaling-stroke"
                              />
                            ),
                        )}
                        <polygon
                          points={photo.marker!.map((p) => `${p.x},${p.y}`).join(' ')}
                          fill="none"
                          stroke={MARKER_COLOR}
                          strokeWidth={2.5}
                          vectorEffect="non-scaling-stroke"
                        />
                      </svg>
                    </div>
                    <figcaption className="mt-2 space-y-0.5 font-mono text-xs">
                      <p className="truncate text-lab-text">{photo.name}</p>
                      <p className="text-lab-text/55">
                        {fmt(ppm, 2)} px/мм · {factor > 1.005 ? `×${fmt(factor, 2)}` : 'без увеличения'}
                      </p>
                      {total > 0 && <p className="text-lab-red">{fmt(total, 1)} мм²</p>}
                    </figcaption>
                  </figure>
                )
              })}
          </div>
        </div>
      </HudFrame>

      {/* под фото: общий масштаб и во сколько раз увеличено каждое фото */}
      <div className="grid gap-x-10 gap-y-4 border border-lab-sky/20 bg-lab-bg/60 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center lg:px-6">
        <div className="flex flex-col gap-2">
          <PanelLabel>ОБЩИЙ МАСШТАБ</PanelLabel>
          <BigValue value={fmt(refPpm, 2)} unit="px/мм" />
        </div>
        <div className="grid gap-x-8 gap-y-2 border-t border-lab-sky/20 pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8 md:grid-cols-2">
          {items.map(({ photo, ppm, total }) => (
            <StatRow
              key={photo.id}
              label={photo.name.replace(/\.[^.]+$/, '')}
              value={`×${fmt(refPpm / ppm, 2)}${total ? ` · ${fmt(total, 1)} мм²` : ''}`}
            />
          ))}
        </div>
      </div>
      <p className="text-[13px] leading-normal text-lab-text/60">
        Каждое фото увеличено так, чтобы 1 см был одинаковым. Синяя рамка — эталон: на всех снимках он одного размера,
        поэтому образцы можно сравнивать на глаз.
      </p>
    </Workspace>
  )
}
