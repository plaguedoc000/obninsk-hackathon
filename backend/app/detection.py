"""Автоматический поиск квадратного эталона на фото (без нейросетей).

Шаги:
1. Уменьшаем фото до ~1600 пикс. и делаем его чёрно-белым несколькими способами
   (общий порог Оцу и два локальных порога — на случай неровного света).
2. Находим контуры пятен, оставляем выпуклые четырёхугольники.
3. Проверяем «похожесть на эталон»: стороны примерно равны, углы около 90°,
   внутри ровный цвет, снаружи заметно светлее (или темнее для светлого эталона).
   Ищем три вида эталона: тёмный на светлом, светлый на тёмном и цветной — по насыщенности цвета
   (жёлтый на белом почти не отличается по яркости, но сильно по цвету). При равенстве выигрывает тёмный.
4. Лучшие кандидаты уточняем на полном разрешении: края ищем с точностью до долей
   пикселя по профилю яркости поперёк края, через точки края проводим прямые,
   углы = пересечения прямых.
"""
from __future__ import annotations

import math
import time

import cv2
import numpy as np

from . import config
from .geometry import order_corners, polygon_area, quad_angles, quad_sides


def _odd(n: int) -> int:
    n = int(n)
    return n if n % 2 == 1 else n + 1


def _bilinear(img: np.ndarray, x: np.ndarray, y: np.ndarray) -> np.ndarray:
    h, w = img.shape
    x = np.clip(x, 0, w - 1.001)
    y = np.clip(y, 0, h - 1.001)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = x - x0
    fy = y - y0
    a = img[y0, x0]
    b = img[y0, x0 + 1]
    c = img[y0 + 1, x0]
    d = img[y0 + 1, x0 + 1]
    return (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy


def _restore_corner(poly: np.ndarray) -> np.ndarray | None:
    """Угол эталона засвечен бликом или срезан: на выпуклой оболочке контура — 5–6-угольник,
    лишние короткие стороны стоят на месте угла. Перебираем, какие 4 стороны настоящие: продолжаем их
    до пересечения и берём четырёхугольник, ближе всего к квадрату, в котором умещается весь контур."""
    from itertools import combinations

    n = len(poly)
    best, best_dev = None, 25.0  # углы — не дальше 25° от прямого
    for keep in combinations(range(n), 4):
        lines = [(poly[i], poly[(i + 1) % n] - poly[i]) for i in keep]
        quad = []
        for k in range(4):
            (p, d), (q, e) = lines[k - 1], lines[k]
            den = d[0] * e[1] - d[1] * e[0]
            if abs(den) < 1e-9:
                break
            t = ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / den
            quad.append(p + t * d)
        if len(quad) < 4:
            continue
        quad = np.array(quad)
        qc = quad.astype(np.float32).reshape(-1, 1, 2)
        if not cv2.isContourConvex(qc):
            continue
        # весь контур внутри (с запасом в 1,5 пикс.) и достроенный угол не улетел далеко
        if any(cv2.pointPolygonTest(qc, (float(x), float(y)), True) < -1.5 for x, y in poly):
            continue
        if polygon_area(quad) > 1.6 * polygon_area(poly):
            continue
        dev = float(np.max(np.abs(quad_angles(order_corners(quad)) - 90)))
        if dev < best_dev:
            best, best_dev = quad, dev
    return best


def _approx_quad(contour: np.ndarray) -> tuple[np.ndarray, bool] | None:
    """Четырёхугольник по контуру. Второе значение — угол был достроен (засвечен или закрыт)."""
    peri = cv2.arcLength(contour, True)
    # сначала мелкий допуск по выпуклой оболочке: выемка от блика становится одной короткой стороной
    # на месте угла, а не прячется в «кривой» квадрат
    hull = cv2.convexHull(contour)
    ap = cv2.approxPolyDP(hull, 0.025 * cv2.arcLength(hull, True), True).reshape(-1, 2).astype(np.float64)
    if len(ap) in (5, 6):
        q = _restore_corner(ap)
        if q is not None:
            return q, True
    for eps in (0.04, 0.025, 0.06, 0.08):
        ap = cv2.approxPolyDP(contour, eps * peri, True)
        if len(ap) == 4 and cv2.isContourConvex(ap):
            return ap.reshape(4, 2).astype(np.float64), False
    return None


def _region_stats(gray: np.ndarray, quad: np.ndarray, side: float) -> tuple[float, float, float, float]:
    """Средняя яркость и разброс внутри эталона и в кольце вокруг него."""
    h, w = gray.shape
    c = quad.mean(axis=0)
    pad = int(side * 0.6) + 4
    x0 = max(int(quad[:, 0].min()) - pad, 0)
    y0 = max(int(quad[:, 1].min()) - pad, 0)
    x1 = min(int(quad[:, 0].max()) + pad, w)
    y1 = min(int(quad[:, 1].max()) + pad, h)
    roi = gray[y0:y1, x0:x1]
    off = np.array([x0, y0])

    def scaled(f):
        return np.round((c + (quad - c) * f) - off).astype(np.int32)

    m_in = np.zeros(roi.shape, np.uint8)
    cv2.fillConvexPoly(m_in, scaled(0.75), 255)
    m_out = np.zeros(roi.shape, np.uint8)
    cv2.fillConvexPoly(m_out, scaled(1.6), 255)
    m_gap = np.zeros(roi.shape, np.uint8)
    cv2.fillConvexPoly(m_gap, scaled(1.2), 255)
    m_out = cv2.subtract(m_out, m_gap)
    if cv2.countNonZero(m_in) < 4 or cv2.countNonZero(m_out) < 4:
        return 0.0, 0.0, 0.0, 0.0
    # уровни — медианы, разброс — по межквартильному размаху: блик в углу или пылинка их не раздувают
    def robust(mask):
        v = roi[mask > 0]
        q25, q50, q75 = np.percentile(v, (25, 50, 75))
        return float(q50), float(q75 - q25) / 1.349

    mi, si = robust(m_in)
    mo, so = robust(m_out)
    return mi, si, mo, so


MAX_MARKER_RATIO = 1 / 3


def _lin(v: float) -> float:
    return float(LINEAR[int(np.clip(round(v), 0, 255))])


COLORFUL = 30  # разница каналов (из 255), с которой тёмное пятно уже цветное: синяя ручка, а не чёрный тонер


def _find_candidates(gray_small: np.ndarray, dark: bool, chroma_small: np.ndarray | None = None) -> list[dict]:
    h, w = gray_small.shape
    g = gray_small if dark else 255 - gray_small
    m = min(h, w)
    srcs = [cv2.GaussianBlur(g, (5, 5), 0)]
    if dark and chroma_small is not None:
        # тёмный цветной предмет (ручка, маркер), касающийся эталона, сливается с ним в одно пятно.
        # Эталон чёрный и бесцветный: если закрасить цветное тёмное цветом фона, пятна разделяются,
        # а закрытый угол эталона потом достраивается по сторонам
        thr, _ = cv2.threshold(srcs[0], 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        colorful = (chroma_small > COLORFUL) & (g < thr)
        if colorful.mean() > 0.0005:
            colorful = cv2.dilate(colorful.astype(np.uint8), np.ones((3, 3), np.uint8)) > 0  # и размытая кромка
            bg = np.uint8(np.median(g[g >= thr])) if (g >= thr).any() else np.uint8(255)
            srcs.append(cv2.GaussianBlur(np.where(colorful, bg, g), (5, 5), 0))
    masks = []
    for blur in srcs:
        _, otsu = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        masks.append(otsu)
        for bs, cst in ((_odd(max(15, m // 8)), 8), (_odd(max(31, m // 3)), 8)):
            masks.append(cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, bs, cst))

    min_area = max(80.0, 0.00003 * h * w)
    max_area = 0.2 * h * w
    out = []
    for mk in masks:
        mk = cv2.morphologyEx(mk, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
        contours, _ = cv2.findContours(mk, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        for cnt in contours:
            a = cv2.contourArea(cnt)
            if a < min_area or a > max_area:
                continue
            found = _approx_quad(cnt)
            if found is None:
                continue
            q, restored = found
            q = order_corners(q)
            qa = polygon_area(q)
            # у достроенного угла контур меньше четырёхугольника: часть эталона засвечена
            if qa <= 0 or not ((0.7 if restored else 0.8) <= a / qa <= 1.2):
                continue
            sides = quad_sides(q)
            ratio = sides.min() / sides.max()
            ang_dev = float(np.max(np.abs(quad_angles(q) - 90)))
            # сильно сжатый четырёхугольник может быть эталоном при наклоне камеры 50–65° — такой оставляем
            # про запас: в detect_marker он пройдёт, только если на виде сверху по листу окажется квадратом
            squashed = ratio < 0.55 or ang_dev > 35
            if ratio < 0.3 or ang_dev > 55:
                continue
            side = math.sqrt(qa)
            mi, si, mo, so = _region_stats(g, q, side)
            contrast = mo - mi
            if contrast < 25:
                continue
            # эталон — чёрный: в линейном свете он хотя бы втрое темнее фона (настоящий — в 10–25 раз).
            # Жёлтая или серая наклейка того же размера темнее фона лишь в 1,5–2 раза
            dim, bright = (mi, mo) if dark else (255 - mo, 255 - mi)
            if _lin(dim) > MAX_MARKER_RATIO * _lin(bright):
                continue
            uniform = si / max(contrast, 1e-6)
            if uniform > 0.45:
                continue
            score = (
                ratio ** 1.5
                * (1 - ang_dev / 90)
                * min(contrast / 60.0, 1.0)
                * (1 - 0.8 * uniform)
                * (1 - 0.5 * min(so / max(contrast, 1e-6), 1.0))
            )
            out.append({"quad": q, "score": float(score) * (0.9 if restored else 1.0), "side": side,
                        "contrast": float(contrast), "restored": restored, "squashed": squashed})
    return _dedup(out)


def _dedup(cands: list[dict]) -> list[dict]:
    """Убираем дубли: один и тот же квадрат, найденный разными порогами или по яркости и по цвету сразу."""
    out = sorted(cands, key=lambda d: -d["score"])
    kept: list[dict] = []
    for cnd in out:
        c0 = cnd["quad"].mean(axis=0)
        dup = False
        for k in kept:
            if np.hypot(*(k["quad"].mean(axis=0) - c0)) < 0.35 * k["side"] and 0.7 < cnd["side"] / k["side"] < 1.4:
                dup = True
                break
        if not dup:
            kept.append(cnd)
    return kept


def _line_intersection(l1, l2) -> np.ndarray | None:
    (vx1, vy1, x1, y1), (vx2, vy2, x2, y2) = l1, l2
    den = vx1 * vy2 - vy1 * vx2
    if abs(den) < 1e-9:
        return None
    t = ((x2 - x1) * vy2 - (y2 - y1) * vx2) / den
    return np.array([x1 + t * vx1, y1 + t * vy1])


# Яркость JPEG (гамма sRGB) -> линейный свет, в тех же 0..255. Размытие объектива и смаз происходят
# в линейном свете: край там, где яркость ровно посередине между чёрным и фоном именно в линейной шкале.
# В гамма-значениях середина сдвинута в тёмную сторону — размытый эталон находился меньше настоящего
_v = np.arange(256) / 255.0
LINEAR = (np.where(_v <= 0.04045, _v / 12.92, ((_v + 0.055) / 1.055) ** 2.4) * 255.0).astype(np.float32)


def _levels(g: np.ndarray, quad: np.ndarray, side: float) -> tuple[float, float]:
    """Уровень внутри эталона и фона вокруг — медианы: тонкие линии сетки и пылинки их не сдвигают."""
    h, w = g.shape
    c = quad.mean(axis=0)
    pad = int(side * 0.6) + 4
    x0 = max(int(quad[:, 0].min()) - pad, 0)
    y0 = max(int(quad[:, 1].min()) - pad, 0)
    x1 = min(int(quad[:, 0].max()) + pad, w)
    y1 = min(int(quad[:, 1].max()) + pad, h)
    roi = g[y0:y1, x0:x1]

    def mask(f_out, f_in=None):
        m = np.zeros(roi.shape, np.uint8)
        cv2.fillConvexPoly(m, np.round(c + (quad - c) * f_out - [x0, y0]).astype(np.int32), 255)
        if f_in:
            cv2.fillConvexPoly(m, np.round(c + (quad - c) * f_in - [x0, y0]).astype(np.int32), 0)
        return m > 0

    inner, ring = roi[mask(0.75)], roi[mask(1.6, 1.2)]
    if inner.size < 4 or ring.size < 4:
        return 0.0, 0.0
    return float(np.median(inner)), float(np.median(ring))


CLEAN_DARK = 0.1  # насколько (доля перепада) сторона эталона у края может быть светлее самой тёмной
CLEAN_BG = 0.15  # и насколько фон у края может отличаться от обычного для этой стороны
CLEAN_MIN = 0.2  # чистых профилей должно остаться хотя бы столько, иначе берём все


def refine_corners(gray_full: np.ndarray, quad: np.ndarray, dark: bool = True) -> tuple[np.ndarray, float, bool]:
    """Уточнение углов до долей пикселя. Возвращает (углы, оценка ошибки в пикс., удалось ли)."""
    g = LINEAR[gray_full] if gray_full.dtype == np.uint8 else gray_full.astype(np.float32)
    if not dark:
        g = 255.0 - g
    side = math.sqrt(polygon_area(quad))
    mi, mo = _levels(g, quad, side)
    if mo - mi < 6:
        return quad, 1.0, False
    thr = (mi + mo) / 2.0
    gs = cv2.GaussianBlur(g, (0, 0), 0.8)
    center = quad.mean(axis=0)
    r = float(np.clip(0.15 * side, 2.0, 10.0))
    offs = np.arange(-r, r + 1e-9, 0.25)

    lines = []
    residuals = []
    for i in range(4):
        p0, p1 = quad[i], quad[(i + 1) % 4]
        d = p1 - p0
        length = float(np.hypot(*d))
        if length < 3:
            return quad, 1.0, False
        d /= length
        n = np.array([d[1], -d[0]])
        if np.dot(n, (p0 + p1) / 2 - center) < 0:
            n = -n
        k = int(np.clip(length * 0.8, 8, 400))
        ts = np.linspace(0.12, 0.88, k)
        base = p0[None, :] + ts[:, None] * (p1 - p0)[None, :]
        xs = base[:, 0:1] + offs[None, :] * n[0]
        ys = base[:, 1:2] + offs[None, :] * n[1]
        prof = _bilinear(gs, xs, ys)  # (k, m): тёмное внутри -> светлое снаружи
        # фон у каждой стороны свой (свет сбоку, тень): медиана полосы 0,2–0,5 стороны эталона снаружи
        far = np.linspace(0.2, 0.5, 7) * side
        band = _bilinear(g, base[:, 0:1] + far[None, :] * n[0], base[:, 1:2] + far[None, :] * n[1]).ravel()
        band = band[band > (mi + mo) / 2]  # тёмный предмет рядом (ручка, тень) — не фон
        bg = float(np.median(band)) if band.size >= 0.2 * len(base) * len(far) else mo
        side_thr = (mi + bg) / 2.0 if bg - mi >= 6 else thr
        # профиль годится, только если по обе стороны края — ровный эталон и ровный фон. Где у края блик
        # на эталоне, ручка, тень или линия сетки, точка края сместится — такие профили не берём
        inner, outer = prof[:, offs <= -0.5 * r], prof[:, offs >= 0.3 * r]
        lo_ref = float(np.percentile(np.median(inner, axis=1), 10))
        span = bg - lo_ref
        clean = ((inner.max(axis=1) - lo_ref < CLEAN_DARK * span)
                 & (outer.max(axis=1) - bg < CLEAN_BG * span) & (bg - outer.min(axis=1) < CLEAN_BG * span))
        if span > 6 and clean.sum() >= max(5, CLEAN_MIN * len(prof)):
            prof, base = prof[clean], base[clean]
        pts = []
        for row, b in zip(prof, base):
            s = row - side_thr
            idx = np.where((s[:-1] < 0) & (s[1:] >= 0))[0]
            if len(idx) == 0:
                continue
            j = idx[np.argmin(np.abs(offs[idx]))]
            frac = -s[j] / (s[j + 1] - s[j] + 1e-12)
            o = offs[j] + frac * (offs[j + 1] - offs[j])
            pts.append(b + o * n)
        if len(pts) < 5:
            return quad, 1.0, False
        pts = np.array(pts, dtype=np.float32)
        line = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        vx, vy, x0, y0 = line
        res = np.abs((pts[:, 0] - x0) * vy - (pts[:, 1] - y0) * vx)
        mad = np.median(res) * 1.4826 + 1e-6
        good = res < max(3 * mad, 0.5)
        if good.sum() >= 5 and good.sum() < len(pts):
            pts = pts[good]
            line = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
            vx, vy, x0, y0 = line
            res = np.abs((pts[:, 0] - x0) * vy - (pts[:, 1] - y0) * vx)
        lines.append(line)
        residuals.append(res)

    new = []
    for i in range(4):
        p = _line_intersection(lines[i - 1], lines[i])
        if p is None or np.hypot(*(p - quad[i])) > max(3.0, 0.15 * side):
            return quad, 1.0, False
        new.append(p)
    new = np.array(new)
    allres = np.concatenate(residuals)
    sigma = float(max(np.sqrt(np.mean(allres**2)), config.MIN_AUTO_CORNER_SIGMA_PX))
    return new, sigma, True


def _squares_on_sheet(gray: np.ndarray, cands: list[dict], scale: float) -> list[dict]:
    """Сжатые кандидаты, которые на виде сверху по листу (plane.sheet_views) — квадраты.
    Так находится эталон, снятый под 50–65°, и не находятся прямоугольные наклейки."""
    from .geometry import apply_transform
    from .plane import sheet_views

    views = sheet_views(gray)
    out = []
    for c in cands:
        q = c["quad"] / scale
        for contour, H in views:
            if cv2.pointPolygonTest(contour.astype(np.float32).reshape(-1, 1, 2), tuple(map(float, q.mean(axis=0))), False) < 0:
                continue
            top = order_corners(apply_transform(H, q))
            sides = quad_sides(top)
            if sides.min() / sides.max() >= 0.85 and float(np.max(np.abs(quad_angles(top) - 90))) <= 10:
                out.append(c)
                break
    return out


def to_gray(bgr: np.ndarray) -> np.ndarray:
    return bgr if bgr.ndim == 2 else cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)


def _chroma(bgr: np.ndarray) -> np.ndarray:
    """Насыщенность: разница самого яркого и самого тусклого канала. У белого, серого и чёрного — около 0"""
    b, g, r = cv2.split(bgr)
    return cv2.subtract(cv2.max(cv2.max(b, g), r), cv2.min(cv2.min(b, g), r))


def _color_channel(bgr: np.ndarray, quad: np.ndarray) -> tuple[np.ndarray, bool]:
    """Для цветного эталона углы уточняем по тому каналу (B, G или R), где эталон сильнее всего отличается
    от фона: каналы — это настоящая яркость света, край в них стоит там же, где на самом деле.
    Второе значение — эталон в этом канале темнее фона"""
    side = math.sqrt(polygon_area(quad))
    best = None
    for ch in cv2.split(bgr):
        mi, mo = _levels(ch, quad, side)
        if best is None or abs(mo - mi) > best[0]:
            best = (abs(mo - mi), ch, mi < mo)
    return best[1], best[2]


def _drop_substrates(cands: list[dict]) -> list[dict]:
    """Квадрат, внутри которого целиком лежит уверенный квадрат другого вида (тёмный на белой карточке,
    белый на чёрной), — подложка, а не эталон: эталон внутри ровный"""
    drop = set()
    for i, big in enumerate(cands):
        qb = big["quad"].astype(np.float32).reshape(-1, 1, 2)
        for small in cands:
            if (small is big or small["polarity"] == big["polarity"] or small["score"] < 0.5
                    or big["side"] < 1.8 * small["side"]):
                continue
            if all(cv2.pointPolygonTest(qb, (float(x), float(y)), False) > 0 for x, y in small["quad"]):
                drop.add(i)
                break
    return [c for i, c in enumerate(cands) if i not in drop]


# Тёмный квадрат на светлом — привычный эталон; светлый на тёмном и цветной уступают ему при равенстве:
# белый лист на тёмном столе или цветная наклейка не должны перебить настоящий эталон
POLARITY_WEIGHT = {"dark": 1.0, "light": 0.9, "color": 0.8}
POLARITIES = {"dark": ["dark"], "light": ["light"], "color": ["color"], "any": ["dark", "light", "color"]}


def detect_marker(bgr: np.ndarray, polarity: str = "any", max_candidates: int | None = None) -> dict:
    """Ищет эталон. polarity: 'dark' — тёмный на светлом, 'light' — светлый на тёмном, 'color' — цветной,
    'any' — любой контрастный квадрат (по умолчанию)."""
    t0 = time.perf_counter()
    max_candidates = max_candidates or config.DETECT_MAX_CANDIDATES
    gray = to_gray(bgr)
    H, W = gray.shape
    scale = min(1.0, config.DETECT_MAX_SIDE / max(H, W))
    small = cv2.resize(gray, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else gray
    chroma = None
    if bgr.ndim == 3:
        col = cv2.resize(bgr, None, fx=scale, fy=scale, interpolation=cv2.INTER_AREA) if scale < 1 else bgr
        chroma = cv2.subtract(col.max(axis=2), col.min(axis=2))

    cands = []
    for pol in POLARITIES.get(polarity, POLARITIES["any"]):
        if pol == "color":
            # цветной квадрат на сером, белом или чёрном: на карте насыщенности он светлый на тёмном
            found = _find_candidates(chroma, False) if chroma is not None else []
        else:
            found = _find_candidates(small, pol == "dark", chroma)
        for c in found:
            c["polarity"] = pol
            c["dark"] = pol == "dark"
            c["score"] *= POLARITY_WEIGHT[pol]
            cands.append(c)
    cands = _drop_substrates(_dedup(cands))
    squashed = [c for c in cands if c["squashed"]]
    cands = [c for c in cands if not c["squashed"]]
    if not cands and squashed:
        cands = _squares_on_sheet(gray, squashed, scale)
    cands = cands[:max_candidates]

    results = []
    for c in cands:
        q_full = c["quad"] / scale
        if c["polarity"] == "color":
            channel, dark = _color_channel(bgr, q_full)
            corners, sigma, refined = refine_corners(channel, q_full, dark=dark)
        else:
            corners, sigma, refined = refine_corners(gray, q_full, dark=c["dark"])
        if c.get("restored"):
            sigma = max(sigma, 1.0)  # угол достроен по продолжению сторон — он заведомо менее точен
        corners = order_corners(corners)
        sides = quad_sides(corners)
        results.append({
            "corners_px": corners.round(3).tolist(),
            "side_px": float(math.sqrt(polygon_area(corners))),
            "sides_px": sides.round(2).tolist(),
            "angles_deg": quad_angles(corners).round(2).tolist(),
            "confidence": round(float(c["score"]), 4),
            "contrast": round(c["contrast"], 1),
            "subpixel_refined": refined,
            "sigma_px": round(sigma, 3),
            "polarity": c["polarity"],
            "corner_restored": bool(c.get("restored")),
        })

    warnings = []
    if not results:
        warnings.append({
            "code": "MARKER_NOT_FOUND",
            "message": "Эталон не найден. Укажите 4 угла вручную или переснимите: контрастный квадрат — тёмный на светлом, "
                       "светлый на тёмном или цветной, без бликов и теней.",
        })
    elif len(results) > 1 and results[1]["confidence"] > 0.8 * results[0]["confidence"]:
        warnings.append({
            "code": "MULTIPLE_CANDIDATES",
            "message": "Найдено несколько похожих квадратов. Проверьте, что выбран именно эталон.",
        })
    elif results[0]["corner_restored"]:
        warnings.append({
            "code": "MARKER_CORNER_RESTORED",
            "message": "Угол эталона засвечен бликом или закрыт — он достроен по продолжению сторон. "
                       "Проверьте рамку; точнее будет переснять без блика.",
        })
    elif results[0]["confidence"] < 0.35:
        warnings.append({
            "code": "LOW_CONFIDENCE",
            "message": "Эталон найден неуверенно. Проверьте углы и при необходимости поправьте вручную.",
        })

    if results and results[0]["polarity"] == "color":
        warnings.append({
            "code": "MARKER_BY_COLOR",
            "message": "Эталон найден по цвету. Проверьте, что это квадрат 1×1 см, а не наклейка или этикетка.",
        })

    return {
        "found": bool(results),
        "best": results[0] if results else None,
        "candidates": results,
        "image_size": [W, H],
        "warnings": warnings,
        "elapsed_ms": round((time.perf_counter() - t0) * 1000, 1),
    }
