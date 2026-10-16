import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { BigValue, CtaButton, PanelLabel, StatRow } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { areaOf, totalsOf, type Scale } from '@/lib/measure'
import { areaColor } from '@/lib/photos'
import type { Photo } from '@/lib/types'
import { cn } from '@/lib/utils'

type Props = {
  photo: Photo
  quality: Scale | null
  cta?: { label: string; onClick: () => void; disabled?: boolean }
  hint: string
  selectedId?: string | null
  draftId?: string | null
  onSelect?: (id: string) => void
  onDelete?: (id: string) => void
}

// Под фото: площадь крупно и показатели, кнопка следующего шага с подсказкой, предупреждения и список областей
export default function ResultPanel({ photo, quality: q, cta, hint, selectedId, draftId, onSelect, onDelete }: Props) {
  const marker = photo.marker
  const totals = totalsOf(photo)
  const measured = !!(totals.count && marker)
  const source = photo.markerSource === 'auto' ? 'найден сам' : photo.markerSource === 'manual' ? 'вручную' : 'не найден'
  // предупреждения сервера об эталоне и об областях; пока его ответа нет — быстрые проверки в браузере
  const warnings = q?.fromServer ? [...q.warnings, ...totals.warnings] : []

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-x-10 gap-y-4 border border-lab-sky/20 bg-lab-bg/60 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center lg:px-6">
        <div className="flex flex-col gap-2">
          <PanelLabel>ПЛОЩАДЬ</PanelLabel>
          <BigValue value={measured ? fmt(totals.mm2, 1) : '—'} unit="мм²" />
        </div>
        <div className="grid gap-x-8 gap-y-2 border-t border-lab-sky/20 pt-3 sm:border-t-0 sm:border-l sm:pt-0 sm:pl-8 md:grid-cols-2">
          <StatRow label="Периметр" value={measured ? `${fmt(totals.perimeterMm, 1)} мм` : '—'} />
          <StatRow label="Масштаб" value={q ? `${fmt(q.ppm, 2)} px/мм` : '—'} />
          <StatRow label="Погрешность" value={measured ? `±${fmt(totals.errorPct, 1)} %` : '—'} />
          <StatRow label="Эталон" value={<span className={cn(!marker && 'text-lab-red')}>{source}</span>} />
        </div>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-5">
        {cta && <CtaButton {...cta} className="sm:w-auto sm:min-w-[260px]" />}
        <p className="text-[13px] leading-normal text-lab-text/60">{hint}</p>
      </div>

      {!marker && photo.status === 'ready' && (
        <Note tone="red">Без эталона площадь в мм² не посчитать. Выберите «Эталон» и поставьте рамку на квадрат 1×1 см.</Note>
      )}
      {q?.fromServer ? (
        warnings.map((w) => <Note key={w.code}>{w.message}</Note>)
      ) : (
        <>
          {q?.small && <Note>Эталон мелкий: сторона всего {fmt(q.sidePx, 0)} px, поэтому точность ниже. Лучше снять ближе.</Note>}
          {q?.skewed && (
            <Note>Похоже, фото снято под наклоном. Площадь пересчитана с поправкой на перспективу, но точнее снимать сверху.</Note>
          )}
        </>
      )}

      {photo.areas.length > 0 && (
        <div className="flex flex-col gap-2">
          <PanelLabel>ОБЛАСТИ · {photo.areas.length}</PanelLabel>
          <ul className="grid gap-1.5 sm:grid-cols-2 xl:grid-cols-3">
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
                  <span className="text-lab-text/80">{area.closed && marker ? `${fmt(areaOf(photo, area)!.mm2, 1)} мм²` : '—'}</span>
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
    </div>
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
