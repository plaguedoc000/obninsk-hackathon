import { Check, Loader2, X } from 'lucide-react'
import { PanelLabel } from '@/components/Workspace'
import { fmt } from '@/lib/format'
import { areaMm2 } from '@/lib/geometry'
import type { Photo } from '@/lib/types'
import { cn } from '@/lib/utils'

type Props = {
  photos: Photo[]
  highlightIds: string[]
  selecting: boolean
  selected: Set<string>
  onOpen: (id: string) => void
  onToggle: (photo: Photo) => void
  onSelectAll: () => void
  onRemove: (id: string) => void
  onAdd: () => void
  onConfirm: () => void
  onCancel: () => void
}

// Список фото в правой панели: миниатюра, название, статус эталона и площадь
export default function PhotoList({
  photos,
  highlightIds,
  selecting,
  selected,
  onOpen,
  onToggle,
  onSelectAll,
  onRemove,
  onAdd,
  onConfirm,
  onCancel,
}: Props) {
  const ready = photos.filter((p) => p.marker)
  const allSelected = ready.length > 0 && ready.every((p) => selected.has(p.id))

  return (
    <div className="flex flex-col gap-2">
      {/* высота строки постоянная, чтобы при выборе список не сдвигался */}
      <div className="flex h-7 items-center gap-3">
        <PanelLabel>ФОТО · {photos.length}</PanelLabel>
        {selecting && (
          <button
            type="button"
            onClick={onSelectAll}
            className={cn(
              'h-7 border px-2.5 font-mono text-[11px] tracking-[.08em] transition-colors',
              allSelected ? 'border-lab-blue bg-lab-blue/25 text-white' : 'border-lab-sky/45 text-lab-text/80 hover:bg-lab-blue/15',
            )}
          >
            {allSelected ? 'СНЯТЬ ВСЕ' : 'ВЫБРАТЬ ВСЕ'}
          </button>
        )}
      </div>

      <ul className="flex flex-col gap-2">
        {photos.map((photo, index) => {
          const isSelected = selected.has(photo.id)
          const highlighted = selecting ? isSelected : highlightIds.includes(photo.id)
          const closed = photo.areas.filter((a) => a.closed)
          const total = photo.marker ? closed.reduce((s, a) => s + areaMm2(a.points, photo.marker!), 0) : 0
          const status =
            photo.status === 'loading'
              ? 'поиск эталона…'
              : photo.markerSource === 'auto'
                ? 'эталон найден'
                : photo.markerSource === 'manual'
                  ? 'эталон вручную'
                  : 'нет эталона'
          return (
            <li
              key={photo.id}
              className={cn(
                'flex items-center border transition-colors',
                highlighted ? 'border-lab-red bg-lab-red/10' : 'border-lab-sky/18 hover:bg-white/[0.03]',
                selecting && !photo.marker && 'opacity-50',
              )}
            >
              <button
                type="button"
                onClick={() => (selecting ? onToggle(photo) : onOpen(photo.id))}
                aria-pressed={selecting ? isSelected : undefined}
                aria-label={`${selecting ? 'Отметить' : 'Открыть'} фото ${index + 1}: ${photo.name}`}
                className="flex min-w-0 flex-1 items-center gap-3.5 p-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-lab-blue"
              >
                {selecting && (
                  <span
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center border',
                      isSelected ? 'border-lab-blue bg-lab-blue text-white' : 'border-lab-sky/60',
                    )}
                  >
                    {isSelected && <Check className="size-3" strokeWidth={3} />}
                  </span>
                )}
                <span className="relative h-[52px] w-[76px] shrink-0 overflow-hidden bg-lab-paper">
                  <img src={photo.url} alt="" className="size-full object-cover" draggable={false} />
                  {photo.status === 'loading' && (
                    <span className="absolute inset-0 flex items-center justify-center bg-lab-bg/60">
                      <Loader2 className="size-4 animate-spin text-lab-text" />
                    </span>
                  )}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{photo.name}</span>
                  <span className="flex items-baseline justify-between gap-2 font-mono text-[11px] whitespace-nowrap">
                    <span className={cn('min-w-0 truncate', photo.marker || photo.status === 'loading' ? 'text-lab-text/55' : 'text-lab-red')}>
                      {status}
                    </span>
                    <span className="shrink-0 text-[12px] text-lab-text/80">{total ? `${fmt(total, 1)} мм²` : '—'}</span>
                  </span>
                </span>
              </button>
              {!selecting && (
                <button
                  type="button"
                  onClick={() => onRemove(photo.id)}
                  aria-label={`Удалить фото ${index + 1}`}
                  className="mr-1.5 flex size-7 shrink-0 items-center justify-center text-lab-text/45 transition-colors hover:bg-lab-red/20 hover:text-white"
                >
                  <X className="size-3.5" />
                </button>
              )}
            </li>
          )
        })}
      </ul>

      {!selecting && (
        <button
          type="button"
          onClick={onAdd}
          className="flex h-[52px] items-center justify-center border border-dashed border-lab-sky/45 font-mono text-[13px] tracking-[.08em] text-lab-text/75 transition-colors outline-none hover:border-lab-sky hover:text-white focus-visible:ring-2 focus-visible:ring-lab-blue"
        >
          + ДОБАВИТЬ ФОТО
        </button>
      )}

      {!selecting && ready.length >= 2 && (
        <p className="font-mono text-[11px] leading-relaxed text-lab-text/45">
          Чтобы сравнить фото, нажмите «Масштаб» и отметьте нужные.
        </p>
      )}

      {selecting && (
        <div className="fixed inset-x-0 bottom-0 z-30 flex flex-wrap gap-2 border-t border-lab-sky/25 bg-lab-bg/95 p-3 backdrop-blur lg:static lg:mt-2 lg:flex-col lg:flex-nowrap lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none">
          <p className="w-full text-center font-mono text-[11px] text-lab-text/55 lg:text-left">
            Отметьте два фото или больше — они откроются в одном масштабе
          </p>
          <button
            type="button"
            onClick={onConfirm}
            className="flex h-12 flex-1 items-center justify-center bg-lab-red font-mono text-[13px] font-semibold tracking-[.12em] text-white shadow-[0_0_28px_rgba(224,30,60,.4)] lg:flex-none"
          >
            ПОДТВЕРДИТЬ ({selected.size})
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-12 items-center justify-center border border-lab-sky/40 px-5 font-mono text-[13px] tracking-[.08em] hover:bg-lab-blue/15"
          >
            ОТМЕНА
          </button>
        </div>
      )}
    </div>
  )
}
