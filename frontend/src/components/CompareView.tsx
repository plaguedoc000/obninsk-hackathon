import { useEffect, useRef, useState } from 'react'
import Workspace, { StageFrame, StageTitle, ToolRail } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { scaleOf, totalsOf } from '@/lib/measure'
import type { Photo } from '@/lib/types'
import { cn } from '@/lib/utils'

type Props = { photos: Photo[] }

const GAP = 20 // между фото по горизонтали и между строками
const CAPTION = 42 // подпись под фото: площадь и разница с первым
const MIN_W = 176 // подпись «3 830,2 мм²  +1122%» должна поместиться даже под узким фото
const MAX_UP = 2 // крупнее чем вдвое фото не растягиваем — станет мыльным
const EASE = 'duration-900 ease-[cubic-bezier(.6,0,.2,1)]'

type Size = { w: number; h: number }

// Фото идут строкой, как слова в тексте: не влезло — переносится на следующую строку.
// Ищем самый крупный масштаб, при котором все строки помещаются в окно по высоте.
// С переносом бывает, что крупнее помещается, а чуть мельче — нет, поэтому спускаемся от максимума шагами по 3%
function fitScale(sizes: Size[], cw: number, ch: number, maxK: number) {
  const fits = (k: number) => {
    let rowW = 0
    let rowH = 0
    let total = 0
    for (const s of sizes) {
      const w = Math.max(s.w * k, MIN_W)
      if (w > cw) return false
      if (rowW && rowW + GAP + w > cw) {
        total += rowH + GAP
        rowW = 0
        rowH = 0
      }
      rowW += (rowW ? GAP : 0) + w
      rowH = Math.max(rowH, s.h * k + CAPTION)
    }
    return total + rowH <= ch
  }
  let k = maxK
  while (k > 1e-4 && !fits(k)) k *= 0.97
  if (k === maxK) return k
  // окно слишком низкое (телефон): каждое фото по ширине окна, а окно прокручивается
  if (k <= 1e-4) return Math.min(maxK, ...sizes.map((s) => Math.min(cw / s.w, Math.max(ch - CAPTION, 120) / s.h)))
  // уточняем между последним неподходящим и первым подходящим масштабом
  let lo = k
  let hi = k / 0.97
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (fits(mid)) lo = mid
    else hi = mid
  }
  return lo
}

// Режим «Масштабирование»: выбранные фото рядом. «Один масштаб» — у всех одинаково мм на пиксель экрана,
// поэтому образцы можно сравнивать на глаз; «Как снято» — каждое фото в своём масштабе
export default function CompareView({ photos }: Props) {
  const [norm, setNorm] = useState(true)
  const boxRef = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ w: 0, h: 0 })

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    // первый размер сразу, не дожидаясь наблюдателя — чтобы фото не появлялись из нулевого размера
    setBox({ w: el.clientWidth, h: el.clientHeight })
    const ro = new ResizeObserver(([entry]) => setBox({ w: entry.contentRect.width, h: entry.contentRect.height }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const items = photos.map((p) => ({ p, ppm: scaleOf(p)!.ppm }))
  const cw = box.w - 32
  const ch = box.h - 32
  // в «Одном масштабе» размеры в мм и k — пикселей экрана на 1 мм; «Как снято» — в пикселях фото
  const sizes = items.map(({ p, ppm }) => (norm ? { w: p.width / ppm, h: p.height / ppm } : { w: p.width, h: p.height }))
  const maxK = norm ? MAX_UP * Math.min(...items.map((i) => i.ppm)) : MAX_UP
  const k = items.length && cw > 0 && ch > 0 ? fitScale(sizes, cw, ch, maxK) : 0
  const cm = 10 * k
  // клетка сетки — 1 см; если она слишком мелкая, то 5 см
  const cell = norm && k ? (cm >= 12 ? cm : cm * 5) : 24

  // площадь каждого фото и разница с первым («база»)
  const areas = items.map(({ p }) => {
    const totals = totalsOf(p)
    return totals.count ? totals.mm2 : null
  })
  const base = areas[0]
  const cards = items.map(({ p, ppm }, n) => {
    const s = norm ? k / ppm : k
    const area = areas[n]
    let delta = n === 0 ? 'база' : '—'
    let deltaColor = 'rgba(232,236,250,.6)'
    if (n > 0 && area !== null && base) {
      const v = ((area - base) / base) * 100
      delta = `${v < 0 ? '−' : '+'}${Math.abs(v).toFixed(0)}%`
      deltaColor = v < 0 ? '#6495ED' : '#E01E3C'
    }
    return { p, s, w: p.width * s, h: p.height * s, px: Math.round(10 * ppm * s), area, delta, deltaColor, n }
  })

  return (
    <Workspace rail={<ToolRail disabled />}>
      <StageTitle name={`Масштабирование · выбрано ${photos.length}`} />
      {/* окно сравнения занимает всё место до низа экрана */}
      <StageFrame className="h-[80svh] lg:h-auto lg:min-h-0 lg:flex-1">
        <div className="absolute inset-0 z-[1] flex flex-col gap-3.5 bg-[#070918] px-[22px] py-[18px]">
          <div className="flex h-9 shrink-0 items-center font-display text-[15px] font-medium tracking-[.12em]">СРАВНЕНИЕ ПО МАСШТАБУ</div>

          <div
            ref={boxRef}
            className="relative min-h-0 flex-1 overflow-auto border border-lab-sky/20"
            style={{
              backgroundImage:
                'linear-gradient(rgba(100,149,237,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(100,149,237,.12) 1px,transparent 1px)',
              backgroundSize: `${cell}px ${cell}px`,
            }}
          >
            {cards.length ? (
              <div className="flex min-h-full flex-wrap content-center items-end justify-center gap-5 p-4">
                {cards.map((c) => (
                  <div key={c.p.id} className="flex flex-col items-center gap-2.5" style={{ width: Math.max(c.w, MIN_W) }}>
                    <div
                      className={cn('relative overflow-hidden shadow-[0_12px_40px_rgba(0,0,0,.6)] outline outline-lab-sky/40 transition-[width,height]', EASE)}
                      style={{ width: c.w, height: c.h }}
                    >
                      <div
                        className={cn('absolute top-0 left-0 origin-top-left transition-transform', EASE)}
                        style={{ width: c.p.width, height: c.p.height, transform: `scale(${c.s})` }}
                      >
                        <img src={c.p.url} alt={c.p.name} draggable={false} className="absolute inset-0 size-full bg-lab-paper" />
                        <svg viewBox={`0 0 ${c.p.width} ${c.p.height}`} className="absolute inset-0 size-full">
                          {c.p.areas
                            .filter((a) => a.closed)
                            .map((a) => (
                              <polygon
                                key={a.id}
                                points={a.points.map((q) => `${q.x},${q.y}`).join(' ')}
                                fill="rgba(224,30,60,.22)"
                                stroke="#E01E3C"
                                strokeWidth={2}
                                strokeLinejoin="round"
                                vectorEffect="non-scaling-stroke"
                              />
                            ))}
                          {c.p.segment ? (
                            <line
                              x1={c.p.segment.a.x}
                              y1={c.p.segment.a.y}
                              x2={c.p.segment.b.x}
                              y2={c.p.segment.b.y}
                              stroke="#5170FF"
                              strokeWidth={2}
                              vectorEffect="non-scaling-stroke"
                            />
                          ) : (
                            c.p.marker && (
                              <polygon
                                points={c.p.marker.map((q) => `${q.x},${q.y}`).join(' ')}
                                fill="none"
                                stroke="#5170FF"
                                strokeWidth={2}
                                vectorEffect="non-scaling-stroke"
                              />
                            )
                          )}
                        </svg>
                      </div>
                      {/* в «Одном масштабе» у всех одинаково — это написано внизу, на фото не дублируем */}
                      {!norm && (
                        <span className="absolute top-2 left-2 bg-lab-blue px-2 py-[3px] font-mono text-[11px] font-semibold whitespace-nowrap text-white">
                          1 см = {c.px} px
                        </span>
                      )}
                      <span className="absolute top-2 right-2 flex h-[22px] min-w-[22px] items-center justify-center border-2 border-lab-blue bg-lab-blue px-1 font-mono text-[11px] font-semibold text-white">
                        {c.n + 1}
                      </span>
                    </div>
                    <div className="flex w-full items-baseline justify-between gap-2 bg-lab-bg/85 px-2 py-1.5 font-mono text-[13px] font-medium whitespace-nowrap">
                      <span className="truncate text-base text-white">{c.area !== null ? `${fmt(c.area, 1)} мм²` : 'нет контура'}</span>
                      <span style={{ color: c.deltaColor }}>{c.delta}</span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-center text-[15px] leading-normal text-lab-text/62">
                Отметьте фото справа — они появятся здесь в одном масштабе. Для сравнения нужно два фото или больше.
              </div>
            )}
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-x-[22px] gap-y-2">
            <div className="flex border border-lab-sky/45 font-mono text-[11px] font-semibold tracking-[.1em]">
              <button
                type="button"
                onClick={() => setNorm(false)}
                aria-pressed={!norm}
                className={cn('flex h-9 items-center px-3.5', norm ? 'text-lab-text/70 hover:text-white' : 'bg-lab-blue text-white')}
              >
                КАК СНЯТО
              </button>
              <button
                type="button"
                onClick={() => setNorm(true)}
                aria-pressed={norm}
                className={cn('flex h-9 items-center px-3.5', norm ? 'bg-lab-blue text-white' : 'text-lab-text/70 hover:text-white')}
              >
                ОДИН МАСШТАБ
              </button>
            </div>
            {/* пока ничего не выбрано, подписи масштаба нет — нечего мерить */}
            {cards.length > 0 && (
              <div className="flex items-center gap-3 font-mono text-xs font-medium text-lab-text/75">
                {norm && k > 0 && <div className={cn('h-2 shrink-0 border-2 border-t-0 border-lab-sky transition-[width]', EASE)} style={{ width: cm }} />}
                {norm
                  ? `1 см = ${Math.round(cm)} px · все снимки приведены к одному масштабу по эталону`
                  : 'Снимки как сняты — эталон на каждом разного размера'}
              </div>
            )}
          </div>
        </div>
      </StageFrame>
    </Workspace>
  )
}
