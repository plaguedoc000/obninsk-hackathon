import type { CSSProperties, ReactNode, Ref } from 'react'
import type { Tool } from '@/lib/types'
import { cn } from '@/lib/utils'

// Каркас «Лаборатории»: слева инструменты, в центре фото, справа список фото.
// На телефоне всё идёт столбиком, а инструменты становятся строкой над фото
export default function Workspace({ rail, panel, children }: { rail: ReactNode; panel: ReactNode; children: ReactNode }) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[88px_minmax(0,1fr)_400px] lg:overflow-hidden">
      <nav
        aria-label="Инструменты"
        className="flex items-center gap-2.5 overflow-x-auto border-b border-lab-sky/20 px-4 py-3 lg:flex-col lg:overflow-visible lg:border-r lg:border-b-0 lg:px-0 lg:py-5"
      >
        {rail}
      </nav>
      <section className="flex min-w-0 flex-col gap-3 px-3.5 pt-[22px] pb-[18px] lg:min-h-0">{children}</section>
      <aside className="flex flex-col gap-4 border-t border-lab-sky/20 bg-[rgb(4_5_15/.62)] px-[26px] py-5 lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l">
        {panel}
      </aside>
    </div>
  )
}

const TONES = {
  blue: { color: '#5170FF', bg: 'rgba(81,112,255,.18)', glow: '0 0 22px rgba(81,112,255,.55)' },
  red: { color: '#E01E3C', bg: 'rgba(224,30,60,.18)', glow: '0 0 22px rgba(224,30,60,.55)' },
}

// Значок инструмента — квадратик 18×18 с рамкой: пунктир, круг, клякса и т. п.
type Icon = { style: 'dashed' | 'solid'; radius: string; fill?: string }

type RailButtonProps = {
  label: string
  hotkey: string
  tone: keyof typeof TONES
  icon: Icon
  onClick?: () => void
  active?: boolean
  disabled?: boolean
  title?: string
}

// Кнопка инструмента 60×60: значок, подпись и буква горячей клавиши в углу
export function RailButton({ label, hotkey, tone, icon, onClick, active, disabled, title }: RailButtonProps) {
  const t = TONES[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={active}
      className="relative flex size-[60px] shrink-0 flex-col items-center justify-center gap-[7px] border text-lab-text outline-none focus-visible:ring-2 focus-visible:ring-lab-blue disabled:cursor-default disabled:opacity-30"
      style={{
        borderColor: active ? t.color : 'rgba(100,149,237,.25)',
        background: active ? t.bg : 'transparent',
        boxShadow: active ? t.glow : 'none',
      }}
    >
      <span
        className="size-[18px] border-2"
        style={{ borderStyle: icon.style, borderColor: t.color, borderRadius: icon.radius, background: icon.fill ?? 'transparent' }}
      />
      <span className="font-mono text-[9px] font-medium tracking-[.04em]">{label}</span>
      <span className="absolute top-[3px] right-1 font-mono text-[9px] font-medium text-lab-text/45">{hotkey}</span>
    </button>
  )
}

type ToolRailProps = {
  tool?: Tool | null
  mask?: boolean
  canUndo?: boolean
  zoom?: number
  disabled?: boolean
  onTool?: (tool: Tool) => void
  onUndo?: () => void
  onMask?: () => void
  onZoom?: (step: 1 | -1) => void
}

// Панель инструментов слева. Без фото все кнопки бледные и не нажимаются
export function ToolRail({ tool = null, mask, canUndo, zoom = 1, disabled, onTool, onUndo, onMask, onZoom }: ToolRailProps) {
  return (
    <>
      <RailButton
        label="ЭТАЛОН"
        hotkey="E"
        tone="blue"
        icon={{ style: 'dashed', radius: '2px' }}
        active={tool === 'marker'}
        disabled={disabled}
        onClick={() => onTool?.('marker')}
        title="Эталон: подвиньте уголки синей рамки на углы квадрата 1×1 см. Нет рамки — щёлкните 4 угла квадрата"
      />
      <RailButton
        label="ОБЛАСТЬ"
        hotkey="A"
        tone="red"
        icon={{ style: 'dashed', radius: '50%' }}
        active={tool === 'area'}
        disabled={disabled}
        onClick={() => onTool?.('area')}
        title="Область: щёлкните внутри объекта — контур найдётся сам. Точки контура можно двигать"
      />
      <RailButton
        label="НАЗАД"
        hotkey="P"
        tone="red"
        icon={{ style: 'solid', radius: '50%' }}
        disabled={disabled || !canUndo}
        onClick={onUndo}
        title="Отменить последнее действие (P или Ctrl+Z)"
      />
      <span className="h-10 w-px shrink-0 bg-lab-sky/25 lg:my-1.5 lg:h-px lg:w-10" />
      <RailButton
        label="МАСКА"
        hotkey="M"
        tone="red"
        icon={{ style: 'solid', radius: '2px', fill: 'rgba(224,30,60,.55)' }}
        active={mask}
        disabled={disabled}
        onClick={onMask}
        title="Маска: залить область цветом"
      />
      <RailButton
        label="ЛАССО"
        hotkey="L"
        tone="red"
        icon={{ style: 'dashed', radius: '40% 60% 55% 45%' }}
        active={tool === 'lasso'}
        disabled={disabled}
        onClick={() => onTool?.('lasso')}
        title="Лассо: зажмите и обведите объект примерно — контур прилипнет к краю"
      />
      <RailButton
        label="ЛИНЕЙКА"
        hotkey="R"
        tone="blue"
        icon={{
          style: 'solid',
          radius: '1px',
          fill: 'linear-gradient(135deg,transparent 45%,#5170FF 45%,#5170FF 55%,transparent 55%)',
        }}
        active={tool === 'ruler'}
        disabled={disabled}
        onClick={() => onTool?.('ruler')}
        title="Линейка: протяните линию — покажет расстояние в сантиметрах"
      />
      <span className="lg:flex-1" />
      <div
        className={cn(
          'flex shrink-0 items-center border border-lab-sky/25 font-mono text-xs font-medium lg:w-[60px] lg:flex-col',
          disabled && 'pointer-events-none opacity-30',
        )}
      >
        <button
          type="button"
          onClick={() => onZoom?.(1)}
          aria-label="Крупнее"
          className="flex h-9 w-9 items-center justify-center text-lg hover:bg-lab-blue/15 lg:w-full"
        >
          +
        </button>
        <div className="flex h-9 items-center px-1 text-[11px] text-lab-text/75 lg:h-7">{Math.round(zoom * 100)}%</div>
        <button
          type="button"
          onClick={() => onZoom?.(-1)}
          aria-label="Мельче"
          className="flex h-9 w-9 items-center justify-center text-lg hover:bg-lab-blue/15 lg:w-full"
        >
          −
        </button>
      </div>
    </>
  )
}

// Рамка с фото: тёмное поле с сеткой 24 px и уголками — слева синие, справа красные
export function StageFrame({ children, className, style, ref }: { children?: ReactNode; className?: string; style?: CSSProperties; ref?: Ref<HTMLDivElement> }) {
  const corner = 'pointer-events-none absolute size-[26px]'
  // на экране 1440×900 рамка ровно 924×644, как в дизайне
  return (
    <div
      ref={ref}
      className={cn('lab-stage relative h-[min(62svh,105vw)] min-h-[300px] shrink-0 overflow-hidden border border-lab-sky/18 lg:h-[calc(100svh-256px)]', className)}
      style={style}
    >
      <span className={cn(corner, 'top-2 left-2 border-t-2 border-l-2 border-lab-blue')} />
      <span className={cn(corner, 'top-2 right-2 border-t-2 border-r-2 border-lab-red')} />
      <span className={cn(corner, 'bottom-2 left-2 border-b-2 border-l-2 border-lab-blue')} />
      <span className={cn(corner, 'right-2 bottom-2 border-r-2 border-b-2 border-lab-red')} />
      {children}
    </div>
  )
}

// Полоса «сканирования» поверх фото, пока сервер его обрабатывает
export function Scan() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden">
      <div
        className="absolute inset-x-0 h-[90px] border-b-2 border-lab-red bg-linear-to-b from-lab-red/0 to-lab-red/28 shadow-[0_8px_20px_rgba(224,30,60,.6)]"
        style={{ animation: 'om-scan 1.3s cubic-bezier(.5,0,.5,1) infinite' }}
      />
    </div>
  )
}

// Строка над фото: имя файла и отметка, что фото приведено к общему масштабу
export function StageTitle({ name, normed }: { name: string; normed?: boolean }) {
  return (
    <div className="flex h-7 shrink-0 items-center gap-3.5 font-mono text-xs font-medium text-lab-text/70">
      <span className="min-w-0 truncate text-lab-text">{name}</span>
      {normed && <span className="shrink-0 bg-lab-blue px-2 py-[3px] text-[11px] text-white">ПРИВЕДЕНО К МАСШТАБУ</span>}
    </div>
  )
}

// Строка под фото: «ПЛОЩАДЬ  S = 15,51 см²»
export function AreaRow({ value }: { value: string }) {
  return (
    <div className="relative flex h-8 shrink-0 items-center font-mono font-medium text-lab-text/75">
      <div className="text-base tracking-[.14em] text-[#E8ECFA8C]">ПЛОЩАДЬ</div>
      <div
        className="pointer-events-none absolute top-[-3px] left-[101px] border border-lab-red bg-lab-bg px-3 py-2 text-[15px] font-semibold whitespace-nowrap text-white shadow-[0_0_20px_rgba(224,30,60,.5)]"
        aria-live="polite"
      >
        S = {value} см²
      </div>
    </div>
  )
}
