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


def _grow(poly: np.ndarray, d: float) -> np.ndarray:
    """Сдвигает вершины многоугольника наружу на d пикселей (по биссектрисе соседних сторон)."""
    n = len(poly)
    if n < 3 or d == 0:
        return poly
    ccw = 0.5 * float(np.dot(poly[:, 0], np.roll(poly[:, 1], -1)) - np.dot(poly[:, 1], np.roll(poly[:, 0], -1))) > 0
    out = []
    for i in range(n):
        a, b, c = poly[i - 1], poly[i], poly[(i + 1) % n]
        normals = []
        for p, q in ((a, b), (b, c)):
            e = q - p
            L = np.hypot(*e)
            if L < 1e-9:
                continue
            nrm = np.array([e[1], -e[0]]) / L  # наружу, если площадь по формуле шнурка положительна
            normals.append(nrm if ccw else -nrm)
        if not normals:
            out.append(b)
            continue
        m = np.sum(normals, axis=0)
        L = np.hypot(*m)
        out.append(b + (m / L) * d / max(0.5, float(np.dot(m / L, normals[0]))) if L > 1e-9 else b)
    return np.array(out)


def _flood(img: np.ndarray, sx: int, sy: int, tol: float, union, s: float, x0: float, y0: float, k: int):
    """Маска заливки похожего цвета от (sx, sy) на картинке img, которая получена из фото сдвигом на (x0, y0)
    и масштабом s. union — уже выделенные области в координатах фото."""
    h, w = img.shape[:2]
    lab = cv2.cvtColor(cv2.medianBlur(img, 5), cv2.COLOR_BGR2LAB)
    mask = np.zeros((h + 2, w + 2), np.uint8)
    diff = (tol, tol * 0.6, tol * 0.6)
    flags = 4 | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE | (255 << 8)
    cv2.floodFill(lab, mask, (sx, sy), (0, 0, 0), diff, diff, flags)
    m = mask[1:-1, 1:-1]
    for p in union:
        q = ((p - [x0, y0]) + 0.5) * s - 0.5
        cv2.fillPoly(m, [np.round(q * 16).astype(np.int32)], 255, lineType=cv2.LINE_8, shift=4)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (k, k)))
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))


def _parts(m: np.ndarray, sx: int, sy: int, with_union: bool) -> list:
    """Контуры заливки: первый — тот, где щёлкнули; при объединении — и остальные заметные куски."""
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not contours:
        return []
    chosen = next((c for c in contours if cv2.pointPolygonTest(c, (sx, sy), False) >= 0), None)
    if chosen is None:
        chosen = max(contours, key=cv2.contourArea)
    parts = [chosen]
    if with_union:
        min_area = max(4.0, 0.0002 * m.shape[0] * m.shape[1])
        parts += sorted((c for c in contours if c is not chosen and cv2.contourArea(c) >= min_area), key=cv2.contourArea, reverse=True)
    return parts


def _edge_offset(img: np.ndarray, m: np.ndarray, polys: list[np.ndarray]) -> float:
    """На сколько пикселей сдвинуть контур наружу, чтобы его площадь совпала с настоящей.
    Заливка не берёт пиксели на самом краю — там цвет объекта смешан с фоном. Для каждого такого пикселя
    считаем долю объекта (насколько его цвет ближе к цвету объекта, чем к фону) и складываем доли."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    k3 = np.ones((3, 3), np.uint8)
    core = cv2.erode(m, k3, iterations=2) > 0
    band = (cv2.dilate(m, k3, iterations=2) > 0) & ~core
    ring = (cv2.dilate(m, k3, iterations=6) > 0) & ~(cv2.dilate(m, k3, iterations=3) > 0)
    if core.sum() < 20 or ring.sum() < 20:
        return 0.0
    obj = np.median(lab[core], axis=0)
    bg = np.median(lab[ring], axis=0)
    axis = obj - bg
    if float(np.dot(axis, axis)) < 15.0**2:
        return 0.0  # объект почти не отличается от фона — долям не верим
    alpha = np.clip((lab[band] - bg) @ axis / float(np.dot(axis, axis)), 0, 1)
    true_area = float(core.sum() + alpha.sum())
    poly_area = sum(abs(0.5 * float(np.dot(p[:, 0], np.roll(p[:, 1], -1)) - np.dot(p[:, 1], np.roll(p[:, 0], -1)))) for p in polys)
    perim = sum(float(np.sum(np.hypot(*np.diff(np.vstack([p, p[:1]]), axis=0).T))) for p in polys)
    return float(np.clip((true_area - poly_area) / max(perim, 1e-9), -2.0, 2.0))


FINE_SIDE = 2400  # окно точной заливки: не больше 2400 пикс. по стороне


def autocontour(bgr: np.ndarray, seed_xy, tolerance: float = 25.0, max_points: int = 300, union=None) -> dict:
    h0, w0 = bgr.shape[:2]
    try:
        sx0, sy0 = float(seed_xy[0]), float(seed_xy[1])
    except (TypeError, ValueError, IndexError):
        raise bad_input("BAD_POINT", "point: ожидается [x, y]")
    if not (0 <= sx0 < w0 and 0 <= sy0 < h0):
        raise bad_input("POINT_OUTSIDE", "Точка клика вне изображения")
    tol = float(np.clip(tolerance, 1, 100))
    polys_in = []
    for poly in union or []:
        p = np.asarray(poly, dtype=np.float64)
        if p.ndim != 2 or p.shape[1] != 2 or len(p) < 3:
            raise bad_input("BAD_POINTS", "union: каждая область — список точек [[x, y], ...], минимум 3")
        polys_in.append(p)

    # 1) грубо — на копии 1200 пикс.: так заливка не цепляется за шум и мелкую текстуру
    small, s = resize_max(bgr, 1200)
    h, w = small.shape[:2]
    to_s = lambda v: int(round((v + 0.5) * s - 0.5))  # noqa: E731
    sx, sy = int(np.clip(to_s(sx0), 0, w - 1)), int(np.clip(to_s(sy0), 0, h - 1))
    k = max(3, int(round(min(h, w) * 0.012)) | 1)
    m = _flood(small, sx, sy, tol, polys_in, s, 0, 0, k)
    parts = _parts(m, sx, sy, bool(union))
    if not parts:
        raise bad_input("NOTHING_FOUND", "Не удалось выделить объект — попробуйте другую точку или tolerance")
    frac = sum(float(cv2.contourArea(c)) for c in parts) / (h * w)

    def outline(img, mask, cs, scale, x0=0.0, y0=0.0):
        # контур идёт по центрам крайних пикселей: сдвигаем его на настоящий край (см. _edge_offset)
        ps = [_simplify(c, max_points) for c in cs]
        d = _edge_offset(img, mask, ps) if frac < 0.5 else 0.5
        return [(_grow(p, d) + 0.5) / scale - 0.5 + [x0, y0] for p in ps]

    polys = outline(small, m, parts, s)

    # 2) точно — в полном разрешении, в окне вокруг найденного: узкие и мелкие объекты не съедаются сглаживанием
    if s < 1 and frac < 0.5:
        pts = np.vstack([c.reshape(-1, 2) for c in parts]).astype(np.float64)
        pts = (pts + 0.5) / s - 0.5
        x_lo, y_lo = pts.min(axis=0)
        x_hi, y_hi = pts.max(axis=0)
        pad = 0.15 * max(x_hi - x_lo, y_hi - y_lo) + 12 / s
        X0, Y0 = int(max(0, x_lo - pad)), int(max(0, y_lo - pad))
        X1, Y1 = int(min(w0, x_hi + pad + 1)), int(min(h0, y_hi + pad + 1))
        crop = bgr[Y0:Y1, X0:X1]
        f = min(1.0, FINE_SIDE / max(crop.shape[:2]))
        if f < 1:
            crop = cv2.resize(crop, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)
        ch, cw = crop.shape[:2]
        fx = int(np.clip(round((sx0 - X0 + 0.5) * f - 0.5), 0, cw - 1))
        fy = int(np.clip(round((sy0 - Y0 + 0.5) * f - 0.5), 0, ch - 1))
        kf = max(3, int(round(k * f / s)) | 1)  # то же «закрытие щелей» в миллиметрах, что и на копии
        mf = _flood(crop, fx, fy, tol, polys_in, f, X0, Y0, kf)
        fine = _parts(mf, fx, fy, bool(union))
        # заливка не должна упереться в край окна (значит, утекла в фон) и не должна сильно отличаться от грубой
        touches = mf[0].any() or mf[-1].any() or mf[:, 0].any() or mf[:, -1].any()
        if fine and not touches:
            area_c = sum(float(cv2.contourArea(c)) for c in parts) / s**2
            area_f = sum(float(cv2.contourArea(c)) for c in fine) / f**2
            if 0.6 < area_f / max(area_c, 1e-9) < 1.6:
                polys = outline(crop, mf, fine, f, X0, Y0)

    polys = [p for p in polys if len(p) >= 3]
    if not polys:
        raise bad_input("NOTHING_FOUND", "Выделенная область слишком мала")
    pts = polys[0]

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
