"""Чтение фото: поворот по EXIF, разные форматы, 16-битные TIFF."""
from __future__ import annotations

import io
import struct

import cv2
import numpy as np
from PIL import Image, ImageOps

from . import config
from .errors import AppError

Image.MAX_IMAGE_PIXELS = config.MAX_IMAGE_PIXELS

try:  # фото с iPhone (HEIC) — если установлен pillow-heif
    from pillow_heif import register_heif_opener

    register_heif_opener()
    HEIC_SUPPORTED = True
except Exception:  # pragma: no cover
    HEIC_SUPPORTED = False


def _to_uint8_rgb(im: Image.Image) -> np.ndarray:
    if im.mode in ("I;16", "I;16B", "I;16L", "I", "F"):
        arr = np.asarray(im, dtype=np.float64)
        lo, hi = np.percentile(arr, 0.1), np.percentile(arr, 99.9)
        if hi <= lo:
            hi = lo + 1
        arr = np.clip((arr - lo) / (hi - lo) * 255.0, 0, 255).astype(np.uint8)
        return np.stack([arr] * 3, axis=-1)
    if im.mode in ("RGBA", "LA", "P", "PA"):
        im = im.convert("RGBA")
        bg = Image.new("RGBA", im.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, im)
    return np.asarray(im.convert("RGB"))


def decode_upload(data: bytes) -> tuple[np.ndarray, dict]:
    """bytes -> (BGR uint8 с учётом EXIF-поворота, сведения)."""
    try:
        im = Image.open(io.BytesIO(data))
        # размер известен до распаковки: маленький PNG может развернуться в сотни мегабайт
        if im.width * im.height > config.MAX_IMAGE_PIXELS:
            raise Image.DecompressionBombError
        fmt = (im.format or "").upper()
        exif_orientation = None
        focal35 = None
        try:
            exif = im.getexif()
            exif_orientation = exif.get(0x0112)
            # фокусное в пересчёте на 35 мм: по нему оцениваем, насколько опасен наклон камеры
            f = exif.get_ifd(0x8769).get(0xA405)
            focal35 = float(f) if f and 5 <= float(f) <= 2000 else None
        except Exception:
            pass
        im = ImageOps.exif_transpose(im)
        rgb = _to_uint8_rgb(im)
    except Image.DecompressionBombError:
        raise AppError("IMAGE_TOO_LARGE", "Слишком большое изображение", 413)
    except Exception:
        raise AppError("BAD_IMAGE", "Не удалось прочитать изображение. Поддерживаются JPG, PNG, TIFF, BMP, WEBP"
                       + (", HEIC" if HEIC_SUPPORTED else ""), 415)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    info = {
        "format": fmt,
        "exif_orientation": exif_orientation,
        "focal35_mm": focal35,
        "rotated_by_exif": bool(exif_orientation and exif_orientation != 1),
    }
    return bgr, info


# байт на одно значение для типов полей TIFF/EXIF
_TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8}
_XMP = b"http://ns.adobe.com/xap/1.0/\x00"


def _wipe_gps(tiff: bytearray) -> bool:
    """Затирает нулями GPS-блок EXIF (TIFF-структура) на месте. True — координаты были."""
    try:
        e = {b"II": "<", b"MM": ">"}[bytes(tiff[:2])]
        u16 = lambda o: struct.unpack_from(e + "H", tiff, o)[0]  # noqa: E731
        u32 = lambda o: struct.unpack_from(e + "I", tiff, o)[0]  # noqa: E731
        ifd = u32(4)
        for i in range(u16(ifd)):
            entry = ifd + 2 + 12 * i
            if u16(entry) != 0x8825:
                continue
            gps = u32(entry + 8)
            n = u16(gps)
            for j in range(n):
                g = gps + 2 + 12 * j
                size = _TYPE_SIZE.get(u16(g + 2), 1) * u32(g + 4)
                if size > 4 and u32(g + 8) + size <= len(tiff):
                    tiff[u32(g + 8):u32(g + 8) + size] = bytes(size)
                tiff[g:g + 12] = bytes(12)
            struct.pack_into(e + "H", tiff, gps, 0)
            return n > 0
    except (KeyError, struct.error, IndexError):
        pass
    return False


def strip_gps(data: bytes) -> bytes:
    """Координаты съёмки из JPEG и TIFF — до сохранения на сервере. Без перекодирования: длина и картинка
    те же, поворот и фокусное остаются. Медицинские фото не должны выдавать, где снимали."""
    out = bytearray(data)
    if out[:2] == b"\xff\xd8":
        pos = 2
        try:
            while pos + 4 <= len(out) and out[pos] == 0xFF and out[pos + 1] not in (0xD9, 0xDA):
                end = pos + 2 + struct.unpack_from(">H", out, pos + 2)[0]
                body = pos + 4
                if out[pos + 1] == 0xE1 and out[body:body + 6] == b"Exif\x00\x00":
                    tiff = bytearray(out[body + 6:end])
                    if _wipe_gps(tiff):
                        out[body + 6:end] = tiff
                elif out[pos + 1] == 0xE1 and out[body:body + len(_XMP)] == _XMP and b"GPS" in out[body:end]:
                    out[body + len(_XMP):end] = b" " * (end - body - len(_XMP))
                pos = end
        except struct.error:
            pass
    elif out[:4] in (b"II*\x00", b"MM\x00*"):
        _wipe_gps(out)
    return bytes(out)


def encode(bgr: np.ndarray, fmt: str = "jpg", quality: int = 92) -> bytes:
    if fmt == "png":
        ok, buf = cv2.imencode(".png", bgr, [cv2.IMWRITE_PNG_COMPRESSION, 3])
    else:
        ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise AppError("ENCODE_FAILED", "Не удалось сохранить изображение", 500)
    return buf.tobytes()


def resize_max(bgr: np.ndarray, max_side: int) -> tuple[np.ndarray, float]:
    h, w = bgr.shape[:2]
    s = min(1.0, max_side / max(h, w))
    if s >= 1.0:
        return bgr, 1.0
    return cv2.resize(bgr, (max(1, round(w * s)), max(1, round(h * s))), interpolation=cv2.INTER_AREA), s
