import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { BigValue, CtaButton, PanelLabel, StatRow } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { areaMm2, perimeterMm, type MarkerQuality } from '@/lib/geometry'
import { areaColor } from '@/lib/photos'
import type { Photo } from '@/lib/types'
import { cn } from '@/lib/utils'

type Props = {
  photo: Photo | null
  quality: MarkerQuality | null
  cta: { label: string; onClick: () => void; disabled?: boolean }
  hint: string
  selectedId?: string | null
  draftId?: string | null
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
}

// Верх правой панели: результат крупно, показатели, кнопка следующего шага, подсказка, области
export default function ResultPanel({ photo, quality: q, cta, hint, selectedId, draftId, onSelect, onDelete }: Props) {
  const marker = photo?.marker ?? null
  const closed = photo?.areas.filter((a) => a.closed) ?? []
  const total = marker ? closed.reduce((s, a) => s + areaMm2(a.points, marker), 0) : 0
  const perimeter = marker ? closed.reduce((s, a) => s + perimeterMm(a.points, marker), 0) : 0
  const source = photo?.markerSource === 'auto' ? 'найден сам' : photo?.markerSource === 'manual' ? 'вручную' : 'не найден'

  return (
    <>
      <div className="flex flex-col gap-2.5">
        <PanelLabel>РЕЗУЛЬТАТ</PanelLabel>
        <BigValue value={closed.length && marker ? fmt(total, 1) : '—'} unit="мм²" />
        <StatRow first label="Периметр" value={closed.length && marker ? `${fmt(perimeter, 1)} мм` : '—'} />
        <StatRow label="Масштаб" value={q ? `${fmt(q.ppm, 2)} px/мм` : '—'} />
        <StatRow label="Погрешность" value={q && closed.length ? `±${fmt(q.areaErrorPct, 1)} %` : '—'} />
        <StatRow
          label="Эталон"
          value={<span className={cn(!marker && photo && 'text-lab-red')}>{photo ? source : '—'}</span>}
        />
      </div>

      <CtaButton {...cta} />
      <p className="text-[13px] leading-normal text-lab-text/60">{hint}</p>

      {photo && !marker && photo.status === 'ready' && (
        <Note tone="red">Без эталона площадь в мм² не посчитать. Выберите «Эталон» и поставьте рамку на квадрат 1×1 см.</Note>
      )}
      {q?.small && <Note>Эталон мелкий: сторона всего {fmt(q.sidePx, 0)} px, поэтому точность ниже. Лучше снять ближе.</Note>}
      {q?.skewed && (
        <Note>Похоже, фото снято под наклоном. Площадь пересчитана с поправкой на перспективу, но точнее снимать сверху.</Note>
      )}

      {photo && photo.areas.length > 0 && (
        <div className="flex flex-col gap-2">
          <PanelLabel>ОБЛАСТИ · {photo.areas.length}</PanelLabel>
          <ul className="flex flex-col gap-1.5">
            {photo.areas.map((area, i) => (
              <li
                key={area.id}
                className={cn(
                  'flex items-center border transition-colors',
                  area.id === selectedId ? 'border-lab-red bg-lab-red/10' : 'border-lab-sky/18 hover:bg-white/[0.03]',
                )}
              >
                <button
                  type="button"
                  onClick={() => onSelect?.(area.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2 text-left font-mono text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-lab-blue"
                >
                  <span className="size-2.5 shrink-0" style={{ background: areaColor(i) }} />
                  <span className="flex-1">
                    ОБЛ. {i + 1}
                    {(area.id === draftId || !area.closed) && (
                      <span className="text-lab-text/50"> · рисуется, {area.points.length} т.</span>
                    )}
                  </span>
                  <span className="text-lab-text/80">
                    {area.closed && marker ? `${fmt(areaMm2(area.points, marker), 1)} мм²` : '—'}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => onDelete?.(area.id)}
                  aria-label={`Удалить область ${i + 1}`}
                  className="mr-1.5 flex size-7 shrink-0 items-center justify-center text-lab-text/45 transition-colors hover:bg-lab-red/20 hover:text-white"
                >
                  <X className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  )
}

function Note({ children, tone = 'warn' }: { children: ReactNode; tone?: 'warn' | 'red' }) {
  return (
    <p
      className={cn(
        'border-l-2 px-3 py-2 text-[13px] leading-normal text-lab-text/85',
        tone === 'red' ? 'border-lab-red bg-lab-red/10' : 'border-lab-warn bg-lab-warn/10',
      )}
    >
      {children}
    </p>
  )
}
