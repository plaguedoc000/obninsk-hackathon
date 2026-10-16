"""Приведение фото к общему масштабу и рисование подписей (сетка 1 см, эталон, обводки)."""
from __future__ import annotations

import math
from functools import lru_cache
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from . import config
from .errors import AppError
from .geometry import active_transform, apply_transform


def scale_matrix(fx: float, fy: float) -> np.ndarray:
    # cv2.resize сопоставляет центры пикселей: x' = (x + 0.5) * f - 0.5
    return np.array([[fx, 0, 0.5 * fx - 0.5], [0, fy, 0.5 * fy - 0.5], [0, 0, 1.0]])


def plan_output(cal: dict, size: tuple[int, int], target_ppmm: float, mode: str) -> tuple[np.ndarray, tuple[int, int], dict]:
    """Матрица «пиксели фото -> пиксели результата» и размер результата."""
    w, h = size
    if target_ppmm <= 0 or not math.isfinite(target_ppmm):
        raise AppError("BAD_TARGET", "px_per_mm должен быть положительным числом", 422)
    if mode == "scale":
        k = target_ppmm / cal["px_per_mm"]
        ow, oh = max(1, round(w * k)), max(1, round(h * k))
        if max(ow, oh) > config.MAX_OUTPUT_SIDE:
            raise AppError(
                "OUTPUT_TOO_LARGE",
                f"Результат получится {ow}×{oh} пикс. — это слишком много. Уменьшите px_per_mm.",
                422,
            )
        fx, fy = ow / w, oh / h
        return scale_matrix(fx, fy), (ow, oh), {"scale_factor": (fx + fy) / 2}
    if mode == "rectify":
        T = active_transform(cal)
        A = np.diag([target_ppmm, target_ppmm, 1.0]) @ T
        corners = np.array([[0, 0], [w - 1, 0], [w - 1, h - 1], [0, h - 1]], dtype=np.float64)
        ph = np.hstack([corners, np.ones((4, 1))]) @ A.T
        marker = apply_transform(A, np.array(cal["corners_px"]))
        mc = marker.mean(axis=0)
        limit = config.MAX_OUTPUT_SIDE
        cropped = False
        if np.all(ph[:, 2] > 1e-9):
            pts = ph[:, :2] / ph[:, 2:3]
            x0, y0 = pts.min(axis=0)
            x1, y1 = pts.max(axis=0)
        else:
            x0, y0, x1, y1 = mc[0] - limit / 2, mc[1] - limit / 2, mc[0] + limit / 2, mc[1] + limit / 2
            cropped = True
        if x1 - x0 > limit:
            x0 = float(np.clip(mc[0] - limit / 2, x0, x1 - limit)); x1 = x0 + limit; cropped = True
        if y1 - y0 > limit:
            y0 = float(np.clip(mc[1] - limit / 2, y0, y1 - limit)); y1 = y0 + limit; cropped = True
        ow, oh = int(math.ceil(x1 - x0)) + 1, int(math.ceil(y1 - y0)) + 1
        M = np.array([[1, 0, -x0], [0, 1, -y0], [0, 0, 1.0]]) @ A
        return M, (ow, oh), {"scale_factor": None, "cropped": cropped}
    raise AppError("BAD_MODE", "mode: допустимо 'scale' или 'rectify'", 422)


def warp(bgr: np.ndarray, M: np.ndarray, out_size: tuple[int, int], mode: str) -> np.ndarray:
    ow, oh = out_size
    if mode == "scale":
        h, w = bgr.shape[:2]
        interp = cv2.INTER_AREA if ow < w else cv2.INTER_CUBIC
        return cv2.resize(bgr, (ow, oh), interpolation=interp)
    # перспектива: при сильном уменьшении сначала сгладим, чтобы не было «лесенки»
    sx = math.sqrt(abs(np.linalg.det(M[:2, :2])))
    src = bgr
    if sx < 0.6:
        src = cv2.GaussianBlur(bgr, (0, 0), 0.5 / sx)
    return cv2.warpPerspective(src, M, (ow, oh), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT,
                               borderValue=(245, 245, 245))


# ---------------------------------------------------------------- подписи

_FONT_CANDIDATES = [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/TTF/DejaVuSans.ttf",
    "C:/Windows/Fonts/arial.ttf",
    "C:/Windows/Fonts/segoeui.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/Library/Fonts/Arial.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
]


@lru_cache(maxsize=8)
def _font(size: int):
    for p in _FONT_CANDIDATES:
        if Path(p).is_file():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return None


def fmt_num(x: float, digits: int = 1) -> str:
    return f"{x:,.{digits}f}".replace(",", " ").replace(".", ",")


def annotate(img: np.ndarray, M: np.ndarray, cal: dict, target_ppmm: float, measurements: list[dict],
             grid: bool = True, outlines: bool = True) -> np.ndarray:
    out = img.copy()
    h, w = out.shape[:2]
    marker = apply_transform(M, np.array(cal["corners_px"]))
    step = 10.0 * target_ppmm  # 1 см в пикселях результата
    if grid and step >= 6:
        layer = out.copy()
        ox, oy = marker[0]
        xs = np.arange(ox % step, w, step)
        ys = np.arange(oy % step, h, step)
        thick = max(1, int(round(min(w, h) / 900)))
        for x in xs:
            cv2.line(layer, (int(round(x)), 0), (int(round(x)), h - 1), (255, 255, 255), thick, cv2.LINE_AA)
        for y in ys:
            cv2.line(layer, (0, int(round(y))), (w - 1, int(round(y))), (255, 255, 255), thick, cv2.LINE_AA)
        out = cv2.addWeighted(layer, 0.45, out, 0.55, 0)
    if not outlines:
        return out
    lw = max(2, int(round(min(w, h) / 400)))
    cv2.polylines(out, [np.round(marker).astype(np.int32).reshape(-1, 1, 2)], True, (0, 220, 255), lw, cv2.LINE_AA)
    labels = []
    for i, m in enumerate(measurements, 1):
        poly = m.get("_polygon_px")
        if poly is None:
            continue
        q = apply_transform(M, np.asarray(poly))
        cv2.polylines(out, [np.round(q).astype(np.int32).reshape(-1, 1, 2)], True, (60, 220, 60), lw, cv2.LINE_AA)
        if m.get("area_mm2") is not None:
            text = f"{m.get('label') or '#' + str(i)}: {fmt_num(m['area_mm2'] / 100, 2)} см²"
            labels.append((q.mean(axis=0), text))
    labels.append((marker.mean(axis=0) + [0, step * 1.2 if step > 0 else 20], f"эталон {fmt_num(cal['marker_size_mm'], 1)} мм"))
    size = max(14, int(round(min(w, h) / 45)))
    font = _font(size)
    if font is None:
        for (x, y), text in labels:
            ascii_text = text.replace("см²", "cm2").replace("эталон", "marker").replace("мм", "mm")
            cv2.putText(out, ascii_text, (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, size / 30, (0, 0, 0), 4, cv2.LINE_AA)
            cv2.putText(out, ascii_text, (int(x), int(y)), cv2.FONT_HERSHEY_SIMPLEX, size / 30, (255, 255, 255), 1, cv2.LINE_AA)
        return out
    pil = Image.fromarray(cv2.cvtColor(out, cv2.COLOR_BGR2RGB))
    draw = ImageDraw.Draw(pil)
    for (x, y), text in labels:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        x0 = int(np.clip(x - tw / 2, 2, max(2, w - tw - 2)))
        y0 = int(np.clip(y - th / 2, 2, max(2, h - th - 2)))
        draw.rectangle([x0 - 4, y0 - 3, x0 + tw + 4, y0 + th + 6], fill=(0, 0, 0))
        draw.text((x0, y0 - bbox[1]), text, font=font, fill=(255, 255, 255))
    return cv2.cvtColor(np.asarray(pil), cv2.COLOR_RGB2BGR)
