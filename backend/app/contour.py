"""«Волшебная палочка» (бета): клик внутри объекта -> программа предлагает обводку.

Заливка похожего цвета от точки клика, затем внешний контур, упрощённый до многоугольника.
Если передать union — уже выделенные области, — новая заливка объединяется с ними (Shift+клик).
Пользователь всегда может поправить точки вручную.
"""
from __future__ import annotations

import cv2
import numpy as np

from .errors import bad_input
from .imaging import resize_max


def _simplify(contour: np.ndarray, max_points: int) -> np.ndarray:
    peri = cv2.arcLength(contour, True)
    eps = 0.0015 * peri
    approx = cv2.approxPolyDP(contour, eps, True)
    while len(approx) > max_points:
        eps *= 1.5
        approx = cv2.approxPolyDP(contour, eps, True)
    return approx.reshape(-1, 2).astype(np.float64)


def autocontour(bgr: np.ndarray, seed_xy, tolerance: float = 25.0, max_points: int = 300, union=None) -> dict:
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
    for poly in union or []:
        p = np.asarray(poly, dtype=np.float64)
        if p.ndim != 2 or p.shape[1] != 2 or len(p) < 3:
            raise bad_input("BAD_POINTS", "union: каждая область — список точек [[x, y], ...], минимум 3")
        cv2.fillPoly(m, [np.round(((p + 0.5) * s - 0.5) * 16).astype(np.int32)], 255, lineType=cv2.LINE_8, shift=4)
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

    # при объединении несоприкасающиеся куски остаются отдельными контурами: первый — тот, где клик
    parts = [chosen]
    if union:
        min_area = max(4.0, 0.0002 * h * w)
        parts += sorted((c for c in contours if c is not chosen and cv2.contourArea(c) >= min_area), key=cv2.contourArea, reverse=True)
    polys = [_simplify(c, max_points) for c in parts]
    polys = [(p + 0.5) / s - 0.5 for p in polys if len(p) >= 3]
    if not polys:
        raise bad_input("NOTHING_FOUND", "Выделенная область слишком мала")
    pts = polys[0]

    frac = sum(float(cv2.contourArea(c)) for c in parts) / (h * w)
    warnings = []
    if frac > 0.5:
        warnings.append({"code": "FLOOD_TOO_BIG", "message": "Выделилась слишком большая область (вероятно, фон). Уменьшите tolerance."})
    if frac < 0.0005:
        warnings.append({"code": "FLOOD_TOO_SMALL", "message": "Выделилась очень маленькая область. Увеличьте tolerance."})
    return {
        "points_px": pts.round(2).tolist(),
        "contours_px": [p.round(2).tolist() for p in polys],
        "image_fraction": frac,
        "warnings": warnings,
    }
