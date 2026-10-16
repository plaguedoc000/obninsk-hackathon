import type { ReactNode } from 'react'
import Workspace, { AreaRow, Scan, StageFrame, StageTitle, ToolRail } from '@/components/Workspace'
import type { Photo } from '@/lib/types'

type Props = { panel: ReactNode; onPick: () => void; onBack?: () => void }

// Экран «новое фото»: подсказка, как снимать, и выбор файла. Инструменты пока бледные
export default function EmptyState({ panel, onPick, onBack }: Props) {
  return (
    <Workspace rail={<ToolRail disabled />} panel={panel}>
      <StageTitle name="новое фото" />
      <StageFrame>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-[26px] p-6 text-center">
          {/* перекрестие, пунктирный круг — участок и белый квадрат — эталон */}
          <div className="relative size-[180px] shrink-0" aria-hidden="true">
            <div className="absolute top-0 left-[89px] h-[180px] w-0.5 bg-lab-sky/50" />
            <div className="absolute top-[89px] left-0 h-0.5 w-[180px] bg-lab-sky/50" />
            <div className="absolute top-10 left-10 size-[100px] rounded-full border-2 border-dashed border-lab-red" />
            <div className="absolute top-[132px] left-3 size-[30px] bg-lab-text shadow-[0_0_16px_rgba(81,112,255,.6)]" />
          </div>
          <div className="flex flex-col items-center gap-2">
            <h2 className="font-display text-lg font-medium tracking-[.06em]">Положите эталон 1×1 см рядом с участком</h2>
            <p className="max-w-[460px] text-[15px] leading-normal text-lab-text/62">
              Снимайте строго сверху, при ровном свете. Эталон и участок должны быть в одной плоскости.
            </p>
          </div>
          <div className="flex flex-wrap justify-center gap-2.5 font-mono text-xs font-semibold tracking-[.1em]">
            <button
              type="button"
              onClick={onPick}
              className="flex h-11 items-center bg-lab-red px-[22px] text-white shadow-[0_0_24px_rgba(224,30,60,.5)] outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white"
            >
              ВЫБРАТЬ ФАЙЛ
            </button>
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="flex h-11 items-center border border-lab-sky/45 px-[22px] outline-none hover:bg-lab-blue/15 focus-visible:ring-2 focus-visible:ring-lab-blue"
              >
                НАЗАД К ФОТО
              </button>
            )}
          </div>
        </div>
      </StageFrame>
      <AreaRow value="—" />
    </Workspace>
  )
}

// Фото загружается: сервер ищет эталон, по фото бежит красная полоса
export function LoadingState({ photo, panel }: { photo: Photo; panel: ReactNode }) {
  return (
    <Workspace rail={<ToolRail disabled />} panel={panel}>
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
