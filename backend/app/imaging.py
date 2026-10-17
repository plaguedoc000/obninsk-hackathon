"""Чтение фото: поворот по EXIF, разные форматы, 16-битные TIFF."""
from __future__ import annotations

import io

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
