"""Перспектива по одному эталону, когда известно фокусное расстояние камеры.

Если эталон не в центре кадра, даже небольшой наклон камеры заметно меняет его форму на фото:
квадрат чуть сплющивается и скашивается. Зная фокусное расстояние (из EXIF, а без него — как у основной
камеры телефона), по этим искажениям восстанавливаем, как камера стояла над столом (SQPnP и IPPE
с уточнением итерациями), и получаем перспективу для всей плоскости стола.

У задачи бывает два решения (камера наклонена «туда» или «сюда»). Обычно второе явно хуже объясняет
углы эталона. Если нет, предпочитаем меньший наклон — так снимают чаще, — а второе решение учитываем
в погрешности.

Погрешность считаем честно: пересчитываем площадь при чуть другом фокусном расстоянии и при углах
эталона, сдвинутых на величину их погрешности, и смотрим, насколько она меняется.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

PRIOR_TILT_DEG = 10.0  # с рук снимают почти сверху: большой наклон менее вероятен
NOISE_SAMPLES = 4


def _flip(size_mm: float) -> np.ndarray:
    """Координаты IPPE (центр квадрата, y вверх) -> наши (левый верхний угол эталона, y вниз)."""
    h = size_mm / 2
    return np.array([[1.0, 0, h], [0, -1.0, h], [0, 0, 1.0]])


def _solve(corners: np.ndarray, size_mm: float, f: float, cx: float, cy: float) -> list[dict]:
    """Все правдоподобные позы эталона, лучшая первой. SQPnP находит лучшую позу целиком, IPPE подсказывает
    вторую («зеркальную»); обе уточняются итерациями. Голый IPPE из OpenCV для эталона вдали от центра
    кадра ошибается на 10–50°, поэтому его ответ — только начальное приближение."""
    h = size_mm / 2
    obj = np.array([[-h, h, 0], [h, h, 0], [h, -h, 0], [-h, -h, 0]], np.float64)
    img = corners.reshape(-1, 1, 2).astype(np.float64)
    K = np.array([[f, 0, cx], [0, f, cy], [0, 0, 1.0]])
    starts = []
    try:
        ok, rv, tv = cv2.solvePnP(obj, img, K, None, flags=cv2.SOLVEPNP_SQPNP)
        if ok:
            starts.append((rv, tv))
        n, rvs, tvs, _ = cv2.solvePnPGeneric(obj, img, K, None, flags=cv2.SOLVEPNP_IPPE_SQUARE)
        starts += [(rvs[k], tvs[k]) for k in range(n)]
    except cv2.error:
        return []
    out = []
    flip = _flip(size_mm)
    for rv, tv in starts:
        rv, tv = cv2.solvePnPRefineLM(obj, img, K, None, rv.copy(), tv.copy())
        R, _ = cv2.Rodrigues(rv)
        t = tv.ravel()
        if t[2] <= 0:
            continue
        proj, _ = cv2.projectPoints(obj, rv, tv, K, None)
        err = float(np.sqrt(np.mean(np.sum((proj.reshape(-1, 2) - corners) ** 2, axis=1))))
        normal = R[:, 2] * np.sign(R[2, 2] or 1.0)
        if any(float(np.dot(normal, o["normal"])) > math.cos(math.radians(0.5)) for o in out):
            continue  # то же решение
        Hm = K @ np.column_stack([R[:, 0], R[:, 1], t])  # мм на столе -> пиксели
        H = flip @ np.linalg.inv(Hm)
        out.append({"err": err, "tilt": math.degrees(math.acos(min(1.0, abs(R[2, 2])))), "normal": normal, "H": H / H[2, 2]})
    return sorted(out, key=lambda s: s["err"])


def marker_pose(corners: np.ndarray, size_mm: float, image_size: tuple[int, int], focal_px: float,
                focal_rel_sigma: float, sigma_px: float) -> dict | None:
    """Гомография «пиксели -> мм» по позе эталона и набор её вариантов для оценки погрешности."""
    w, h = image_size
    cx, cy = (w - 1) / 2, (h - 1) / 2
    sols = _solve(corners, size_mm, focal_px, cx, cy)
    if not sols:
        return None
    best, alt = sols[0], (sols[1] if len(sols) > 1 else None)
    ambiguous = alt is not None and alt["err"] - best["err"] < sigma_px
    if ambiguous and alt["tilt"] < best["tilt"]:
        best, alt = alt, best

    def like_best(cands: list[dict]) -> dict | None:
        # из двух решений берём то, где стол наклонён так же, как в основном
        return max(cands, key=lambda s: float(np.dot(s["normal"], best["normal"])), default=None)

    ensemble = []
    for m in (1 - focal_rel_sigma, 1 + focal_rel_sigma):
        s = like_best(_solve(corners, size_mm, focal_px * m, cx, cy))
        if s:
            ensemble.append({"kind": "focal", "w": 1.0, "H": s["H"].tolist()})
    rng = np.random.default_rng(20261017)
    for _ in range(NOISE_SAMPLES):
        s = like_best(_solve(corners + rng.normal(0, sigma_px, corners.shape), size_mm, focal_px, cx, cy))
        if s:
            ensemble.append({"kind": "corner", "w": 1.0, "H": s["H"].tolist()})
    p_alt = 0.0
    if ambiguous:
        prior = lambda t: math.exp(-(t / PRIOR_TILT_DEG) ** 2 / 2)  # noqa: E731
        p_alt = prior(alt["tilt"]) / (prior(alt["tilt"]) + prior(best["tilt"]))
        ensemble.append({"kind": "alt", "w": p_alt, "H": alt["H"].tolist()})
    return {
        "H": best["H"],
        "tilt_deg": round(best["tilt"], 2),
        "reprojection_px": round(best["err"], 4),
        "ambiguous": bool(ambiguous),
        "alt_tilt_deg": round(alt["tilt"], 2) if alt else None,
        "alt_probability": round(p_alt, 3),
        "ensemble": ensemble,
    }


def ensemble_uncertainty_pct(cal: dict, poly_px: np.ndarray, area_mm2: float, transform, area_of) -> float:
    """Погрешность площади (1 сигма, %) от неточной перспективы: насколько меняется площадь при других
    вариантах позы. Общий сдвиг масштаба на самом эталоне уже учтён в погрешности эталона — его вычитаем."""
    ens = cal.get("pose_ensemble") or []
    if not ens or area_mm2 <= 0:
        return 0.0
    corners = np.asarray(cal["corners_px"])
    H0 = np.array(cal["homography"])
    m0 = area_of(transform(H0, corners))
    var: dict[str, list[float]] = {}
    alt = 0.0
    for e in ens:
        H = np.array(e["H"])
        k = area_of(transform(H, corners)) / m0  # насколько этот вариант иначе меряет сам эталон
        d = area_of(transform(H, poly_px)) / area_mm2 / k - 1
        if e["kind"] == "alt":
            alt += e["w"] * d * d
        else:
            var.setdefault(e["kind"], []).append(d * d)
    total = sum(float(np.mean(v)) for v in var.values()) + alt
    return 100.0 * math.sqrt(total)
