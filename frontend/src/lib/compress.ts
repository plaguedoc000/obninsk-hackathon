// Сжатие фото перед отправкой: на сервер уходит JPEG не больше 1 МБ (ONESCALE_MAX_UPLOAD_MB на бэкенде).
// EXIF переносится в сжатую копию: по фокусному расстоянию сервер исправляет наклон камеры

import { loadImage } from './photos'

const LIMIT = 1_000_000 // с запасом до 1 МиБ, которые пропускает сервер
const START_SIDE = 4096 // больше 1 МБ всё равно не влезет; заодно холст не больше 16 Мп — предел Safari на iPhone
const QUALITY = 0.85

// Сегмент APP1 с EXIF из JPEG — с поворотом «как есть» (1): картинку браузер уже повернул сам
function exifSegment(bytes: Uint8Array): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null
  let pos = 2
  while (pos + 4 <= view.byteLength && bytes[pos] === 0xff) {
    const marker = bytes[pos + 1]
    if (marker === 0xda || marker === 0xd9) break
    const len = view.getUint16(pos + 2)
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(pos + 4, pos + 10)) === 'Exif\0\0') {
      const seg = bytes.slice(pos, pos + 2 + len)
      try {
        const v = new DataView(seg.buffer)
        const tiff = 10
        const le = v.getUint16(tiff) === 0x4949
        const ifd = tiff + v.getUint32(tiff + 4, le)
        const n = v.getUint16(ifd, le)
        for (let i = 0; i < n; i++) {
          const e = ifd + 2 + i * 12
          if (v.getUint16(e, le) === 0x0112) v.setUint16(e + 8, 1, le)
        }
      } catch {
        return null // EXIF битый — лучше без него, чем с неверным поворотом
      }
      return seg
    }
    pos += 2 + len
  }
  return null
}

// EXIF вставляем сразу после SOI и JFIF-заголовка
function withExif(jpeg: Uint8Array, exif: Uint8Array): Uint8Array<ArrayBuffer> {
  let at = 2
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] << 8) | jpeg[5])
  const out = new Uint8Array(jpeg.length + exif.length)
  out.set(jpeg.subarray(0, at))
  out.set(exif, at)
  out.set(jpeg.subarray(at), at + exif.length)
  return out
}

function toJpeg(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Не удалось сжать фото'))), 'image/jpeg', QUALITY),
  )
}

// Фото до 1 МБ уходит как есть. Крупнее — уменьшаем, пока JPEG не влезет в 1 МБ
export async function compressForUpload(file: File): Promise<File> {
  if (file.size <= LIMIT) return file
  const url = URL.createObjectURL(file)
  let img: HTMLImageElement
  try {
    img = await loadImage(url)
  } catch {
    throw new Error('браузер не смог открыть фото, чтобы сжать его до 1 МБ. Сохраните его как JPG')
  } finally {
    URL.revokeObjectURL(url)
  }
  const exif = exifSegment(new Uint8Array(await file.arrayBuffer()))
  const budget = LIMIT - (exif?.length ?? 0)
  const w0 = img.naturalWidth
  const h0 = img.naturalHeight
  let k = Math.min(1, START_SIDE / Math.max(w0, h0))
  const canvas = document.createElement('canvas')
  for (let i = 0; i < 8; i++) {
    canvas.width = Math.max(1, Math.round(w0 * k))
    canvas.height = Math.max(1, Math.round(h0 * k))
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff' // прозрачный PNG — на белом, как на сервере
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const blob = await toJpeg(canvas)
    if (blob.size <= budget) {
      const jpeg = new Uint8Array(await blob.arrayBuffer())
      const name = file.name.replace(/\.[^.]*$/, '') + '.jpg'
      return new File([exif ? withExif(jpeg, exif) : jpeg], name, { type: 'image/jpeg', lastModified: file.lastModified })
    }
    // размер JPEG примерно пропорционален числу пикселей
    k *= Math.sqrt(budget / blob.size) * 0.95
  }
  throw new Error('не удалось сжать фото до 1 МБ')
}
