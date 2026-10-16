// Фото живут только в браузере: на сервер ничего не отправляется

import { detectMarker } from './detect'
import type { Area, Photo, Pt } from './types'

let nextId = 1
export const newId = (prefix: string) => `${prefix}${nextId++}`

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|bmp|avif|heic|heif|tiff?)$/i

export const isImageFile = (file: File) => file.type.startsWith('image/') || IMAGE_EXT.test(file.name)

export function createPhoto(file: File): Photo {
  return {
    id: newId('p'),
    name: file.name,
    url: URL.createObjectURL(file),
    width: 0,
    height: 0,
    status: 'loading',
    marker: null,
    markerSource: null,
    areas: [],
  }
}

// Загружает картинку. Событие load надёжнее img.decode(): decode может ждать, пока вкладка снова станет видимой
export function loadImage(url: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('Не удалось открыть фото'))
    img.src = url
  })
}

// Открывает фото, узнаёт размер и ищет эталон
export async function analyzePhoto(url: string) {
  const img = await loadImage(url)
  const width = img.naturalWidth
  const height = img.naturalHeight
  // даём браузеру отрисовать миниатюру до тяжёлого поиска
  await new Promise((resolve) => setTimeout(resolve, 0))
  const marker = detectMarker(img, width, height)
  return { width, height, marker }
}

export const newArea = (point: Pt): Area => ({ id: newId('a'), points: [point], closed: false })

// Палитра «Лаборатории»: первая область — crimson, дальше sky blue, янтарь, бирюза, сирень, розовый
export const AREA_COLORS = ['#e01e3c', '#6495ed', '#f5a524', '#2dd4bf', '#a78bfa', '#f472b6']
// Эталон обводится синим, как --color-lab-blue в index.css
export const MARKER_COLOR = '#5170ff'

export const areaColor = (index: number) => AREA_COLORS[index % AREA_COLORS.length]
