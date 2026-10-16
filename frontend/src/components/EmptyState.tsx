import type { ReactNode } from 'react'
import { FolderOpen, Images, Plus } from 'lucide-react'
import Workspace, { AreaIcon, HudFrame, MarkerIcon, RailButton } from '@/components/Workspace'

type Props = { strip: ReactNode; onPick: () => void; onPickFolder: () => void; onDemo: () => void; loadingDemo: boolean }

const STEPS = [
  { n: '-01.', title: 'Загрузите фото', text: 'Рядом с образцом — квадрат 1×1 см в той же плоскости. Снимайте сверху.' },
  { n: '-02.', title: 'Проверьте эталон', text: 'Сайт сам найдёт квадрат. Если рамка легла неточно — подвиньте уголки.' },
  { n: '-03.', title: 'Измерьте и сравните', text: 'Обведите область — площадь в мм². «Масштаб» покажет фото в одном масштабе.' },
]

export default function EmptyState({ strip, onPick, onPickFolder, onDemo, loadingDemo }: Props) {
  return (
    <Workspace
      rail={
        <>
          <RailButton label="ЭТАЛОН" icon={<MarkerIcon />} onClick={() => {}} disabled />
          <RailButton label="ОБЛАСТЬ" icon={<AreaIcon />} onClick={() => {}} disabled />
        </>
      }
      panel={strip}
    >
      <div className="flex justify-between gap-3 font-mono text-[13px] text-lab-text/70">
        <span>НЕТ ФОТО</span>
        <span>0 / 0</span>
      </div>

      <HudFrame>
        <button
          type="button"
          onClick={onPick}
          className="group flex min-h-[46svh] w-full flex-col items-center justify-center gap-4 border border-dashed border-lab-sky/35 bg-white/[0.02] p-6 text-center outline-none transition-colors hover:border-lab-sky/70 hover:bg-lab-blue/[0.06] focus-visible:ring-2 focus-visible:ring-lab-blue"
        >
          <span className="flex size-16 items-center justify-center border-2 border-lab-blue transition-transform group-hover:scale-105">
            <Plus className="size-7 text-lab-red" />
          </span>
          <span className="font-display text-xl font-medium tracking-[.12em] sm:text-2xl">ВЫБРАТЬ ФОТО</span>
          <span className="max-w-sm text-sm text-lab-text/60">Или перетащите сюда, можно сразу несколько.</span>
        </button>
      </HudFrame>

      <div className="flex flex-wrap gap-2 font-mono text-[13px] tracking-[.06em]">
        <button
          type="button"
          onClick={onDemo}
          disabled={loadingDemo}
          className="flex h-[38px] items-center gap-2 border border-lab-red bg-lab-red/15 px-4 transition-colors hover:bg-lab-red/30 disabled:opacity-50"
        >
          <Images className="size-4" />
          ПОПРОБОВАТЬ НА ПРИМЕРАХ
        </button>
        <button
          type="button"
          onClick={onPickFolder}
          className="flex h-[38px] items-center gap-2 border border-lab-sky/40 px-4 transition-colors hover:bg-lab-blue/15"
        >
          <FolderOpen className="size-4" />
          ВЫБРАТЬ ПАПКУ
        </button>
      </div>

      <p className="text-[13px] leading-normal text-lab-text/60">
        Фото уходят на наш сервер: он сам находит квадрат-эталон 1×1 см и считает площадь с оценкой погрешности.
      </p>

      <ol className="grid gap-px border border-lab-sky/20 bg-lab-sky/20 sm:grid-cols-3">
        {STEPS.map(({ n, title, text }) => (
          <li key={n} className="flex flex-col gap-1.5 bg-lab-bg p-4">
            <span className="font-mono text-2xl font-semibold text-lab-red">{n}</span>
            <span className="font-semibold">{title}</span>
            <span className="text-sm text-lab-text/60">{text}</span>
          </li>
        ))}
      </ol>
    </Workspace>
  )
}
