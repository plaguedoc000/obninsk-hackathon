import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

type Props = {
  selecting: boolean
  onSave: () => void
  onScale: () => void
}

export default function AppHeader({ selecting, onSave, onScale }: Props) {
  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-3 border-b border-lab-sky/20 bg-lab-bg/70 px-4 py-3 backdrop-blur lg:h-[72px] lg:px-8 lg:py-0">
      <div className="flex min-w-0 items-center gap-[18px]">
        <span className="flex size-9 shrink-0 items-center justify-center border-2 border-lab-blue" aria-hidden="true">
          <span className="size-3.5 bg-lab-red" />
        </span>
        <h1 className="font-display text-[15px] font-medium tracking-[.14em] whitespace-nowrap sm:text-lg">ОДИН МАСШТАБ</h1>
        <p className="hidden font-mono text-[13px] text-lab-text/55 xl:block">площадь по фото · эталон 1×1 см</p>
      </div>

      <nav className="flex gap-2">
        <HeaderButton onClick={onSave} title="Сохранить отчёт в CSV для Excel">
          СОХРАНИТЬ
        </HeaderButton>
        <HeaderButton onClick={onScale} active={selecting} title="Сравнить фото в одном масштабе">
          МАСШТАБ
        </HeaderButton>
      </nav>
    </header>
  )
}

function HeaderButton({ children, onClick, active, title }: { children: ReactNode; onClick: () => void; active?: boolean; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={cn(
        'flex h-[38px] items-center border px-4 font-mono text-[13px] font-medium tracking-[.06em] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-lab-blue',
        active ? 'border-lab-red bg-lab-red/20 text-white' : 'border-lab-sky/40 hover:bg-lab-blue/15',
      )}
    >
      {children}
    </button>
  )
}
