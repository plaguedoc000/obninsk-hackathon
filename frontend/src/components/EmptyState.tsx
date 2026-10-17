import { useId, type ReactNode } from 'react'
import Workspace, { AreaRow, Scan, StageFrame, StageTitle, ToolRail } from '@/components/Workspace'
import type { Photo } from '@/lib/types'
import { cn } from '@/lib/utils'

type Props = { onPick: () => void }

// Название кнопки сайта внутри текста — плашкой, как сама кнопка
function Key({ red, children }: { red?: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        'border px-[5px] font-mono text-[.82em] tracking-[.06em] whitespace-nowrap text-white',
        red ? 'border-lab-red/60 bg-lab-red/18' : 'border-lab-sky/50 bg-lab-blue/18',
      )}
    >
      {children}
    </span>
  )
}

const STEPS: { picture: Picture; title: string; text: ReactNode }[] = [
  {
    picture: 'shoot',
    title: 'Снимите с эталоном',
    text: (
      <>
        Положите рядом с образцом квадрат 1×1 см, заметный на фоне: например, чёрный на светлом листе. Вместо него можно
        положить линейку, тогда отметьте её кнопкой <Key>ОТРЕЗОК</Key>. Сфотографируйте их вместе.
      </>
    ),
  },
  {
    picture: 'outline',
    title: 'Обведите образец',
    text: (
      <>
        Эталон программа найдёт сама и посчитает, сколько миллиметров в одном пикселе. Образец обведите щелчками по краю
        или кнопкой <Key red>АВТО</Key>: щёлкните внутри, контур найдётся сам. С зажатым <Key>SHIFT</Key> щелчки
        добавляют к обводке новые участки.
      </>
    ),
  },
  {
    picture: 'area',
    title: 'Получите площадь',
    text: (
      <>
        Площадь в мм² появится внизу. Если образцов несколько, <Key>МАСШТАБИРОВАНИЕ</Key> покажет их рядом в одном
        масштабе, а <Key>СОХРАНИТЬ</Key> выгрузит таблицу для Excel.
      </>
    ),
  },
]

const TIPS = [
  { icon: '⊥', title: 'Снимать сверху', text: 'камеру желательно держать ровно, параллельно столу' },
  { icon: '◐', title: 'Контрастный фон', text: 'образец заметно светлее или темнее того, на чём лежит' },
]

// Экран «новое фото»: как пользоваться в трёх шагах, советы для точности и выбор файла. Инструменты пока бледные
export default function EmptyState({ onPick }: Props) {
  return (
    <Workspace rail={<ToolRail disabled />}>
      <StageTitle name="новое фото" />
      <StageFrame>
        <div className="absolute inset-0 overflow-y-auto">
          <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 py-6 lg:gap-[18px] lg:px-7 lg:py-5">
            <h2 className="text-center text-xl text-white lg:text-[25px]">Площадь образца по фото</h2>

            <ol className="grid w-full max-w-[814px] gap-3.5 lg:grid-cols-3">
              {STEPS.map((step, n) => (
                <li key={step.title} className="flex flex-col gap-2.5 border border-[#3549A6] bg-[#0A0D22] p-3.5 shadow-[0_0_22px_rgba(53,73,166,.28)]">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-[26px] shrink-0 items-center justify-center bg-lab-blue text-[13px] text-white">{n + 1}</span>
                    <span className="text-[14.5px] tracking-[.06em] uppercase">{step.title}</span>
                  </div>
                  <div className="flex justify-center border border-lab-sky/20 bg-[#070918] py-1">
                    <StepPicture kind={step.picture} />
                  </div>
                  <p className="text-[13px] leading-[1.45] text-lab-text/85">{step.text}</p>
                </li>
              ))}
            </ol>

            <div className="w-full max-w-[814px] border border-lab-sky/30 bg-[#0A0D22]/70 px-3.5 py-2.5">
              <div className="mb-2 font-mono text-[10px] tracking-[.16em] text-lab-text/55 uppercase">Для большей точности рекомендуем</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {TIPS.map((tip) => (
                  <div key={tip.title} className="flex gap-2">
                    <span className="flex size-[22px] shrink-0 items-center justify-center border border-lab-blue text-xs text-[#7d93ff]" aria-hidden="true">
                      {tip.icon}
                    </span>
                    <span className="text-xs leading-[1.35]">
                      <span className="text-white">{tip.title}</span>
                      <br />
                      <span className="text-lab-text/60">{tip.text}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={onPick}
              className="flex h-[42px] shrink-0 items-center bg-lab-red px-[22px] font-mono text-xs font-semibold tracking-[.1em] text-white shadow-[0_0_24px_rgba(224,30,60,.5)] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white"
            >
              ВЫБРАТЬ ФАЙЛ
            </button>
          </div>
        </div>
      </StageFrame>
      <AreaRow value="—" />
    </Workspace>
  )
}

type Picture = 'shoot' | 'outline' | 'area'

// Контур образца на схеме; квадрат-эталон 12×12 — это «1 см»
const BLOB = 'M78 36 C 98 26, 128 34, 132 54 C 136 74, 112 88, 94 84 C 74 80, 60 66, 64 52 C 66 44, 70 39, 78 36 Z'
const FRAME = [
  [17.5, 65.5],
  [34.5, 65.5],
  [34.5, 82.5],
  [17.5, 82.5],
]
const CLICKS = [
  [78, 36],
  [112, 32],
  [132, 54],
  [94, 84],
  [64, 52],
]

// Схема к шагу: лист с образцом и эталоном. 1 — снимок сверху, 2 — найденный эталон и обводка, 3 — клетки 1×1 см и площадь
function StepPicture({ kind }: { kind: Picture }) {
  const id = useId()
  return (
    <svg viewBox="0 -2 160 100" className="block h-[112px] w-[200px]" aria-hidden="true">
      <rect x="8" y="22" width="144" height="74" fill="#F2EEE8" />
      {kind === 'shoot' && <path d={BLOB} fill="rgba(224,30,60,.45)" />}
      {kind === 'outline' && <path d={BLOB} fill="rgba(224,30,60,.18)" stroke="#E01E3C" strokeWidth="1.6" strokeDasharray="3 2" />}
      {kind === 'area' && (
        <>
          <defs>
            <clipPath id={`${id}c`}>
              <path d={BLOB} />
            </clipPath>
            <pattern id={`${id}p`} width="12" height="12" patternUnits="userSpaceOnUse" x="20" y="68">
              <path d="M12 0 H0 V12" fill="none" stroke="#E01E3C" strokeWidth=".7" />
            </pattern>
          </defs>
          <path d={BLOB} fill="rgba(224,30,60,.22)" />
          <rect x="8" y="22" width="144" height="74" fill={`url(#${id}p)`} clipPath={`url(#${id}c)`} />
          <path d={BLOB} fill="none" stroke="#E01E3C" strokeWidth="1.6" />
        </>
      )}
      <rect x="20" y="68" width="12" height="12" fill="#141414" />
      <text x="26" y="91" fontSize="6" textAnchor="middle" fill="#7a746c">
        1 см
      </text>
      {kind === 'shoot' && (
        <g fill="none" strokeWidth="1.4">
          <rect x="66" y="1" width="28" height="15" rx="2" fill="#0A0D22" stroke="#E8ECFA" />
          <rect x="71" y="-1" width="8" height="3" fill="#E8ECFA" stroke="none" />
          <circle cx="80" cy="8.5" r="4.2" stroke="#E8ECFA" />
          <path d="M80 17 V27 M76.5 23.5 L80 27.5 L83.5 23.5" stroke="#5170FF" strokeWidth="1.6" />
        </g>
      )}
      {kind !== 'shoot' && <rect x="17.5" y="65.5" width="17" height="17" fill="none" stroke="#5170FF" strokeWidth="1.6" />}
      {kind === 'outline' && (
        <>
          {FRAME.map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r="2.2" fill="#5170FF" />
          ))}
          {CLICKS.map(([x, y]) => (
            <circle key={`${x},${y}`} cx={x} cy={y} r="2.4" fill="#E01E3C" stroke="#fff" strokeWidth="1" />
          ))}
        </>
      )}
      {kind === 'area' && (
        <>
          <rect x="92" y="4" width="62" height="15" fill="#04050f" stroke="#E01E3C" strokeWidth="1" />
          <text x="123" y="14.6" fontSize="7.5" textAnchor="middle" fill="#fff">
            S = 2 152 мм²
          </text>
        </>
      )}
    </svg>
  )
}

// Фото загружается: сервер ищет эталон, по фото бежит красная полоса
export function LoadingState({ photo }: { photo: Photo }) {
  return (
    <Workspace rail={<ToolRail disabled />}>
      <StageTitle name={photo.name} />
      <StageFrame>
        <div className="absolute inset-x-6 inset-y-[30px] flex items-center justify-center">
          <div className="relative max-h-full max-w-full shadow-[0_20px_60px_rgba(0,0,0,.6)]">
            <img src={photo.url} alt={photo.name} className="block max-h-[calc(62svh-60px)] max-w-full object-contain lg:max-h-[calc(100svh-260px)]" />
            <Scan />
          </div>
        </div>
      </StageFrame>
      <AreaRow value="—" />
    </Workspace>
  )
}
