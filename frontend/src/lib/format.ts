const cache = new Map<number, Intl.NumberFormat>()

// Число по-русски: запятая в дробях, пробел между разрядами
export function fmt(value: number, digits = 1) {
  let f = cache.get(digits)
  if (!f) {
    f = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
    cache.set(digits, f)
  }
  return f.format(value)
}

export function today() {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
