"""Геометрия: масштаб по эталону, перспектива, площадь и периметр.

Все координаты на входе — пиксели исходного (правильно повёрнутого) фото:
x вправо, y вниз, (0, 0) — левый верхний угол.

Как это работает (простыми словами):
* По 4 углам эталона строим преобразование «пиксели фото -> миллиметры на столе».
  - Аффинное (обычный режим): учитывает масштаб, поворот и лёгкое растяжение.
  - Перспективное (гомография): дополнительно выпрямляет трапецию при наклоне камеры.
* Точки обводки переводим в миллиметры и считаем площадь формулой шнурка (Гаусса).
"""
from __future__ import annotations

import math
from typing import Iterable, Sequence

import numpy as np

from . import config
from .errors import bad_input
from .pose import ensemble_uncertainty_pct, marker_pose

# ---------------------------------------------------------------- базовое


def to_points(raw: Iterable, *, min_points: int = 1, max_points: int = 20000, name: str = "points") -> np.ndarray:
    try:
        arr = np.asarray(raw, dtype=np.float64)
    except (TypeError, ValueError):
        raise bad_input("BAD_POINTS", f"{name}: ожидается список точек [[x, y], ...]")
    if arr.ndim != 2 or arr.shape[1] != 2:
        raise bad_input("BAD_POINTS", f"{name}: каждая точка должна быть парой [x, y]")
    if len(arr) < min_points:
        raise bad_input("TOO_FEW_POINTS", f"{name}: нужно минимум {min_points} точки, получено {len(arr)}")
    if len(arr) > max_points:
        raise bad_input("TOO_MANY_POINTS", f"{name}: слишком много точек ({len(arr)}), максимум {max_points}")
    if not np.all(np.isfinite(arr)):
        raise bad_input("BAD_POINTS", f"{name}: координаты должны быть числами")
    return arr


def polygon_area(p: np.ndarray) -> float:
    """Площадь многоугольника по формуле шнурка (Гаусса)."""
    x, y = p[:, 0], p[:, 1]
    return 0.5 * abs(float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))))


def polygon_perimeter(p: np.ndarray, closed: bool = True) -> float:
    d = np.diff(np.vstack([p, p[:1]]) if closed else p, axis=0)
    return float(np.sum(np.hypot(d[:, 0], d[:, 1])))


def polygon_centroid(p: np.ndarray) -> np.ndarray:
    x, y = p[:, 0], p[:, 1]
    cross = x * np.roll(y, -1) - np.roll(x, -1) * y
    a = cross.sum() / 2.0
    if abs(a) < 1e-12:
        return p.mean(axis=0)
    cx = ((x + np.roll(x, -1)) * cross).sum() / (6 * a)
    cy = ((y + np.roll(y, -1)) * cross).sum() / (6 * a)
    return np.array([cx, cy])


def dedupe_consecutive(p: np.ndarray, eps: float = 1e-9) -> np.ndarray:
    keep = [0]
    for i in range(1, len(p)):
        if np.hypot(*(p[i] - p[keep[-1]])) > eps:
            keep.append(i)
    q = p[keep]
    if len(q) > 1 and np.hypot(*(q[0] - q[-1])) <= eps:
        q = q[:-1]
    return q


def _segments_intersect(p1, p2, q1, q2) -> np.ndarray:
    """Векторно: пересекается ли отрезок p1-p2 с каждым отрезком q1[i]-q2[i] (строго)."""
    def orient(a, b, c):
        return (b[..., 0] - a[..., 0]) * (c[..., 1] - a[..., 1]) - (b[..., 1] - a[..., 1]) * (c[..., 0] - a[..., 0])
    d1 = orient(q1, q2, p1)
    d2 = orient(q1, q2, p2)
    d3 = orient(p1, p2, q1)
    d4 = orient(p1, p2, q2)
    return (d1 * d2 < 0) & (d3 * d4 < 0)


def is_self_intersecting(p: np.ndarray) -> bool:
    n = len(p)
    if n < 4:
        return False
    a = p
    b = np.roll(p, -1, axis=0)
    for i in range(n):
        # не сравниваем с соседними отрезками
        js = np.arange(i + 2, n)
        if i == 0:
            js = js[js != n - 1]
        if len(js) == 0:
            continue
        if np.any(_segments_intersect(a[i], b[i], a[js], b[js])):
            return True
    return False


# ---------------------------------------------------------------- эталон


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Порядок: по часовой стрелке на экране, начиная с угла, ближайшего к левому верхнему."""
    pts = np.asarray(pts, dtype=np.float64)
    c = pts.mean(axis=0)
    ang = np.arctan2(pts[:, 1] - c[1], pts[:, 0] - c[0])
    pts = pts[np.argsort(ang)]
    start = int(np.argmin(pts[:, 0] + pts[:, 1]))
    return np.roll(pts, -start, axis=0)


def quad_sides(c: np.ndarray) -> np.ndarray:
    return np.array([float(np.hypot(*(c[(i + 1) % 4] - c[i]))) for i in range(4)])


def quad_angles(c: np.ndarray) -> np.ndarray:
    out = []
    for i in range(4):
        a = c[i - 1] - c[i]
        b = c[(i + 1) % 4] - c[i]
        cosv = np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12)
        out.append(math.degrees(math.acos(max(-1.0, min(1.0, cosv)))))
    return np.array(out)


def is_convex(c: np.ndarray) -> bool:
    signs = []
    n = len(c)
    for i in range(n):
        a, b, d = c[i], c[(i + 1) % n], c[(i + 2) % n]
        cross = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0])
        signs.append(np.sign(cross))
    signs = [s for s in signs if s != 0]
    return len(signs) == n and (all(s > 0 for s in signs) or all(s < 0 for s in signs))


def fit_affine(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Аффинное преобразование src -> dst методом наименьших квадратов (3x3)."""
    n = len(src)
    A = np.zeros((2 * n, 6))
    bvec = np.zeros(2 * n)
    A[0::2, 0:2] = src
    A[0::2, 2] = 1
    A[1::2, 3:5] = src
    A[1::2, 5] = 1
    bvec[0::2] = dst[:, 0]
    bvec[1::2] = dst[:, 1]
    sol, *_ = np.linalg.lstsq(A, bvec, rcond=None)
    return np.array([[sol[0], sol[1], sol[2]], [sol[3], sol[4], sol[5]], [0, 0, 1]])


def fit_homography(src: np.ndarray, dst: np.ndarray) -> np.ndarray:
    """Перспективное преобразование по 4 точкам (решаем систему 8x8)."""
    A = []
    bvec = []
    for (x, y), (u, v) in zip(src, dst):
        A.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        A.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        bvec += [u, v]
    h = np.linalg.solve(np.array(A, dtype=np.float64), np.array(bvec, dtype=np.float64))
    return np.append(h, 1.0).reshape(3, 3)


def apply_transform(M: np.ndarray, p: np.ndarray) -> np.ndarray:
    ph = np.hstack([p, np.ones((len(p), 1))]) @ M.T
    w = ph[:, 2:3]
    if np.any(np.abs(w) < 1e-12):
        raise bad_input("BAD_GEOMETRY", "Точка попала за линию горизонта перспективы — проверьте углы эталона")
    return ph[:, :2] / w


def marker_square_mm(size_mm: float) -> np.ndarray:
    return np.array([[0, 0], [size_mm, 0], [size_mm, size_mm], [0, size_mm]], dtype=np.float64)


def _warn(code: str, message: str) -> dict:
    return {"code": code, "message": message}


def build_calibration(
    corners_px,
    marker_size_mm: float = config.DEFAULT_MARKER_MM,
    perspective: str = "auto",
    method: str = "manual",
    sigma_px: float | None = None,
    image_size: tuple[int, int] | None = None,
    plane: dict | None = None,
    focal35_mm: float | None = None,
) -> dict:
    """Калибровка по 4 углам эталона. Возвращает всё, что нужно для измерений.
    plane — лист бумаги под эталоном (plane.find_sheet): его края дают перспективу точнее эталона."""
    if not (0.5 <= marker_size_mm <= 1000):
        raise bad_input("BAD_MARKER_SIZE", "Сторона эталона должна быть от 0,5 до 1000 мм")
    if perspective not in ("auto", "on", "off"):
        raise bad_input("BAD_PERSPECTIVE", "perspective: допустимо 'auto', 'on' или 'off'")
    c = to_points(corners_px, min_points=4, max_points=4, name="corners")
    c = order_corners(c)
    sides = quad_sides(c)
    if sides.min() < 4:
        raise bad_input("MARKER_TOO_SMALL", "Углы эталона слишком близко друг к другу (меньше 4 пикселей)")
    if not is_convex(c):
        raise bad_input("MARKER_NOT_CONVEX", "Углы эталона образуют не выпуклый четырёхугольник — проверьте порядок и положение точек")
    angles = quad_angles(c)
    area_px = polygon_area(c)
    marker_area_mm2 = marker_size_mm ** 2
    px_per_mm = math.sqrt(area_px / marker_area_mm2)
    side_px = float(np.sqrt(area_px))

    dst = marker_square_mm(marker_size_mm)
    affine = fit_affine(c, dst)
    homog = fit_homography(c, dst)

    opp_diff = max(abs(sides[0] / sides[2] - 1), abs(sides[1] / sides[3] - 1))
    shape_tilt = float(np.max(np.abs(angles - 90)))

    if sigma_px is None:
        sigma_px = config.MANUAL_CORNER_SIGMA_PX if method == "manual" else 0.5
    sigma_px = max(float(sigma_px), config.MIN_AUTO_CORNER_SIGMA_PX)

    # Перспектива, по убыванию надёжности:
    # 1) лист бумаги в кадре (его края, plane.py) или сетка на столе (grid.py);
    # 2) поза эталона при известном фокусном расстоянии (pose.py) — фокусное из EXIF или как у телефона;
    #    видимые стороны листа (лист не целиком в кадре) её уточняют;
    # 3) только по трапеции эталона — если она заметно сильнее шума измерения углов
    by_sheet = bool(plane) and plane.get("source") in ("sheet", "grid") and perspective != "off"
    edges = plane.get("lines") if plane and plane.get("source") == "edges" else None
    pose = None
    focal_px = None
    if image_size is not None:
        focal_px = (focal35_mm or config.DEFAULT_FOCAL35_MM) / 43.27 * math.hypot(*image_size)  # 43,27 мм — диагональ кадра 35 мм
        if not by_sheet and perspective != "off":
            pose = marker_pose(c, marker_size_mm, image_size, focal_px, 0.03 if focal35_mm else 0.12, sigma_px, edges)
    noise_level = 3.0 * math.sqrt(2) * sigma_px / side_px
    if by_sheet:
        # лист в кадре: перспектива по его краям, масштаб и растяжение — по эталону
        homog = np.array(plane["homography"], dtype=np.float64)
        use_persp = True
    elif pose:
        homog = pose["H"]
        use_persp = True
    elif perspective == "on":
        use_persp = True
    elif perspective == "off":
        use_persp = False
    else:
        use_persp = opp_diff >= max(config.TILT_SIDE_RATIO, noise_level)

    # оценка погрешности площади (1 сигма), без учёта аккуратности обводки
    rel_scale = math.sqrt((0.71 * sigma_px / side_px) ** 2 + (config.MARKER_TOLERANCE_MM / marker_size_mm) ** 2)
    area_unc_pct = 200.0 * rel_scale

    # стороны эталона в мм при едином масштабе — проверка «квадратности»
    sides_mm = sides / px_per_mm
    adj_ratio = max(abs(sides[0] / sides[1] - 1), abs(sides[2] / sides[3] - 1))

    warnings: list[dict] = []
    if side_px < config.SMALL_MARKER_PX:
        warnings.append(_warn(
            "MARKER_SMALL",
            f"Эталон на снимке мелкий ({side_px:.0f} пикс.). Снимите ближе или загрузите фото без сжатия — "
            f"тогда погрешность станет меньше (сейчас около ±{area_unc_pct:.1f}%).",
        ))
    if by_sheet and sides.min() / sides.max() < config.SHEET_STRONG_SQUASH:
        warnings.append(_warn(
            "STRONG_TILT",
            f"Камера сильно наклонена: эталон на фото сжат в {sides.max() / sides.min():.1f} раза. Перспектива исправлена "
            "по листу, но дальние детали сжаты и обводятся хуже — точнее снимать сверху.",
        ))
    if pose:
        if pose["tilt_deg"] >= config.POSE_STRONG_TILT_DEG:
            warnings.append(_warn(
                "STRONG_TILT",
                f"Камера наклонена примерно на {pose['tilt_deg']:.0f}°. Перспектива учтена по эталону, но точнее — "
                "снимать сверху или так, чтобы лист бумаги под образцом целиком попал в кадр.",
            ))
        # квадрат под любым наклоном камеры даёт на фото вполне определённую форму; если углы в неё
        # не укладываются — эталон не квадратный или углы стоят неточно
        if pose["reprojection_px"] > max(4 * sigma_px, 0.015 * side_px):
            warnings.append(_warn(
                "MARKER_NOT_SQUARE",
                "Углы эталона не складываются в квадрат даже с учётом наклона камеры. Проверьте рамку эталона "
                "и линейкой — что он действительно квадратный.",
            ))
    elif not by_sheet:
        if shape_tilt >= config.STRONG_TILT_DEG or opp_diff >= config.TILT_SIDE_RATIO * 1.5:
            warnings.append(_warn(
                "STRONG_TILT",
                "Камера заметно наклонена. Для точного результата снимайте строго сверху "
                "или так, чтобы лист бумаги под образцом целиком попал в кадр — по нему наклон исправится.",
            ))
        if adj_ratio >= config.NOT_SQUARE_RATIO and opp_diff < config.TILT_SIDE_RATIO and shape_tilt < 6:
            warnings.append(_warn(
                "MARKER_NOT_SQUARE",
                f"Соседние стороны эталона отличаются на {adj_ratio * 100:.0f}%. Проверьте линейкой, что эталон действительно квадратный.",
            ))
    if image_size is not None:
        w, h = image_size
        margin = 0.03 * min(w, h)
        if np.any(c[:, 0] < margin) or np.any(c[:, 1] < margin) or np.any(c[:, 0] > w - margin) or np.any(c[:, 1] > h - margin):
            warnings.append(_warn("MARKER_AT_EDGE", "Эталон у самого края кадра — там сильнее искажения объектива."))

    return {
        "kind": "square",
        "corners_px": c.round(3).tolist(),
        "marker_size_mm": float(marker_size_mm),
        "method": method,
        "perspective_mode": perspective,
        "perspective_used": bool(use_persp),
        "px_per_mm": px_per_mm,
        "mm_per_px": 1.0 / px_per_mm,
        "marker_side_px": side_px,
        "marker_sides_px": sides.round(3).tolist(),
        "marker_sides_mm": sides_mm.round(3).tolist(),
        "marker_angles_deg": angles.round(2).tolist(),
        "trapezoid_ratio": float(opp_diff),
        "shape_tilt_deg": shape_tilt,
        "sigma_px": sigma_px,
        "uncertainty_pct": area_unc_pct,
        "affine": affine.tolist(),
        "homography": homog.tolist(),
        "plane": (
            {k: v for k, v in plane.items() if k != "homography"} if by_sheet
            else {"source": "pose", **{k: v for k, v in pose.items() if k not in ("H", "ensemble")}} if pose
            else {"source": "marker"}
        ),
        "pose_ensemble": pose["ensemble"] if pose else None,
        "focal_px": focal_px,
        "focal_from_exif": bool(focal35_mm),
        "warnings": warnings,
    }


def segment_square(segment_px: np.ndarray, length_mm: float, side_mm: float) -> np.ndarray:
    """Квадрат side_mm×side_mm в масштабе отрезка: центр — середина отрезка, стороны — вдоль него и поперёк."""
    a, b = segment_px
    d = b - a
    s = float(np.hypot(*d)) * side_mm / length_mm
    u = d / np.hypot(*d) * s / 2
    n = np.array([-u[1], u[0]])
    m = (a + b) / 2
    return order_corners(np.array([m - u - n, m + u - n, m + u + n, m - u + n]))


def build_segment_calibration(segment_px, length_mm: float, image_size: tuple[int, int] | None = None,
                              sigma_px: float | None = None) -> dict:
    """Калибровка по отрезку известной длины — например, по шкале линейки на фото.
    Даёт только масштаб: наклон камеры по отрезку не виден, поэтому снимать нужно сверху.
    Чтобы остальной код работал как с квадратом, рядом строим «виртуальный» квадрат стороной
    DEFAULT_MARKER_MM в масштабе отрезка."""
    if not (0.1 <= length_mm <= 10000):
        raise bad_input("BAD_SEGMENT_LENGTH", "Длина отрезка должна быть от 0,1 до 10 000 мм")
    seg = to_points(segment_px, min_points=2, max_points=2, name="segment")
    len_px = float(np.hypot(*(seg[1] - seg[0])))
    if len_px < 4:
        raise bad_input("SEGMENT_TOO_SHORT", "Концы отрезка слишком близко друг к другу (меньше 4 пикселей)")
    px_per_mm = len_px / length_mm
    side_mm = config.DEFAULT_MARKER_MM
    corners = segment_square(seg, length_mm, side_mm)
    side_px = side_mm * px_per_mm
    affine = fit_affine(corners, marker_square_mm(side_mm))

    sigma_px = max(float(sigma_px or config.MANUAL_CORNER_SIGMA_PX), config.MIN_AUTO_CORNER_SIGMA_PX)
    # длина отрезка неточна на ошибку двух концов; плюс допуск шкалы
    rel_scale = math.sqrt((math.sqrt(2) * sigma_px / len_px) ** 2 + (config.MARKER_TOLERANCE_MM / length_mm) ** 2)
    area_unc_pct = 200.0 * rel_scale

    warnings: list[dict] = []
    if len_px < config.SMALL_SEGMENT_PX:
        warnings.append(_warn(
            "SEGMENT_SHORT",
            f"Отрезок короткий ({len_px:.0f} пикс.). Проведите его по всей видимой шкале линейки — "
            f"тогда погрешность станет меньше (сейчас около ±{area_unc_pct:.1f}%).",
        ))

    return {
        "kind": "segment",
        "segment_px": seg.round(3).tolist(),
        "segment_mm": float(length_mm),
        "segment_len_px": len_px,
        "corners_px": corners.round(3).tolist(),
        "marker_size_mm": float(side_mm),
        "method": "manual",
        "perspective_mode": "off",
        "perspective_used": False,
        "px_per_mm": px_per_mm,
        "mm_per_px": 1.0 / px_per_mm,
        "marker_side_px": side_px,
        "marker_sides_px": [round(side_px, 3)] * 4,
        "marker_sides_mm": [side_mm] * 4,
        "marker_angles_deg": [90.0] * 4,
        "trapezoid_ratio": 0.0,
        "shape_tilt_deg": 0.0,
        "sigma_px": sigma_px,
        "uncertainty_pct": area_unc_pct,
        "affine": affine.tolist(),
        "homography": affine.tolist(),
        "plane": {"source": "segment"},
        "pose_ensemble": None,
        "focal_px": None,
        "focal_from_exif": False,
        "warnings": warnings,
    }


def active_transform(cal: dict) -> np.ndarray:
    return np.array(cal["homography"] if cal["perspective_used"] else cal["affine"])


# ---------------------------------------------------------------- фигуры


def circle_from_3(p: np.ndarray) -> tuple[np.ndarray, float]:
    (x1, y1), (x2, y2), (x3, y3) = p
    d = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2))
    if abs(d) < 1e-9:
        raise bad_input("BAD_CIRCLE", "Три точки окружности лежат на одной прямой")
    ux = ((x1**2 + y1**2) * (y2 - y3) + (x2**2 + y2**2) * (y3 - y1) + (x3**2 + y3**2) * (y1 - y2)) / d
    uy = ((x1**2 + y1**2) * (x3 - x2) + (x2**2 + y2**2) * (x1 - x3) + (x3**2 + y3**2) * (x2 - x1)) / d
    center = np.array([ux, uy])
    return center, float(np.hypot(*(p[0] - center)))


def ellipse_polygon(cx: float, cy: float, rx: float, ry: float, angle_deg: float = 0.0, n: int = 720) -> np.ndarray:
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    a = math.radians(angle_deg)
    x = rx * np.cos(t)
    y = ry * np.sin(t)
    return np.column_stack([cx + x * math.cos(a) - y * math.sin(a), cy + x * math.sin(a) + y * math.cos(a)])


def shape_to_polygon(shape: str, points=None, ellipse: dict | None = None) -> tuple[np.ndarray, dict]:
    """Переводит фигуру (многоугольник / круг / эллипс) в многоугольник в пикселях."""
    if shape == "polygon":
        p = to_points(points, min_points=3, name="points")
        p = dedupe_consecutive(p)
        if len(p) < 3:
            raise bad_input("TOO_FEW_POINTS", "Обводка: нужно минимум 3 разные точки")
        if is_self_intersecting(p):
            raise bad_input("SELF_INTERSECTION", "Обводка пересекает сама себя — поправьте точки")
        if polygon_area(p) < 1.0:
            raise bad_input("ZERO_AREA", "Обводка: точки лежат на одной линии, площадь равна нулю")
        return p, {"shape": "polygon", "points": p.round(3).tolist()}
    if shape == "circle":
        p = to_points(points, min_points=2, max_points=3, name="points")
        if len(p) == 2:
            center, r = p[0], float(np.hypot(*(p[1] - p[0])))
        else:
            center, r = circle_from_3(p)
        if r < 1:
            raise bad_input("ZERO_AREA", "Круг: радиус слишком мал")
        poly = ellipse_polygon(center[0], center[1], r, r)
        return poly, {"shape": "circle", "points": p.round(3).tolist(), "center": center.round(3).tolist(), "radius_px": r}
    if shape == "ellipse":
        if not ellipse:
            raise bad_input("BAD_ELLIPSE", "Эллипс: нужно поле ellipse {cx, cy, rx, ry, angle_deg}")
        try:
            cx, cy, rx, ry = (float(ellipse[k]) for k in ("cx", "cy", "rx", "ry"))
            ang = float(ellipse.get("angle_deg", 0.0))
        except (KeyError, TypeError, ValueError):
            raise bad_input("BAD_ELLIPSE", "Эллипс: нужны числа cx, cy, rx, ry (и при желании angle_deg)")
        if rx < 1 or ry < 1:
            raise bad_input("ZERO_AREA", "Эллипс: радиусы слишком малы")
        poly = ellipse_polygon(cx, cy, rx, ry, ang)
        return poly, {"shape": "ellipse", "ellipse": {"cx": cx, "cy": cy, "rx": rx, "ry": ry, "angle_deg": ang}}
    raise bad_input("BAD_SHAPE", "shape: допустимо 'polygon', 'circle' или 'ellipse'")


# ---------------------------------------------------------------- измерение


def measure_polygon(cal: dict, poly_px: np.ndarray) -> dict:
    """Площадь и периметр фигуры в мм по калибровке."""
    A = np.array(cal["affine"])
    Hm = np.array(cal["homography"])
    pa = apply_transform(A, poly_px)
    ph = apply_transform(Hm, poly_px)
    area_aff = polygon_area(pa)
    area_hom = polygon_area(ph)
    use_p = cal["perspective_used"]
    pm = ph if use_p else pa
    area = area_hom if use_p else area_aff
    perim = polygon_perimeter(pm)

    # насколько далеко объект от эталона (в длинах стороны эталона)
    corners = np.array(cal["corners_px"])
    mc = corners.mean(axis=0)
    cen = polygon_centroid(poly_px)
    dist_sides = float(np.hypot(*(cen - mc)) / cal["marker_side_px"])

    base = cal["uncertainty_pct"]
    if use_p:
        # ошибка перспективы растёт с удалением от эталона; по листу она во столько раз меньше,
        # во сколько лист больше эталона
        extra = 200.0 * dist_sides * math.sqrt(2) * cal["sigma_px"] / cal["marker_side_px"]
        span = (cal.get("plane") or {}).get("span_px")
        if span:
            extra *= min(1.0, cal["marker_side_px"] / span)
        unc = math.sqrt(base**2 + extra**2)
    else:
        unc = base

    # перспектива по позе эталона: погрешность — насколько площадь меняется при других вариантах позы
    persp_pct = 0.0
    if use_p and cal.get("pose_ensemble"):
        persp_pct = ensemble_uncertainty_pct(cal, poly_px, area, apply_transform, polygon_area)
        unc = math.sqrt(base**2 + persp_pct**2)

    warnings = []
    if persp_pct >= config.PERSPECTIVE_WARN_PCT:
        warnings.append(_warn(
            "FAR_FROM_MARKER",
            f"Объект далеко от эталона: наклон камеры по одному эталону известен неточно, здесь это около ±{persp_pct:.0f}%. "
            "Положите эталон рядом с объектом или снимите так, чтобы лист бумаги под ними целиком "
            "(или хотя бы три его стороны) попал в кадр.",
        ))
    elif dist_sides > config.FAR_FROM_MARKER_SIDES:
        warnings.append(_warn(
            "FAR_FROM_MARKER",
            f"Объект далеко от эталона (≈{dist_sides:.0f} сторон эталона). Положите эталон ближе к объекту.",
        ))
    if unc > 10:
        warnings.append(_warn("HIGH_UNCERTAINTY", f"Оценка погрешности высокая: ±{unc:.0f}%."))

    return {
        "area_mm2": area,
        "area_cm2": area / 100.0,
        "perimeter_mm": perim,
        "uncertainty_pct": unc,
        "area_mm2_scale_only": area_aff,
        "area_mm2_perspective": area_hom,
        "method": "perspective" if use_p else "scale",
        "area_px": polygon_area(poly_px),
        "distance_from_marker_sides": dist_sides,
        "perspective_uncertainty_pct": persp_pct,
        "warnings": warnings,
    }
