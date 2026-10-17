import { useId } from 'react'

// Знак МераКадр: рамка видоискателя, внутри — выделенная область с четырьмя точками-углами
export function LogoMark({ className }: { className?: string }) {
  const grad = useId()
  return (
    <svg viewBox="-12 -12 504 484" className={className} aria-hidden="true">
      <defs>
        <linearGradient id={grad} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f4023d" />
          <stop offset="1" stopColor="#bc0030" />
        </linearGradient>
      </defs>
      <g fill="none" stroke="#fa0141" strokeWidth="44" strokeLinejoin="round">
        <path d="M24,150 V66 Q24,24 66,24 H160" />
        <path d="M320,24 H414 Q456,24 456,66 V150" />
        <path d="M456,310 V394 Q456,436 414,436 H320" />
        <path d="M160,436 H66 Q24,436 24,394 V310" />
      </g>
      <polygon points="116,182 363,111 382,348 122,334" fill={`url(#${grad})`} />
      <g fill="#fa0141" stroke="#ffffff" strokeWidth="12">
        <circle cx="116" cy="182" r="22" />
        <circle cx="363" cy="111" r="22" />
        <circle cx="382" cy="348" r="22" />
        <circle cx="122" cy="334" r="22" />
      </g>
    </svg>
  )
}

// Знак и название: «Мера» светлым, «Кадр» фирменным красным
export default function Logo() {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <LogoMark className="h-[34px] w-auto shrink-0" />
      {/* название — когда помещается в одну строку с кнопками шапки (с 470 px) */}
      <h1 className="hidden text-[19px] leading-none font-extrabold tracking-[-.01em] whitespace-nowrap min-[470px]:block sm:text-[21px]">
        Мера<span className="text-lab-brand">Кадр</span>
      </h1>
    </div>
  )
}
