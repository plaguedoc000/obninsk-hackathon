import { useEffect, useRef, useState, type ReactNode } from 'react'
import AuthButton from '@/components/AuthButton'
import Logo from '@/components/Logo'
import { cn } from '@/lib/utils'

type Props = {
  picking: boolean
  normalized: boolean
  onScale: () => void
  onSaveCsv: () => void
  onSaveFiles: () => void
}

const SAVE_BUTTON =
  'flex h-10 items-center border border-lab-sky/40 px-3 whitespace-nowrap lg:h-9 lg:px-4 transition-colors outline-none hover:bg-lab-blue/15 focus-visible:ring-2 focus-visible:ring-lab-blue focus-visible:ring-inset'

// Шапка: логотип, две кнопки — «Сохранить» и «Масштабирование» — и вход через Флида ID.
// «Сохранить» раскрывается в две: «Сохранить CSV» (таблица) и «Сохранить файлы» (фото в общем масштабе)
export default function AppHeader({ picking, normalized, onScale, onSaveCsv, onSaveFiles }: Props) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  // щелчок мимо кнопок или Esc — сворачиваем обратно
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false)
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  function choose(action: () => void) {
    setOpen(false)
    action()
  }

  return (
    <header className="flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2.5 border-b border-lab-sky/20 px-3 py-2 lg:h-16 lg:gap-x-4 lg:px-7 lg:py-0">
      <Logo />

      <nav className="flex gap-2 font-mono text-xs font-medium tracking-[.08em]">
        <div ref={box} className="flex">
          <Unfold shown={!open}>
            <button type="button" onClick={() => setOpen(true)} title="Сохранить таблицу или фото" className={SAVE_BUTTON}>
              СОХРАНИТЬ
            </button>
          </Unfold>
          <Unfold shown={open} delay={40}>
            <button type="button" onClick={() => choose(onSaveCsv)} title="Таблица измерений для Excel" className={SAVE_BUTTON}>
              <span className="lg:hidden">CSV</span>
              <span className="hidden lg:inline">СОХРАНИТЬ CSV</span>
            </button>
          </Unfold>
          <Unfold shown={open} delay={110} gap>
            <button
              type="button"
              onClick={() => choose(onSaveFiles)}
              title="Фото в общем масштабе с контурами эталона и областей и подписью: имя, площадь, дата"
              className={cn(SAVE_BUTTON, 'border-lab-red/70 hover:bg-lab-red/15')}
            >
              <span className="lg:hidden">ФАЙЛЫ</span>
              <span className="hidden lg:inline">СОХРАНИТЬ ФАЙЛЫ</span>
            </button>
          </Unfold>
        </div>
        <button
          type="button"
          onClick={onScale}
          aria-pressed={picking}
          title="Масштабирование: выберите фото и приведите их к одному масштабу по эталону (C)"
          className={cn(
            'flex h-10 items-center gap-2 border border-lab-blue px-3 shadow-[0_0_16px_rgba(81,112,255,.3)] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-white lg:h-9 lg:px-4',
            picking || normalized ? 'bg-lab-blue' : 'bg-lab-blue/12 hover:bg-lab-blue/25',
          )}
        >
          <span
            className="size-3 shrink-0 rounded-full border-2 border-lab-sky"
            style={{ background: 'linear-gradient(90deg,#5170FF 50%,transparent 50%)' }}
          />
          {/* на телефоне подпись короче, чтобы шапка уместилась в одну строку */}
          <span className="lg:hidden">{normalized ? 'МАСШТАБ ✓' : 'МАСШТАБ'}</span>
          <span className="hidden lg:inline">{normalized ? 'МАСШТАБИРОВАНИЕ ✓' : 'МАСШТАБИРОВАНИЕ'}</span>
        </button>
        <AuthButton />
      </nav>
    </header>
  )
}

// Обёртка для анимации: кнопка выезжает, расширяясь от нулевой ширины, или прячется обратно
function Unfold({ shown, delay = 0, gap, children }: { shown: boolean; delay?: number; gap?: boolean; children: ReactNode }) {
  return (
    <div
      aria-hidden={!shown}
      inert={!shown}
      className="overflow-hidden transition-[max-width,opacity,margin,transform] duration-300 ease-[cubic-bezier(.6,0,.2,1)]"
      style={{
        maxWidth: shown ? 170 : 0,
        opacity: shown ? 1 : 0,
        marginLeft: gap && shown ? 8 : 0,
        transform: shown ? 'none' : 'translateX(-8px)',
        transitionDelay: shown ? `${delay}ms` : '0ms',
      }}
    >
      {children}
    </div>
  )
}
