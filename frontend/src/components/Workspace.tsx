import { useId, type CSSProperties, type ReactNode, type Ref } from 'react'
import type { Tool } from '@/lib/types'
import { useMobile } from '@/lib/useMobile'
import { cn } from '@/lib/utils'

// Каркас «Лаборатории»: слева инструменты, в центре фото, справа список фото.
// Правая панель живёт на уровне страницы, поэтому при смене фото её прокрутка не сбрасывается.
// На телефоне столбиком на весь экран: фото, под ним лента миниатюр, в самом низу инструменты
export function Shell({ panel, children }: { panel: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[88px_minmax(0,1fr)_400px] lg:overflow-hidden">
      {children}
      <aside className="order-2 flex shrink-0 flex-col gap-4 border-t border-lab-sky/20 bg-[rgb(4_5_15/.62)] px-3 py-2 lg:order-none lg:min-h-0 lg:overflow-y-auto lg:border-t-0 lg:border-l lg:px-[26px] lg:py-5">
        {panel}
      </aside>
    </div>
  )
}

// Левая колонка с инструментами и середина с фото — внутри Shell
export default function Workspace({ rail, children }: { rail: ReactNode; children: ReactNode }) {
  return (
    <>
      <nav
        aria-label="Инструменты"
        className="order-3 flex shrink-0 items-center gap-1 border-t border-lab-sky/20 px-2 pt-1.5 pb-[max(6px,env(safe-area-inset-bottom))] lg:order-none lg:flex-col lg:gap-1.5 lg:overflow-visible lg:border-t-0 lg:border-r lg:px-0 lg:py-5"
      >
        {rail}
      </nav>
      <section className="order-1 flex min-h-0 min-w-0 flex-1 flex-col gap-1.5 px-2 pt-1.5 pb-1.5 lg:order-none lg:gap-3 lg:px-3.5 lg:pt-[22px] lg:pb-[18px]">{children}</section>
    </>
  )
}

const TONES = {
  blue: { color: '#5170FF', bg: 'rgba(81,112,255,.18)', glow: '0 0 22px rgba(81,112,255,.55)' },
  red: { color: '#E01E3C', bg: 'rgba(224,30,60,.18)', glow: '0 0 22px rgba(224,30,60,.55)' },
}

// Значок инструмента — квадратик 18×18 с рамкой: пунктир, круг, клякса и т. п.
// borderWidth — например '0 2px': только боковые засечки, как у значка отрезка |—|.
// Фигуру сложнее рамки (стрелку, линейку) рисуем svg — он красится цветом кнопки
type Icon = { style: 'dashed' | 'solid'; radius: string; fill?: string; borderWidth?: string } | { svg: ReactNode }

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

// Тёмная подсказка справа от кнопки при наведении — вместо белой браузерной.
// Обёртка ловит наведение и на бледной (выключенной) кнопке
export function Tip({ id, head, hotkey, text, children }: { id?: string; head: string; hotkey?: string; text: string; children: ReactNode }) {
  return (
    <div className="group/tip relative flex shrink-0">
      {children}
      <div
        id={id}
        role="tooltip"
        className="pointer-events-none invisible absolute top-1/2 left-full z-50 ml-3 w-max max-w-[260px] -translate-y-1/2 border border-[#3549A6] bg-[#0A0D22] px-3 py-2 opacity-0 shadow-[0_8px_30px_rgba(4,5,15,.9),0_0_20px_rgba(53,73,166,.3)] transition-opacity group-hover/tip:visible group-hover/tip:opacity-100 group-hover/tip:delay-150 group-has-[:focus-visible]/tip:visible group-has-[:focus-visible]/tip:opacity-100"
      >
        <div className="mb-1 flex items-center gap-2 font-mono text-[11px] tracking-[.1em] text-white">
          {head}
          {hotkey && <span className="border border-lab-sky/50 px-1 text-[10px] text-lab-text/75">{hotkey}</span>}
        </div>
        <div className="text-[12.5px] leading-[1.4] text-lab-text/80">{text}</div>
      </div>
    </div>
  )
}

// Кнопка инструмента — квадрат 50×50, все одинаковые: значок, подпись и буква горячей клавиши в углу
export function RailButton({ label, hotkey, tone, icon, onClick, active, disabled, title }: RailButtonProps) {
  const t = TONES[tone]
  const tipId = useId()
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      aria-describedby={title ? tipId : undefined}
      className="relative flex size-[50px] shrink-0 flex-col items-center justify-center gap-1.5 border pt-1 text-lab-text outline-none focus-visible:ring-2 focus-visible:ring-lab-blue disabled:cursor-default disabled:opacity-30"
      style={{
        borderColor: active ? t.color : 'rgba(100,149,237,.25)',
        background: active ? t.bg : 'transparent',
        boxShadow: active ? t.glow : 'none',
      }}
    >
      {'svg' in icon ? (
        <span className="flex size-4 shrink-0" style={{ color: t.color }}>
          {icon.svg}
        </span>
      ) : (
        <span
          className="size-4 shrink-0 border-2"
          style={{
            borderStyle: icon.style,
            borderColor: t.color,
            borderRadius: icon.radius,
            borderWidth: icon.borderWidth,
            background: icon.fill ?? 'transparent',
          }}
        />
      )}
      <span className="font-mono text-[8.5px] font-medium">{label}</span>
      {/* значок сдвинут вниз (pt-1), чтобы «DEL» в углу его не задевал */}
      <span className="absolute top-[3px] right-[3px] font-mono text-[7.5px] leading-none font-medium text-lab-text/45">
        {hotkey}
      </span>
    </button>
  )
  return title ? (
    <Tip id={tipId} head={label} hotkey={hotkey} text={title}>
      {button}
    </Tip>
  ) : (
    button
  )
}

type ToolRailProps = {
  tool?: Tool | null
  mask?: boolean
  canUndo?: boolean
  canDelete?: boolean
  zoom?: number
  disabled?: boolean
  onTool?: (tool: Tool) => void
  onUndo?: () => void
  onDelete?: () => void
  onMask?: () => void
  onZoom?: (step: 1 | -1) => void
  // какой эталон открывает кнопка «Эталон» на телефоне: тот, что уже стоит на фото
  refTool?: 'marker' | 'segment'
}

// «Назад» — изогнутая стрелка отмены ↶
export const UNDO_ARROW = (
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" className="size-full" aria-hidden="true">
    <path d="M6.5 2.5 2.5 6.5l4 4" />
    <path d="M3 6.5h8a4.5 4.5 0 0 1 0 9H7" />
  </svg>
)

// «Линейка» — планка с делениями: средняя риска длиннее
const RULER = (
  <svg viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="2" className="size-full" aria-hidden="true">
    <rect x="1" y="5" width="16" height="8" />
    <path d="M5 6v3M9 6v4.5M13 6v3" strokeWidth="1.5" />
  </svg>
)

const CROSS = 'linear-gradient(45deg,transparent 42%,#E01E3C 42%,#E01E3C 58%,transparent 58%),linear-gradient(-45deg,transparent 42%,#E01E3C 42%,#E01E3C 58%,transparent 58%)'

// Панель инструментов слева (на телефоне — внизу, см. MobileTools). Без фото все кнопки бледные и не нажимаются
export function ToolRail(props: ToolRailProps) {
  const mobile = useMobile()
  return mobile ? <MobileTools {...props} /> : <DesktopRail {...props} />
}

function DesktopRail({ tool = null, mask, canUndo, canDelete, zoom = 1, disabled, onTool, onUndo, onDelete, onMask, onZoom }: ToolRailProps) {
  return (
    <>
      {/* Эталон — квадрат 1×1 см или отрезок известной длины. На компьютере кнопки друг под другом, на телефоне — рядом */}
      <div className={cn('flex shrink-0 flex-col items-center', disabled && 'opacity-30')}>
        <span className="pb-0.5 font-mono text-[8px] font-medium tracking-[.12em] text-lab-text/45">ЭТАЛОН</span>
        <div className="flex gap-1.5 lg:flex-col">
          <RailButton
            label="КВАДРАТ"
            hotkey="E"
            tone="blue"
            icon={{ style: 'dashed', radius: '2px' }}
            active={tool === 'marker'}
            disabled={disabled}
            onClick={() => onTool?.('marker')}
            title="Квадрат 1×1 см на фото. Подвиньте уголки синей рамки на углы квадрата. Рамки нет — щёлкните 4 угла квадрата"
          />
          <RailButton
            label="ОТРЕЗОК"
            hotkey="S"
            tone="blue"
            icon={{ style: 'solid', radius: '0', borderWidth: '0 2px', fill: 'linear-gradient(transparent 42%,#5170FF 42%,#5170FF 58%,transparent 58%)' }}
            active={tool === 'segment'}
            disabled={disabled}
            onClick={() => onTool?.('segment')}
            title="Протяните линию по предмету известной длины (например, по шкале линейки на фото) и введите её длину в мм"
          />
        </div>
      </div>
      <RailButton
        label="ОБЛАСТЬ"
        hotkey="A"
        tone="red"
        icon={{ style: 'dashed', radius: '50%' }}
        active={tool === 'area'}
        disabled={disabled}
        onClick={() => onTool?.('area')}
        title="Щёлкайте по краю объекта точка за точкой. Замкнуть — щелчок по первой точке или Enter"
      />
      <RailButton
        label="АВТО"
        hotkey="W"
        tone="red"
        icon={{ style: 'dashed', radius: '50%', fill: 'radial-gradient(circle,#E01E3C 32%,transparent 36%)' }}
        active={tool === 'auto'}
        disabled={disabled}
        onClick={() => onTool?.('auto')}
        title="Щёлкните внутри объекта — контур найдётся сам. Shift+щелчок — добавить к выбранной области"
      />
      <RailButton
        label="УДАЛИТЬ"
        hotkey="DEL"
        tone="red"
        icon={{ style: 'solid', radius: '2px', fill: CROSS }}
        disabled={disabled || !canDelete}
        onClick={onDelete}
        title="Удалить выбранную область"
      />
      <RailButton
        label="НАЗАД"
        hotkey="P"
        tone="red"
        icon={{ svg: UNDO_ARROW }}
        disabled={disabled || !canUndo}
        onClick={onUndo}
        title="Отменить последнее действие. Ещё можно Ctrl+Z"
      />
      <RailButton
        label="МАСКА"
        hotkey="M"
        tone="red"
        icon={{ style: 'solid', radius: '2px', fill: 'rgba(224,30,60,.55)' }}
        active={mask}
        disabled={disabled}
        onClick={onMask}
        title="Залить области цветом"
      />
      <RailButton
        label="ЛИНЕЙКА"
        hotkey="R"
        tone="blue"
        icon={{ svg: RULER }}
        active={tool === 'ruler'}
        disabled={disabled}
        onClick={() => onTool?.('ruler')}
        title="Протяните линию — покажет расстояние в сантиметрах"
      />
      <span className="lg:flex-1" />
      <Tip head="МАСШТАБ" text="Ctrl (⌘) + колесо мыши. При увеличении фото двигается правой кнопкой мыши">
        <div
          className={cn(
            'flex shrink-0 items-center border border-lab-sky/25 font-mono text-xs font-medium lg:w-[50px] lg:flex-col',
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
      </Tip>
    </>
  )
}

// Кнопка нижней панели на телефоне: 56 px в высоту, значок и подпись, без букв горячих клавиш
function ToolButton({ label, tone, icon, active, disabled, onClick }: Omit<RailButtonProps, 'hotkey' | 'title'>) {
  const t = TONES[tone]
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className="flex h-14 min-w-0 flex-1 touch-manipulation flex-col items-center justify-center gap-1.5 border text-lab-text outline-none [-webkit-tap-highlight-color:transparent] disabled:opacity-30"
      style={{
        borderColor: active ? t.color : 'rgba(100,149,237,.2)',
        background: active ? t.bg : 'transparent',
        boxShadow: active ? t.glow : 'none',
      }}
    >
      {'svg' in icon ? (
        <span className="flex size-5 shrink-0" style={{ color: t.color }}>
          {icon.svg}
        </span>
      ) : (
        <span
          className="size-5 border-2"
          style={{ borderStyle: icon.style, borderColor: t.color, borderRadius: icon.radius, borderWidth: icon.borderWidth, background: icon.fill ?? 'transparent' }}
        />
      )}
      <span className="font-mono text-[10px] font-medium tracking-[.04em]">{label}</span>
    </button>
  )
}

// Нижняя панель на телефоне — пять крупных кнопок под большой палец. «Эталон» открывает квадрат или отрезок
// (переключаются в строке над фото), «Назад» и «Удалить» тоже там. Масштаб — двумя пальцами
function MobileTools({ tool = null, mask, disabled, onTool, onMask, refTool = 'marker' }: ToolRailProps) {
  const reference = tool === 'marker' || tool === 'segment'
  return (
    <>
      <ToolButton
        label="ЭТАЛОН"
        tone="blue"
        icon={{ style: 'dashed', radius: '2px' }}
        active={reference}
        disabled={disabled}
        onClick={() => onTool?.(reference ? tool : refTool)}
      />
      <ToolButton
        label="АВТО"
        tone="red"
        icon={{ style: 'dashed', radius: '50%', fill: 'radial-gradient(circle,#E01E3C 32%,transparent 36%)' }}
        active={tool === 'auto'}
        disabled={disabled}
        onClick={() => onTool?.('auto')}
      />
      <ToolButton
        label="ОБЛАСТЬ"
        tone="red"
        icon={{ style: 'dashed', radius: '50%' }}
        active={tool === 'area'}
        disabled={disabled}
        onClick={() => onTool?.('area')}
      />
      <ToolButton label="ЛИНЕЙКА" tone="blue" icon={{ svg: RULER }} active={tool === 'ruler'} disabled={disabled} onClick={() => onTool?.('ruler')} />
      <ToolButton
        label="МАСКА"
        tone="red"
        icon={{ style: 'solid', radius: '2px', fill: 'rgba(224,30,60,.55)' }}
        active={mask}
        disabled={disabled}
        onClick={onMask}
      />
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
      className={cn(
        // на телефоне рамка занимает всё место между шапкой и лентой миниатюр
        'lab-stage relative min-h-0 flex-1 overflow-hidden border border-lab-sky/18 lg:h-[calc(100svh-256px)] lg:min-h-[300px] lg:flex-none',
        className,
      )}
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
    <div className="flex h-6 shrink-0 items-center gap-3.5 font-mono text-[11px] font-medium text-lab-text/70 lg:h-7 lg:text-xs">
      <span className="min-w-0 truncate text-lab-text">{name}</span>
      {normed && <span className="shrink-0 bg-lab-blue px-2 py-[3px] text-[11px] text-white">ПРИВЕДЕНО К МАСШТАБУ</span>}
    </div>
  )
}

// Строка под фото: «ПЛОЩАДЬ  S = 1551,0 мм²»
export function AreaRow({ value }: { value: string }) {
  return (
    <div className="relative hidden h-8 shrink-0 items-center font-mono font-medium text-lab-text/75 lg:flex">
      <div className="text-base tracking-[.14em] text-[#E8ECFA8C]">ПЛОЩАДЬ</div>
      <div
        className="pointer-events-none absolute top-[-3px] left-[101px] border border-lab-red bg-lab-bg px-3 py-2 text-[15px] font-semibold whitespace-nowrap text-white shadow-[0_0_20px_rgba(224,30,60,.5)]"
        aria-live="polite"
      >
        S = {value} мм²
      </div>
    </div>
  )
}
