// Демо-снимки рисуются прямо в браузере: условные образцы и чёрный квадрат 1×1 см,
// «снятые» с разного расстояния. Реальные размеры образцов известны, поэтому на них удобно проверять расчёт

type Spec = {
  name: string
  ppm: number // пикселей в 1 мм на этом «снимке»
  angle: number // поворот эталона, градусы
  hue: number
  seed: number
  radiusMm: number
  shape: 'blob' | 'circle'
}

const SPECS: Spec[] = [
  { name: 'Образец A.png', ppm: 6, angle: 0, hue: 15, seed: 11, radiusMm: 30, shape: 'blob' },
  { name: 'Образец B.png', ppm: 11, angle: 18, hue: 150, seed: 23, radiusMm: 18, shape: 'blob' },
  { name: 'Образец C.png', ppm: 4.5, angle: -8, hue: 275, seed: 37, radiusMm: 40, shape: 'blob' },
  { name: 'Проверка — круг 2 см.png', ppm: 8, angle: 0, hue: 205, seed: 41, radiusMm: 10, shape: 'circle' },
]

const W = 1200
const H = 900

export async function makeDemoFiles(): Promise<File[]> {
  return Promise.all(SPECS.map(drawDemo))
}

function drawDemo(spec: Spec): Promise<File> {
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!
  const rand = mulberry32(spec.seed)

  // бумага с лёгкой фактурой
  ctx.fillStyle = '#f3f0e8'
  ctx.fillRect(0, 0, W, H)
  for (let i = 0; i < 2500; i++) {
    ctx.fillStyle = `rgba(120, 100, 80, ${0.03 + rand() * 0.04})`
    ctx.fillRect(rand() * W, rand() * H, 2, 2)
  }

  ctx.fillStyle = '#8a8478'
  ctx.font = '500 26px system-ui, sans-serif'
  ctx.fillText(spec.name.replace('.png', ''), 48, 64)

  // образец
  const cx = 720
  const cy = 430
  const r = spec.radiusMm * spec.ppm
  if (spec.shape === 'circle') {
    ctx.fillStyle = `hsl(${spec.hue} 55% 68%)`
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#8a8478'
    ctx.font = '22px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText('Ø 2 см · площадь 314,2 мм²', cx, cy + r + 40)
    ctx.textAlign = 'start'
  } else {
    ctx.fillStyle = `hsl(${spec.hue} 45% 64%)`
    blob(ctx, cx, cy, r, rand)
    ctx.fill()
    ctx.fillStyle = `hsl(${spec.hue} 40% 56%)`
    for (let i = 0; i < 4; i++) {
      const a = rand() * Math.PI * 2
      const d = rand() * r * 0.45
      blob(ctx, cx + Math.cos(a) * d, cy + Math.sin(a) * d * 0.8, r * (0.12 + rand() * 0.12), rand)
      ctx.fill()
    }
  }

  // эталон 1×1 см
  const side = 10 * spec.ppm
  const mx = 150
  const my = H - 150
  ctx.save()
  ctx.translate(mx, my)
  ctx.rotate((spec.angle * Math.PI) / 180)
  ctx.fillStyle = '#121212'
  ctx.fillRect(-side / 2, -side / 2, side, side)
  ctx.restore()
  ctx.fillStyle = '#8a8478'
  ctx.font = '20px system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText('1 см', mx, my + side / 2 + 40)

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(new File([blob], spec.name, { type: 'image/png' })) : reject()), 'image/png'),
  )
}

// Гладкое неровное пятно
function blob(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, rand: () => number) {
  const n = 12
  const ph1 = rand() * Math.PI * 2
  const ph2 = rand() * Math.PI * 2
  const pts: [number, number][] = []
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2
    const rr = r * (1 + 0.14 * Math.sin(3 * t + ph1) + 0.07 * Math.cos(5 * t + ph2))
    pts.push([cx + rr * Math.cos(t), cy + rr * 0.82 * Math.sin(t)])
  }
  const mid = (a: [number, number], b: [number, number]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
  ctx.beginPath()
  const start = mid(pts[n - 1], pts[0])
  ctx.moveTo(start[0], start[1])
  for (let i = 0; i < n; i++) {
    const m = mid(pts[i], pts[(i + 1) % n])
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1])
  }
  ctx.closePath()
}

// Предсказуемый генератор случайных чисел, чтобы примеры всегда выглядели одинаково
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
