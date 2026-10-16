"""Синтетические тестовые картинки с точно известной геометрией."""
from __future__ import annotations

import math

import cv2
import numpy as np

SS = 16  # суперсэмплинг для сглаженных краёв (смещение краёв < 0.05 пикс.)


def _coverage(poly: np.ndarray, W: int, H: int):
    """Доля покрытия каждого пикселя многоугольником (в локальном окне)."""
    x0 = max(int(np.floor(poly[:, 0].min())) - 2, 0)
    y0 = max(int(np.floor(poly[:, 1].min())) - 2, 0)
    x1 = min(int(np.ceil(poly[:, 0].max())) + 3, W)
    y1 = min(int(np.ceil(poly[:, 1].max())) + 3, H)
    w, h = x1 - x0, y1 - y0
    local = (np.asarray(poly, dtype=np.float64) - [x0, y0]) + 0.5  # край пикселя -> 0
    # центр под-пикселя k имеет координату (k + 0.5)/SS; сдвигаем на полпикселя вниз-влево
    ss = local * SS - 0.5
    canvas = np.zeros((h * SS, w * SS), np.uint8)
    pts = np.round(ss * 16).astype(np.int32).reshape(-1, 1, 2)
    cv2.fillPoly(canvas, [pts], 255, lineType=cv2.LINE_8, shift=4)
    cov = cv2.resize(canvas, (w, h), interpolation=cv2.INTER_AREA).astype(np.float32) / 255.0
    return cov, x0, y0


def rect_corners(cx, cy, w, h, angle_deg=0.0) -> np.ndarray:
    a = math.radians(angle_deg)
    R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    base = np.array([[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]])
    return base @ R.T + [cx, cy]


def render(size=(1600, 1200), bg=(170, 110, 240), shapes=(), noise=2.0, blur=0.6, seed=0) -> np.ndarray:
    """shapes: [(polygon_px Nx2, (b,g,r)), ...] — рисуются по порядку."""
    W, H = size
    out = np.zeros((H, W, 3), np.float32)
    out[:] = bg
    for poly, color in shapes:
        cov, x0, y0 = _coverage(np.asarray(poly, dtype=np.float64), W, H)
        h, w = cov.shape
        region = out[y0:y0 + h, x0:x0 + w]
        region[:] = region * (1 - cov[..., None]) + np.array(color, np.float32) * cov[..., None]
    out = np.clip(out, 0, 255).astype(np.uint8)
    if blur > 0:
        out = cv2.GaussianBlur(out, (0, 0), blur)
    if noise > 0:
        rng = np.random.default_rng(seed)
        out = np.clip(out.astype(np.float32) + rng.normal(0, noise, out.shape), 0, 255).astype(np.uint8)
    return out


def warp_points(Hm: np.ndarray, p: np.ndarray) -> np.ndarray:
    ph = np.hstack([p, np.ones((len(p), 1))]) @ Hm.T
    return ph[:, :2] / ph[:, 2:3]


def tilted_view(size=(1600, 1200), tilt=0.15):
    """Гомография «стол -> фото» для наклонённой камеры (плоскость стола в пикселях 1:1)."""
    W, H = size
    src = np.float32([[0, 0], [W, 0], [W, H], [0, H]])
    dx = tilt * W
    dst = np.float32([[dx, 0], [W - dx, 0], [W, H], [0, H]])
    return cv2.getPerspectiveTransform(src, dst).astype(np.float64)
