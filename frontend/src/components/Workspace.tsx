import type { CSSProperties, ReactNode } from 'react'
import { cn } from '@/lib/utils'

// Каркас «Лаборатории»: слева панель инструментов, в центре фото, справа результат и список фото.
// На телефоне всё идёт столбиком, а инструменты становятся строкой над фото
export default function Workspace({ rail, panel, children }: { rail: ReactNode; panel: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[96px_minmax(0,1fr)_360px] lg:overflow-hidden">
      <nav
        aria-label="Инструменты"
        className="flex gap-2 overflow-x-auto border-b border-lab-sky/20 px-4 py-3 lg:flex-col lg:items-center lg:gap-3.5 lg:overflow-visible lg:border-r lg:border-b-0 lg:px-4 lg:py-6"
      >
        {rail}
      </nav>
      <section className="flex min-w-0 flex-col gap-4 p-4 lg:overflow-y-auto lg:p-7">{children}</section>
      <aside className="flex min-h-0 flex-col gap-[22px] border-t border-lab-sky/20 bg-lab-bg/60 p-4 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:p-7">
        {panel}
        <p className="mt-auto pt-2 font-mono text-[11px] leading-relaxed text-lab-text/40">
          Учебный прототип: не подтверждает метрологическую точность и не заменяет лабораторное ПО. Эталон должен лежать
          в одной плоскости с образцом.
        </p>
      </aside>
    </div>
  )
}

type RailButtonProps = {
  label: string
  icon: ReactNode
  onClick: () => void
  active?: boolean
  tone?: 'blue' | 'red'
  disabled?: boolean
  title?: string
}

// Квадратная кнопка 64×64 с подписью моноширинным шрифтом
export function RailButton({ label, icon, onClick, active, tone = 'blue', disabled, title }: RailButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className={cn(
        'flex size-14 shrink-0 flex-col items-center justify-center gap-[7px] border font-mono text-[10px] tracking-wide text-lab-text transition-colors outline-none focus-visible:ring-2 focus-visible:ring-lab-blue disabled:pointer-events-none disabled:opacity-35 lg:size-16 [&_svg]:size-[18px]',
        active
          ? tone === 'red'
            ? 'border-lab-red bg-lab-red/20'
            : 'border-lab-blue bg-lab-blue/20'
          : 'border-white/18 bg-white/[0.04] hover:bg-lab-blue/15',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

export function RailDivider() {
  return <span className="shrink-0 bg-lab-sky/20 max-lg:w-px max-lg:self-stretch lg:h-px lg:w-10" />
}

// Значки инструментов из дизайна: пунктирный квадрат — эталон, пунктирный круг — область
export const MarkerIcon = () => <span className="size-[18px] border-2 border-dashed border-lab-sky" />
export const AreaIcon = () => <span className="size-[18px] rounded-full border-2 border-dashed border-lab-red" />

// Рамка с HUD-уголками: слева синие, справа красные
export function HudFrame({ children, className, style }: { children: ReactNode; className?: string; style?: CSSProperties }) {
  const corner = 'pointer-events-none absolute size-7'
  return (
    <div className={cn('relative p-[18px]', className)} style={style}>
      <span className={cn(corner, 'top-0 left-0 border-t-2 border-l-2 border-lab-blue')} />
      <span className={cn(corner, 'top-0 right-0 border-t-2 border-r-2 border-lab-red')} />
      <span className={cn(corner, 'bottom-0 left-0 border-b-2 border-l-2 border-lab-blue')} />
      <span className={cn(corner, 'right-0 bottom-0 border-r-2 border-b-2 border-lab-red')} />
      {children}
    </div>
  )
}

export function PanelLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('font-mono text-xs tracking-[.14em] text-lab-text/55', className)}>{children}</div>
}

// Большая красная кнопка следующего шага
export function CtaButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-14 w-full shrink-0 items-center justify-center bg-lab-red px-4 font-mono text-sm font-semibold tracking-[.14em] text-white shadow-[0_0_32px_rgba(224,30,60,.45)] transition-[filter,opacity] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none"
    >
      {label} →
    </button>
  )
}

// Строка показателя: «Периметр ........ 18,4 мм»
export function StatRow({ label, value, first }: { label: string; value: ReactNode; first?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-3 font-mono text-sm', first && 'border-t border-lab-sky/20 pt-2.5')}>
      <span className="text-lab-text/60">{label}</span>
      <span className="text-right">{value}</span>
    </div>
  )
}

// Крупное число результата: шрифт уменьшается, если число длинное
export function BigValue({ value, unit }: { value: string; unit: string }) {
  const size = value.length <= 7 ? 'text-[56px] lg:text-[64px]' : value.length <= 9 ? 'text-[44px] lg:text-[50px]' : 'text-[34px] lg:text-[38px]'
  return (
    <div className="flex items-baseline gap-2.5">
      <span className={cn('font-mono leading-none font-semibold text-white', size)}>{value}</span>
      <span className="font-mono text-xl text-lab-red">{unit}</span>
    </div>
  )
}
