"""Перспектива по сетке на столе: коврик для резки, миллиметровка, плитка.

Если листа бумаги в кадре нет, но эталон лежит на коврике с сеткой, линии сетки работают как края
листа, только их десятки: одно семейство линий на фото сходится в одну точку схода, второе — в другую.
Две точки схода задают «линию горизонта» стола — по ней снимаем перспективу, а масштаб и растяжение
берём по эталону (как в plane.py).

Проверка: после исправления линии одного семейства параллельны, а двух семейств — перпендикулярны.
Если нет — это не сетка (полосы дерева, случайные края), и мы её не используем.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

from .geometry import apply_transform, fit_affine, marker_square_mm, order_corners

WORK_SIDE = 1000  # сторона уменьшенной копии для поиска линий
MIN_LINES = 5  # в каждом семействе хотя бы 5 линий: у листа их 2, у сетки — десятки
MIN_LENGTH = 0.25  # линия длиной хотя бы четверть короткой стороны кадра
VP_TOL_DEG = 0.25  # линия семейства смотрит в точку схода с точностью 0,25°
MAX_DEV_DEG = 1.0  # после исправления: семейства перпендикулярны, линии внутри семейства параллельны


def _lines(gray: np.ndarray) -> tuple[list[np.ndarray], list[np.ndarray]]:
    """Длинные прямые на фото: (прямые vx,vy,x0,y0; концы отрезков) в пикселях исходного фото."""
    H0, W0 = gray.shape
    s = min(1.0, WORK_SIDE / max(H0, W0))
    small = cv2.resize(gray, None, fx=s, fy=s, interpolation=cv2.INTER_AREA) if s < 1 else gray
    h, w = small.shape
    m = min(h, w)
    edges = cv2.Canny(cv2.GaussianBlur(small, (3, 3), 0), 40, 120)
    found = cv2.HoughLines(edges, 1, math.pi / 720, int(0.3 * m))
    if found is None or len(found) < 2 * MIN_LINES:
        return [], []
    # соседние в пространстве Хафа — одна и та же линия
    hough: list[tuple[float, float]] = []
    for rho, th in found[:300, 0]:
        if not any(abs(rho - r) < 2 and min(abs(th - t), math.pi - abs(th - t)) < math.radians(0.5) for r, t in hough):
            hough.append((float(rho), float(th)))
    ys, xs = np.nonzero(edges)
    P = np.column_stack([xs, ys]).astype(np.float64)
    lines, ends = [], []
    for rho, th in hough[:120]:
        n = np.array([math.cos(th), math.sin(th)])
        pts = P[np.abs(P @ n - rho) < 1.5]
        if len(pts) < 0.2 * m:
            continue
        # самый длинный сплошной кусок вдоль прямой: сетка не должна склеиться с краем предмета
        t = pts @ np.array([-n[1], n[0]])
        order = np.argsort(t)
        t, pts = t[order], pts[order]
        seg = max(np.split(np.arange(len(t)), np.where(np.diff(t) > 6)[0] + 1), key=len)
        if t[seg[-1]] - t[seg[0]] < MIN_LENGTH * m or len(seg) < 0.2 * m:
            continue
        q = pts[seg]
        vx, vy, x0, y0 = cv2.fitLine(q.astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        if np.sqrt(np.mean(((q[:, 0] - x0) * vy - (q[:, 1] - y0) * vx) ** 2)) > 0.6:
            continue  # не прямая
        line = np.array([vx, vy, x0 / s, y0 / s])
        if any(_same(line, l, 3 / s) for l in lines):
            continue
        lines.append(line)
        ends.append(np.array([q[0], q[-1]]) / s)
    return lines, ends


def _same(a: np.ndarray, b: np.ndarray, dist: float) -> bool:
    ang = math.degrees(abs(math.atan2(a[1], a[0]) - math.atan2(b[1], b[0]))) % 180
    return min(ang, 180 - ang) < 0.7 and abs((b[2] - a[2]) * a[1] - (b[3] - a[3]) * a[0]) < dist


def _homog(l: np.ndarray) -> np.ndarray:
    h = np.cross([l[2], l[3], 1.0], [l[2] + l[0], l[3] + l[1], 1.0])
    return h / np.linalg.norm(h)


def _family(lines: list[np.ndarray], ends: list[np.ndarray], free: list[int]) -> tuple[np.ndarray | None, list[int]]:
    """Самое большое семейство линий с общей точкой схода (перебор пар, затем МНК по всем линиям семейства)."""
    if len(free) < 2:
        return None, []
    L = np.array([_homog(lines[k]) for k in free])
    mid = np.array([ends[k].mean(axis=0) for k in free])
    d = np.array([lines[k][:2] for k in free])
    best: list[int] = []
    for a in range(len(free)):
        for b in range(a + 1, len(free)):
            v = np.cross(L[a], L[b])
            if abs(v[2]) < 1e-9 * np.linalg.norm(v):
                to_v = np.tile(v[:2] / np.linalg.norm(v[:2]), (len(free), 1))  # точка схода на бесконечности
            else:
                to_v = v[:2] / v[2] - mid
                to_v /= np.linalg.norm(to_v, axis=1, keepdims=True) + 1e-12
            sin = np.abs(d[:, 0] * to_v[:, 1] - d[:, 1] * to_v[:, 0])
            inl = np.nonzero(sin < math.sin(math.radians(VP_TOL_DEG)))[0]
            if len(inl) > len(best):
                best = list(inl)
    if len(best) < 2:
        return None, []
    _, _, vt = np.linalg.svd(L[best])
    return vt[-1], [free[i] for i in best]


def _spread(angles: np.ndarray) -> tuple[float, float]:
    """Средний угол и разброс направлений (углы по модулю 180°)."""
    z = np.exp(2j * np.radians(angles))
    mean = math.degrees(np.angle(z.mean())) / 2
    dev = np.abs((angles - mean + 90) % 180 - 90)
    return mean, float(dev.max())


def find_grid(gray: np.ndarray, marker_px, marker_mm: float) -> dict | None:
    """Сетка под эталоном: гомография «пиксели -> мм» по двум точкам схода её линий. None — сетки нет."""
    lines, ends = _lines(gray)
    if len(lines) < 2 * MIN_LINES:
        return None
    v1, f1 = _family(lines, ends, list(range(len(lines))))
    if v1 is None or len(f1) < MIN_LINES:
        return None
    v2, f2 = _family(lines, ends, [k for k in range(len(lines)) if k not in f1])
    if v2 is None or len(f2) < MIN_LINES:
        return None
    horizon = np.cross(v1, v2)
    if abs(horizon[2]) < 1e-12:
        return None
    Hp = np.array([[1.0, 0, 0], [0, 1.0, 0], horizon / horizon[2]])
    marker = order_corners(np.asarray(marker_px, np.float64))
    try:
        H = fit_affine(apply_transform(Hp, marker), marker_square_mm(marker_mm)) @ Hp
        angles = []
        for fam in (f1, f2):
            e = np.array([apply_transform(H, ends[k]) for k in fam])
            dv = e[:, 1] - e[:, 0]
            angles.append(np.degrees(np.arctan2(dv[:, 1], dv[:, 0])) % 180)
    except Exception:
        return None
    (m1, s1), (m2, s2) = _spread(angles[0]), _spread(angles[1])
    perp = abs((m1 - m2) % 180 - 90)
    if perp > MAX_DEV_DEG or max(s1, s2) > MAX_DEV_DEG:
        return None
    pts = np.vstack([ends[k] for k in f1 + f2])
    span = float(math.sqrt(np.ptp(pts[:, 0]) * np.ptp(pts[:, 1])))
    return {"source": "grid", "lines": [len(f1), len(f2)], "homography": (H / H[2, 2]).tolist(),
            "angle_dev_deg": round(float(perp), 3), "parallel_dev_deg": round(max(s1, s2), 3), "span_px": round(span, 1)}
