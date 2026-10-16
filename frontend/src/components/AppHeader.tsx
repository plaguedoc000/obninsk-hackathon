import { cn } from '@/lib/utils'

type Props = {
  picking: boolean
  normalized: boolean
  onScale: () => void
  onSave: () => void
}

// Шапка: логотип и две кнопки — «Привести к масштабу» и «Сохранить» (отчёт CSV)
export default function AppHeader({ picking, normalized, onScale, onSave }: Props) {
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2.5 border-b border-lab-sky/20 px-4 py-3 lg:h-16 lg:px-7 lg:py-0">
      <div className="flex min-w-0 items-center gap-[18px]">
        <span
          className="flex size-[34px] shrink-0 items-center justify-center border-2 border-lab-blue shadow-[0_0_16px_rgba(81,112,255,.4)]"
          aria-hidden="true"
        >
          <span className="size-3 bg-lab-red" />
        </span>
        <h1 className="font-display text-[15px] font-medium tracking-[.14em] whitespace-nowrap sm:text-[17px]">ОДИН МАСШТАБ</h1>
      </div>

      <nav className="flex gap-2 font-mono text-xs font-medium tracking-[.08em]">
        <button
          type="button"
          onClick={onScale}
          aria-pressed={picking}
          title="Выберите фото и приведите их к одному масштабу по эталону (C)"
          className={cn(
            'flex h-9 items-center gap-2 border border-lab-blue px-4 shadow-[0_0_16px_rgba(81,112,255,.3)] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white',
            picking || normalized ? 'bg-lab-blue' : 'bg-lab-blue/12 hover:bg-lab-blue/25',
          )}
        >
          <span
            className="size-3 shrink-0 rounded-full border-2 border-lab-sky"
            style={{ background: 'linear-gradient(90deg,#5170FF 50%,transparent 50%)' }}
          />
          {normalized ? 'МАСШТАБ ПРИВЕДЁН ✓' : 'ПРИВЕСТИ К МАСШТАБУ'}
        </button>
        <button
          type="button"
          onClick={onSave}
          title="Сохранить отчёт в CSV для Excel"
          className="flex h-9 items-center border border-lab-sky/40 px-4 transition-colors outline-none hover:bg-lab-blue/15 focus-visible:ring-2 focus-visible:ring-lab-blue"
        >
          СОХРАНИТЬ
        </button>
      </nav>
    </header>
  )
}
