"""«Волшебная палочка» (бета): клик внутри объекта -> программа предлагает обводку.

Заливка похожего цвета от точки клика, затем внешний контур, упрощённый до многоугольника.
Пользователь всегда может поправить точки вручную.
"""
from __future__ import annotations

import cv2
import numpy as np

from .errors import bad_input
from .imaging import resize_max


def autocontour(bgr: np.ndarray, seed_xy, tolerance: float = 25.0, max_points: int = 300) -> dict:
    h0, w0 = bgr.shape[:2]
    try:
        sx0, sy0 = float(seed_xy[0]), float(seed_xy[1])
    except (TypeError, ValueError, IndexError):
        raise bad_input("BAD_POINT", "point: ожидается [x, y]")
    if not (0 <= sx0 < w0 and 0 <= sy0 < h0):
        raise bad_input("POINT_OUTSIDE", "Точка клика вне изображения")
    tol = float(np.clip(tolerance, 1, 100))

    small, s = resize_max(bgr, 1200)
    h, w = small.shape[:2]
    sx = int(np.clip(round((sx0 + 0.5) * s - 0.5), 0, w - 1))
    sy = int(np.clip(round((sy0 + 0.5) * s - 0.5), 0, h - 1))

    smooth = cv2.medianBlur(small, 5)
    lab = cv2.cvtColor(smooth, cv2.COLOR_BGR2LAB)
    mask = np.zeros((h + 2, w + 2), np.uint8)
    diff = (tol, tol * 0.6, tol * 0.6)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
    cv2.floodFill(lab, mask, (sx, sy), (0, 0, 0), diff, diff, flags)
    m = mask[1:-1, 1:-1]
    k = max(3, int(round(min(h, w) * 0.012)) | 1)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))

    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        raise bad_input("NOTHING_FOUND", "Не удалось выделить объект — попробуйте другую точку или tolerance")
    chosen = None
    for c in contours:
        if cv2.pointPolygonTest(c, (sx, sy), False) >= 0:
            chosen = c
            break
    if chosen is None:
        chosen = max(contours, key=cv2.contourArea)

    peri = cv2.arcLength(chosen, True)
    eps = 0.0015 * peri
    approx = cv2.approxPolyDP(chosen, eps, True)
    while len(approx) > max_points:
        eps *= 1.5
        approx = cv2.approxPolyDP(chosen, eps, True)
    pts = approx.reshape(-1, 2).astype(np.float64)
    if len(pts) < 3:
        raise bad_input("NOTHING_FOUND", "Выделенная область слишком мала")
    pts = (pts + 0.5) / s - 0.5

    frac = float(cv2.contourArea(chosen)) / (h * w)
    warnings = []
    if frac > 0.5:
        warnings.append({"code": "FLOOD_TOO_BIG", "message": "Выделилась слишком большая область (вероятно, фон). Уменьшите tolerance."})
    if frac < 0.0005:
        warnings.append({"code": "FLOOD_TOO_SMALL", "message": "Выделилась очень маленькая область. Увеличьте tolerance."})
    return {"points_px": pts.round(2).tolist(), "image_fraction": frac, "warnings": warnings}
