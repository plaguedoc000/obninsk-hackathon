import { FolderOpen, Loader2, X } from 'lucide-react'
import { scaleOf } from '@/lib/measure'
import type { Photo } from '@/lib/types'
import { cn } from '@/lib/utils'

type Props = {
  photos: Photo[]
  activeId: string | null
  picking: boolean
  picked: string[]
  normIds: string[] | null
  onOpen: (id: string) => void
  onToggle: (photo: Photo) => void
  onRemove: (id: string) => void
  onAdd: () => void
  onAddFolder: () => void
  onApply: () => void
  onReset: () => void
  onCancel: () => void
}

const TW = 270
const TH = 180

// Правая панель: количество фото, «Добавить фото» и крупные миниатюры. В режиме «Привести к масштабу»
// на миниатюрах номера выбора, а после приведения фото уменьшаются до общего масштаба
export default function PhotoList({ photos, activeId, picking, picked, normIds, onOpen, onToggle, onRemove, onAdd, onAddFolder, onApply, onReset, onCancel }: Props) {
  const fit = (p: Photo) => Math.min(TW / p.width, TH / p.height)
  const normed = photos.filter((p) => normIds?.includes(p.id) && p.marker && p.width)
  // общий масштаб миниатюр: самый мелкий, при котором влезает каждое приведённое фото
  const common = normed.length >= 2 ? Math.min(...normed.map((p) => fit(p) * scaleOf(p)!.ppm)) : null

  return (
    <>
      <div className="font-mono text-[11px] font-medium tracking-[.14em] text-lab-text/55">Количество {photos.length}</div>
      <div className="h-px shrink-0 bg-lab-sky/30" />
      {/* сразу открывается системное окно: файлы — большой кнопкой, папка целиком — значком справа */}
      <div className="flex h-10 shrink-0 gap-1.5">
        <button
          type="button"
          onClick={onAdd}
          className="flex flex-1 items-center justify-center border border-dashed border-lab-sky/45 font-mono text-xs font-medium tracking-[.08em] text-lab-text/75 transition-colors outline-none hover:border-lab-sky hover:text-white focus-visible:ring-2 focus-visible:ring-lab-blue"
        >
          + ДОБАВИТЬ ФОТО
        </button>
        <button
          type="button"
          onClick={onAddFolder}
          title="Добавить все фото из папки"
          aria-label="Добавить папку с фото"
          className="flex w-10 items-center justify-center border border-dashed border-lab-sky/45 text-lab-text/75 transition-colors outline-none hover:border-lab-sky hover:text-white focus-visible:ring-2 focus-visible:ring-lab-blue"
        >
          <FolderOpen className="size-4" />
        </button>
      </div>

      <div className="grid grid-cols-[270px] justify-center gap-3.5">
        {photos.map((photo, index) => {
          const order = picked.indexOf(photo.id)
          const ok = !!photo.marker
          const scale = common && normed.includes(photo) ? common / scaleOf(photo)!.ppm : fit(photo)
          const border = picking
            ? order >= 0
              ? { outline: '2px solid #5170FF', boxShadow: '0 0 20px rgba(81,112,255,.45)' }
              : { outline: '1px solid rgba(100,149,237,.25)', boxShadow: 'none' }
            : photo.id === activeId
              ? { outline: '2px solid #E01E3C', boxShadow: '0 0 20px rgba(224,30,60,.45)' }
              : { outline: '1px solid rgba(100,149,237,.25)', boxShadow: 'none' }
          return (
            <div key={photo.id} className="group relative h-[180px] w-[270px]">
              <button
                type="button"
                onClick={() => (picking ? onToggle(photo) : onOpen(photo.id))}
                aria-pressed={picking ? order >= 0 : photo.id === activeId}
                aria-label={`${picking ? 'Отметить' : 'Открыть'} фото ${index + 1}: ${photo.name}`}
                className="relative block size-full overflow-hidden outline-offset-2 focus-visible:ring-2 focus-visible:ring-lab-blue"
                style={{ ...border, opacity: picking && !ok ? 0.45 : 1 }}
              >
                {photo.width ? (
                  <span
                    className="absolute origin-top-left transition-[transform,left,top] duration-800 ease-[cubic-bezier(.6,0,.2,1)]"
                    style={{
                      width: photo.width,
                      height: photo.height,
                      left: (TW - photo.width * scale) / 2,
                      top: (TH - photo.height * scale) / 2,
                      transform: `scale(${scale})`,
                    }}
                  >
                    <img src={photo.url} alt="" draggable={false} className="absolute inset-0 size-full bg-lab-paper" />
                    <svg viewBox={`0 0 ${photo.width} ${photo.height}`} className="absolute inset-0 size-full">
                      {photo.areas
                        .filter((a) => a.closed)
                        .map((a) => (
                          <polygon
                            key={a.id}
                            points={a.points.map((p) => `${p.x},${p.y}`).join(' ')}
                            fill="rgba(224,30,60,.15)"
                            stroke="#E01E3C"
                            strokeWidth={2}
                            strokeLinejoin="round"
                            vectorEffect="non-scaling-stroke"
                          />
                        ))}
                    </svg>
                  </span>
                ) : (
                  <img src={photo.url} alt="" draggable={false} className="absolute inset-0 size-full object-contain" />
                )}
                {photo.status === 'loading' && (
                  <span className="absolute inset-0 flex items-center justify-center bg-lab-bg/55">
                    <Loader2 className="size-5 animate-spin text-lab-text" />
                  </span>
                )}
                {picking && ok && (
                  <span
                    className="absolute top-2.5 right-2.5 flex h-[30px] min-w-[30px] items-center justify-center border-2 px-2 font-mono text-[13px] font-semibold text-white"
                    style={{
                      borderColor: order >= 0 ? '#5170FF' : 'rgba(232,236,250,.7)',
                      background: order >= 0 ? '#5170FF' : 'rgba(4,5,15,.6)',
                      boxShadow: order >= 0 ? '0 0 14px rgba(81,112,255,.7)' : 'none',
                    }}
                  >
                    {order >= 0 ? order + 1 : ''}
                  </span>
                )}
                {picking && !ok && (
                  <span className="absolute inset-x-0 bottom-0 bg-lab-bg/85 px-2 py-[5px] text-left font-mono text-[11px] font-medium text-[#FF8A9C]">
                    нет эталона — отметьте E
                  </span>
                )}
              </button>
              {!picking && (
                <button
                  type="button"
                  onClick={() => onRemove(photo.id)}
                  aria-label={`Удалить фото ${index + 1}`}
                  title="Удалить фото"
                  className={cn(
                    'absolute top-2 left-2 flex size-7 items-center justify-center border border-lab-sky/40 bg-lab-bg/80 text-lab-text/80 opacity-0 transition-opacity outline-none group-hover:opacity-100 hover:border-lab-red hover:text-white focus-visible:opacity-100',
                    photo.id === activeId && 'pointer-coarse:opacity-100',
                  )}
                >
                  <X className="size-3.5" />
                </button>
              )}
            </div>
          )
        })}

        {picking && (
          <div className="sticky bottom-0 flex flex-col gap-2.5 border border-lab-blue bg-[#0A0D22] p-3.5 shadow-[0_-10px_30px_rgba(4,5,15,.9),0_0_24px_rgba(81,112,255,.3)]">
            <div className="flex justify-between gap-2 font-mono text-xs font-medium">
              <span className="text-lab-text/75">Выберите фото для приведения</span>
              <span className="shrink-0 text-white">выбрано {picked.length}</span>
            </div>
            <button
              type="button"
              onClick={onApply}
              disabled={picked.length < 2}
              className="flex h-[46px] items-center justify-center bg-lab-blue font-mono text-xs font-semibold tracking-[.12em] text-white shadow-[0_0_22px_rgba(81,112,255,.5)] disabled:cursor-not-allowed disabled:opacity-35"
            >
              ПРИВЕСТИ К МАСШТАБУ →
            </button>
            {normIds && (
              <button
                type="button"
                onClick={onReset}
                className="flex h-[38px] items-center justify-center border border-lab-red/60 font-mono text-[11px] font-semibold tracking-[.12em] text-[#FFB3BF] hover:bg-lab-red/15"
              >
                СБРОСИТЬ МАСШТАБ
              </button>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="text-center font-mono text-[11px] font-medium tracking-[.1em] text-lab-text/60 hover:text-white"
            >
              ОТМЕНА
            </button>
          </div>
        )}
      </div>
    </>
  )
}
