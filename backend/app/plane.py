"""Перспектива по листу бумаги, на котором лежит эталон.

Эталон 1×1 см слишком мал, чтобы по нему увидеть наклон камеры: при наклоне 5–10° его стороны
отличаются меньше чем на пиксель, а образец в 10 см от эталона уже меряется с ошибкой 10–20%.
Края листа — длинные прямые через весь кадр — показывают наклон гораздо точнее.

Как это работает (простыми словами):
1. Ищем светлый четырёхугольник, внутри которого лежит эталон, целиком в кадре.
2. Уточняем каждую сторону листа до долей пикселя и проводим через неё прямую.
3. Противоположные стороны листа на столе параллельны, на фото они сходятся в «точках схода».
   Две точки схода задают «линию горизонта» плоскости стола — по ней снимаем перспективу.
4. Оставшееся растяжение и масштаб берём по эталону (он квадратный и ровно 10 мм).
5. Проверка: после исправления углы листа должны выйти прямыми. Если нет — это не лист
   (или он смят), и мы его не используем.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from .geometry import apply_transform, fit_affine, marker_square_mm, order_corners, polygon_area

WORK_SIDE = 1000  # сторона уменьшенной копии для поиска листа
MIN_AREA = 0.06  # лист занимает хотя бы 6% кадра
MAX_ANGLE_DEV = 2.5  # после исправления углы листа — прямые с точностью до 2,5°
MAX_LINE_RMS = 1.2  # края листа прямые: разброс точек края от прямой не больше 1,2 пикс.


def _candidates(gray_small: np.ndarray) -> list[np.ndarray]:
    """Области листа разными способами: общий порог Оцу и локальный (на случай света сбоку).
    Лист обычно светлее стола, но цветная бумага на белом столе — темнее: пробуем и так, и так."""
    blur = cv2.GaussianBlur(gray_small, (5, 5), 0)
    bright = cv2.threshold(blur, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]
    bs = (max(gray_small.shape) // 3) | 1
    local = cv2.adaptiveThreshold(blur, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, bs, -4)
    masks = [bright, local, 255 - bright]
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    # образцы и эталон на листе темнее его: закрываем «дырки», чтобы лист был одним куском
    return [cv2.morphologyEx(cv2.morphologyEx(m, cv2.MORPH_OPEN, k), cv2.MORPH_CLOSE, k, iterations=3) for m in masks]


def _quad(contour: np.ndarray) -> np.ndarray | None:
    """Четырёхугольник по выпуклой оболочке: образцы у края листа и тени дают выемки — оболочка их сглаживает.
    Это лишь грубые углы, точные прямые краёв находит _edge_line."""
    hull = cv2.convexHull(contour)
    peri = cv2.arcLength(hull, True)
    for eps in (0.01, 0.02, 0.03, 0.05, 0.08):
        ap = cv2.approxPolyDP(hull, eps * peri, True)
        if len(ap) == 4 and cv2.isContourConvex(ap):
            return ap.reshape(4, 2).astype(np.float64)
    return None


def _edge_line(lin: np.ndarray, p0: np.ndarray, p1: np.ndarray, inside: np.ndarray):
    """Два прохода: широкое окно ±24 пикс. находит край, даже если грубая прямая мимо на десяток пикселей,
    узкое ±6 пикс. вокруг найденной прямой уточняет его, не задевая соседних предметов."""
    first = _edge_pass(lin, p0, p1, inside, 24.0)
    if first is None:
        return None
    vx, vy, x0, y0 = first[0]
    d = np.array([vx, vy])
    q0 = np.array([x0, y0]) + np.dot(p0 - [x0, y0], d) * d  # концы отрезка — на найденной прямой
    q1 = np.array([x0, y0]) + np.dot(p1 - [x0, y0], d) * d
    return _edge_pass(lin, q0, q1, inside, 6.0) or first


def _edge_pass(lin: np.ndarray, p0: np.ndarray, p1: np.ndarray, inside: np.ndarray, r: float):
    """Прямая края листа по точкам перехода яркости поперёк стороны (в линейном свете, порог — середина
    между уровнями по обе стороны в этом же месте). Возвращает (прямая vx,vy,x0,y0; разброс; число точек)."""
    from .detection import _bilinear

    d = p1 - p0
    length = float(np.hypot(*d))
    d /= length
    n = np.array([d[1], -d[0]])
    if np.dot(n, (p0 + p1) / 2 - inside) < 0:
        n = -n  # n смотрит наружу листа
    k = int(np.clip(length / 3, 20, 600))
    ts = np.linspace(0.08, 0.92, k)  # у самых углов край скругляется — не берём
    base = p0[None, :] + ts[:, None] * (p1 - p0)[None, :]
    offs = np.arange(-r, r + 1e-9, 0.25)
    prof = _bilinear(lin, base[:, 0:1] + offs[None, :] * n[0], base[:, 1:2] + offs[None, :] * n[1])
    pts = []
    for row, b in zip(prof, base):
        sheet_lvl = np.median(row[offs <= -r / 2])
        table_lvl = np.median(row[offs >= r / 2])
        if abs(sheet_lvl - table_lvl) < 8:
            continue  # здесь край перекрыт образцом или тенью
        # лист обычно светлее стола, но бывает и наоборот — переход ищем в нужную сторону
        s = (row - (sheet_lvl + table_lvl) / 2) * np.sign(sheet_lvl - table_lvl)
        idx = np.where((s[:-1] > 0) & (s[1:] <= 0))[0]
        if len(idx) == 0:
            continue
        j = idx[np.argmin(np.abs(offs[idx]))]  # полосы дерева дают лишние переходы — берём ближайший к грубой прямой
        o = offs[j] + s[j] / (s[j] - s[j + 1] + 1e-12) * (offs[j + 1] - offs[j])
        pts.append(b + o * n)
    if len(pts) < 10:
        return None
    pts = np.array(pts, np.float32)
    good = np.ones(len(pts), bool)
    for _ in range(3):
        line = cv2.fitLine(pts[good], cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        vx, vy, x0, y0 = line
        res = np.abs((pts[:, 0] - x0) * vy - (pts[:, 1] - y0) * vx)
        good = res < max(3 * np.median(res[good]) * 1.4826, 0.6)
        if good.sum() < 10:
            return None
    # точки края должны покрывать большую часть отрезка, а не сбиться у его концов
    along = (pts[good] - p0) @ d
    if along.max() - along.min() < 0.6 * length:
        return None
    return line, float(np.sqrt(np.mean(res[good] ** 2))), int(good.sum())


def _homog_line(line) -> np.ndarray:
    vx, vy, x0, y0 = line
    return np.cross([x0, y0, 1.0], [x0 + vx, y0 + vy, 1.0])


def plane_from_sheet(sheet: np.ndarray, marker: np.ndarray, marker_mm: float, lines) -> tuple[np.ndarray, np.ndarray]:
    """Гомография «пиксели -> мм» по линии горизонта листа и квадрату эталона. Возвращает (H, углы листа в мм)."""
    hl = [_homog_line(l) for l in lines]
    v1 = np.cross(hl[0], hl[2])  # точка схода одной пары противоположных сторон
    v2 = np.cross(hl[1], hl[3])
    horizon = np.cross(v1, v2)
    horizon = horizon / horizon[2]
    Hp = np.array([[1.0, 0, 0], [0, 1.0, 0], horizon])  # линия горизонта уходит в бесконечность: параллельное снова параллельно
    A = fit_affine(apply_transform(Hp, marker), marker_square_mm(marker_mm))
    H = A @ Hp
    return H / H[2, 2], apply_transform(H, sheet)


def _angles(q: np.ndarray) -> np.ndarray:
    out = []
    for i in range(4):
        a, b = q[i - 1] - q[i], q[(i + 1) % 4] - q[i]
        out.append(math.degrees(math.acos(np.clip(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)), -1, 1))))
    return np.array(out)


def _angle_between(l1, l2) -> float:
    a = math.degrees(abs(math.atan2(l1[1], l1[0]) - math.atan2(l2[1], l2[0]))) % 180
    return min(a, 180 - a)


def _same_line(l1, l2) -> bool:
    if _angle_between(l1, l2) > 2.5:
        return False
    vx, vy, x0, y0 = l1
    return abs((l2[2] - x0) * vy - (l2[3] - y0) * vx) < 4


def _side_lines(contour: np.ndarray, s: float, ws: int, hs: int, lin: np.ndarray) -> list:
    """Прямые сторон листа: отрезки контура, кроме идущих вдоль края кадра, уточнённые на полном разрешении."""
    hull = cv2.convexHull(contour)
    # допуск 2,5 пикс. уменьшенной копии: грубая прямая не дальше пары пикселей от настоящего края
    poly = cv2.approxPolyDP(hull, 2.5, True).reshape(-1, 2).astype(np.float64)
    inside = poly.mean(axis=0) / s
    near = lambda p: (p[0] < 4, p[1] < 4, p[0] > ws - 5, p[1] > hs - 5)  # noqa: E731
    lines = []
    for i in range(len(poly)):
        a, b = poly[i], poly[(i + 1) % len(poly)]
        if np.hypot(*(b - a)) < 0.08 * max(ws, hs):
            continue
        if any(x and y for x, y in zip(near(a), near(b))):
            continue  # отрезок лежит на краю кадра — это не край листа
        fit = _edge_line(lin, a / s, b / s, inside)
        if fit is None or fit[1] > MAX_LINE_RMS:
            continue
        if any(_same_line(fit[0], l[0]) for l in lines):
            continue  # тот же край, разорванный образцом
        lines.append(fit)
    return lines


def _horizon_3(la, lc, lb, marker, marker_mm):
    """Видно три стороны: a и c — противоположные, b — между ними. Линия горизонта проходит через
    точку схода a и c; её наклон подбираем так, чтобы после исправления b была перпендикулярна a."""
    ha, hc, hb = (_homog_line(l) for l in (la, lc, lb))
    v1 = np.cross(ha, hc)
    pb = np.cross(hb, np.cross(hb, [0.0, 0.0, 1.0]))  # точка на b
    db = np.array([-hb[1], hb[0], 0.0])  # направление b (точка на бесконечности)

    def angle_err(psi):
        h = np.cross(v1, math.cos(psi) * pb / (np.linalg.norm(pb) + 1e-12) + math.sin(psi) * db / np.linalg.norm(db))
        if abs(h[2]) < 1e-9 * np.linalg.norm(h):
            return None, None
        h = h / h[2]
        Hp = np.array([[1.0, 0, 0], [0, 1.0, 0], h])
        try:
            A = fit_affine(apply_transform(Hp, marker), marker_square_mm(marker_mm))
        except Exception:
            return None, None
        M = A @ Hp
        # направления a и b после исправления
        def direction(line):
            vx, vy, x0, y0 = line
            q = apply_transform(M, np.array([[x0, y0], [x0 + 50 * vx, y0 + 50 * vy]]))
            return q[1] - q[0]
        u, w = direction(la), direction(lb)
        cosv = abs(np.dot(u, w)) / (np.linalg.norm(u) * np.linalg.norm(w) + 1e-12)
        return math.degrees(math.asin(min(1.0, cosv))), M  # 0 — перпендикулярны

    best = None
    for psi in np.linspace(0, math.pi, 721, endpoint=False):
        e, M = angle_err(psi)
        if e is not None and (best is None or e < best[0]):
            best = (e, psi, M)
    if best is None:
        return None
    lo, hi = best[1] - math.pi / 720, best[1] + math.pi / 720
    for _ in range(40):  # уточняем золотым сечением
        m1, m2 = lo + (hi - lo) * 0.382, lo + (hi - lo) * 0.618
        e1, _ = angle_err(m1)
        e2, _ = angle_err(m2)
        if e1 is None or e2 is None:
            break
        if e1 < e2:
            hi = m2
        else:
            lo = m1
    e, M = angle_err((lo + hi) / 2)
    if e is None or e > 0.2:
        return None
    return M / M[2, 2]


# стандартные листы, мм: A4 и Letter — по ним проверяем, что три найденные стороны действительно лист
PAPER_MM = (210.0, 297.0, 215.9, 279.4)


def find_sheet(gray: np.ndarray, marker_px, marker_mm: float) -> dict | None:
    """Лист под эталоном: прямые его сторон, гомография «пиксели -> мм» и проверки. None — листа нет.
    Углы листа могут быть за кадром: нужны прямые сторон, а не углы."""
    from .detection import LINEAR

    marker = order_corners(np.asarray(marker_px, np.float64))
    H_img, W_img = gray.shape
    s = min(1.0, WORK_SIDE / max(H_img, W_img))
    small = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else gray
    mc = tuple(float(v) for v in marker.mean(axis=0) * s)
    lin = LINEAR[gray] if gray.dtype == np.uint8 else gray.astype(np.float32)
    lin = cv2.GaussianBlur(lin, (0, 0), 1.0)
    hs, ws = small.shape
    for mask in _candidates(small):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in contours:
            if cv2.contourArea(c) < MIN_AREA * hs * ws or cv2.pointPolygonTest(c, mc, False) < 0:
                continue
            fits = _side_lines(c, s, ws, hs, lin)
            res = _solve(fits, marker, marker_mm, c, s)
            if res:
                return res
    return None


def _solve(fits, marker, marker_mm, contour, s) -> dict | None:
    if len(fits) < 3 or len(fits) > 4:
        return None
    # стороны по кругу вокруг листа
    cx, cy = contour.reshape(-1, 2).mean(axis=0) / s
    def around(f):
        vx, vy, x0, y0 = f[0]
        t = (cx - x0) * vx + (cy - y0) * vy
        return math.atan2(y0 + t * vy - cy, x0 + t * vx - cx)
    fits = sorted(fits, key=around)
    lines = [f[0] for f in fits]
    rms = max(f[1] for f in fits)
    if len(fits) == 4:
        # противоположные стороны — 0 и 2, 1 и 3; они не должны быть почти перпендикулярны
        if _angle_between(lines[0], lines[2]) > 40 or _angle_between(lines[1], lines[3]) > 40:
            return None
        hl = [_homog_line(l) for l in lines]
        corners = [np.cross(hl[i - 1], hl[i]) for i in range(4)]
        if any(abs(p[2]) < 1e-12 for p in corners):
            return None
        sheet = np.array([p[:2] / p[2] for p in corners])
        H, sheet_mm = plane_from_sheet(sheet, marker, marker_mm, lines)
        dev = float(np.max(np.abs(_angles(sheet_mm) - 90)))
        if dev > MAX_ANGLE_DEV:
            return None
        sides_mm = [float(np.hypot(*(sheet_mm[(i + 1) % 4] - sheet_mm[i]))) for i in range(4)]
        return {"source": "sheet", "sides": 4, "corners_px": sheet.round(2).tolist(), "homography": H.tolist(),
                "span_px": round(math.sqrt(polygon_area(sheet)), 1),
                "angle_dev_deg": round(dev, 2), "edge_rms_px": round(rms, 3), "sides_mm": [round(v, 1) for v in sides_mm]}
    # три стороны: ищем пару почти параллельных (на фото) — это противоположные
    pairs = [(i, j) for i in range(3) for j in range(i + 1, 3)]
    i, j = min(pairs, key=lambda p: _angle_between(lines[p[0]], lines[p[1]]))
    if _angle_between(lines[i], lines[j]) > 40:
        return None
    k = 3 - i - j
    H = _horizon_3(lines[i], lines[j], lines[k], marker, marker_mm)
    if H is None:
        return None
    # проверка: расстояние между противоположными сторонами — как у листа A4 или Letter
    vx, vy, x0, y0 = lines[i]
    a_mm = apply_transform(H, np.array([[x0, y0], [x0 + 100 * vx, y0 + 100 * vy]]))
    vx2, vy2, x2, y2 = lines[j]
    c_mm = apply_transform(H, np.array([[x2, y2]]))[0]
    da = a_mm[1] - a_mm[0]
    width = abs(np.cross(np.append(da, 0), np.append(c_mm - a_mm[0], 0))[2]) / np.linalg.norm(da)
    if min(abs(width / p - 1) for p in PAPER_MM) > 0.015:
        return None
    hl = [_homog_line(l) for l in (lines[i], lines[k], lines[j])]
    corners = [np.cross(hl[0], hl[1]), np.cross(hl[1], hl[2])]
    corners = [p[:2] / p[2] for p in corners]
    return {"source": "sheet", "sides": 3, "corners_px": [list(np.round(p, 2)) for p in corners],
            "homography": H.tolist(), "width_mm": round(float(width), 1), "edge_rms_px": round(rms, 3),
            "span_px": round(float(np.hypot(*(corners[1] - corners[0]))), 1)}
