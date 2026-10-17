"""Перспектива по одному эталону, когда известно фокусное расстояние камеры.

Если эталон не в центре кадра, даже небольшой наклон камеры заметно меняет его форму на фото:
квадрат чуть сплющивается и скашивается. Зная фокусное расстояние (из EXIF, а без него — как у основной
камеры телефона), по этим искажениям восстанавливаем, как камера стояла над столом (SQPnP и IPPE
с уточнением итерациями), и получаем перспективу для всей плоскости стола.

У задачи бывает два решения (камера наклонена «туда» или «сюда»). Обычно второе явно хуже объясняет
углы эталона. Если нет, предпочитаем меньший наклон — так снимают чаще, — а второе решение учитываем
в погрешности.

Если в кадре видны хотя бы две стороны листа (весь лист не влез), они уточняют позу: на столе
соседние стороны листа перпендикулярны, противоположные — параллельны. Ищем позу, при которой
и углы эталона, и эти условия выполняются лучше всего.

Погрешность считаем честно: пересчитываем площадь при чуть другом фокусном расстоянии и при углах
эталона, сдвинутых на величину их погрешности, и смотрим, насколько она меняется.
"""
from __future__ import annotations

import math

import cv2
import numpy as np

PRIOR_TILT_DEG = 10.0  # с рук снимают почти сверху: большой наклон менее вероятен
NOISE_SAMPLES = 4
EDGE_SIGMA_DEG = 0.3  # насколько точно прямые углы листа на столе: неровная резка, остаточная дисторсия


def _flip(size_mm: float) -> np.ndarray:
    """Координаты IPPE (центр квадрата, y вверх) -> наши (левый верхний угол эталона, y вниз)."""
    h = size_mm / 2
    return np.array([[1.0, 0, h], [0, -1.0, h], [0, 0, 1.0]])


def _relations(lines) -> list[tuple[int, int, bool]]:
    """Какие стороны листа на столе параллельны (True), а какие перпендикулярны (False). На фото
    противоположные стороны почти параллельны, соседние — заметно нет; промежуточные пары не используем."""
    from .plane import _angle_between

    out = []
    for i in range(len(lines)):
        for j in range(i + 1, len(lines)):
            a = _angle_between(lines[i], lines[j])
            if a < 35 or a > 55:
                out.append((i, j, a < 35))
    return out


def _residuals(p, obj, img, K, planes, rel, sigma_px) -> np.ndarray:
    """Отклонения углов эталона (в долях их погрешности) и условий на стороны листа (в долях EDGE_SIGMA)."""
    proj, _ = cv2.projectPoints(obj, p[:3], p[3:], K, None)
    r = ((proj.reshape(-1, 2) - img) / sigma_px).ravel()
    if not rel:
        return r
    R, _ = cv2.Rodrigues(p[:3])
    n = R[:, 2]
    # сторона листа на столе лежит и в плоскости стола, и в плоскости «камера + прямая на фото»
    d = [np.cross(m, n) for m in planes]
    d = [v / (np.linalg.norm(v) + 1e-12) for v in d]
    sig = math.radians(EDGE_SIGMA_DEG)
    extra = [(float(np.dot(np.cross(d[i], d[j]), n)) if par else float(np.dot(d[i], d[j]))) / sig for i, j, par in rel]
    return np.concatenate([r, extra])


def _refine(p, args, iters: int = 25):
    """Левенберг — Марквардт с численными производными: 6 параметров позы, десяток невязок."""
    lam = 1e-3
    r = _residuals(p, *args)
    cost = float(r @ r)
    for _ in range(iters):
        J = np.empty((len(r), 6))
        for k in range(6):
            h = 1e-6 if k < 3 else 1e-6 * max(1.0, abs(p[k]))
            dp = np.zeros(6)
            dp[k] = h
            J[:, k] = (_residuals(p + dp, *args) - r) / h
        A, g = J.T @ J, J.T @ r
        while True:
            step = np.linalg.solve(A + lam * np.diag(np.diag(A) + 1e-12), -g)
            r2 = _residuals(p + step, *args)
            c2 = float(r2 @ r2)
            if c2 < cost:
                p, r, lam = p + step, r2, lam * 0.3
                break
            lam *= 10
            if lam > 1e8:
                return p, r
        if cost - c2 < 1e-9 * max(cost, 1e-12):
            cost = c2
            break
        cost = c2
    return p, r


def _solve(corners: np.ndarray, size_mm: float, f: float, cx: float, cy: float, lines=None,
           sigma_px: float = 1.0) -> list[dict]:
    """Все правдоподобные позы эталона, лучшая первой. SQPnP находит лучшую позу целиком, IPPE подсказывает
    вторую («зеркальную»); обе уточняются итерациями. Голый IPPE из OpenCV для эталона вдали от центра
    кадра ошибается на 10–50°, поэтому его ответ — только начальное приближение.
    lines — видимые стороны листа: тогда поза уточняется и по ним (см. _residuals)."""
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
    rel = _relations(lines) if lines else []
    if rel:
        from .plane import _homog_line

        planes = [K.T @ _homog_line(l) for l in lines]
        args = (obj, corners.astype(np.float64), K, [m / np.linalg.norm(m) for m in planes], rel, sigma_px)
    out = []
    flip = _flip(size_mm)
    for rv, tv in starts:
        rv, tv = cv2.solvePnPRefineLM(obj, img, K, None, rv.copy(), tv.copy())
        cost_lines = 0.0
        if rel:
            p, r = _refine(np.r_[rv.ravel(), tv.ravel()], args)
            rv, tv = p[:3].reshape(3, 1), p[3:].reshape(3, 1)
            cost_lines = float(np.max(np.abs(r[8:])))
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
        cost = 4 * (err / sigma_px) ** 2 + (float(r[8:] @ r[8:]) if rel else 0.0)
        out.append({"err": err, "cost": cost, "edge_dev": cost_lines, "tilt": math.degrees(math.acos(min(1.0, abs(R[2, 2])))),
                    "normal": normal, "H": H / H[2, 2]})
    return sorted(out, key=lambda s: s["cost"])


def marker_pose(corners: np.ndarray, size_mm: float, image_size: tuple[int, int], focal_px: float,
                focal_rel_sigma: float, sigma_px: float, lines=None) -> dict | None:
    """Гомография «пиксели -> мм» по позе эталона и набор её вариантов для оценки погрешности.
    lines — видимые стороны листа под эталоном (plane.find_sheet, когда лист виден не целиком)."""
    w, h = image_size
    cx, cy = (w - 1) / 2, (h - 1) / 2
    sols = _solve(corners, size_mm, focal_px, cx, cy)
    if not sols:
        return None
    edges_used = False
    if lines and len(lines) >= 2:
        # стороны листа — только если они согласуются с эталоном: углы эталона почти не хуже, чем без них,
        # а условия на стороны выполнены (иначе это не прямоугольник или стороны найдены неверно)
        con = _solve(corners, size_mm, focal_px, cx, cy, lines, sigma_px)
        if con and con[0]["edge_dev"] < 3 and con[0]["cost"] - sols[0]["cost"] < 9:
            sols, edges_used = con, True
    use = lines if edges_used else None
    best, alt = sols[0], (sols[1] if len(sols) > 1 else None)
    if alt is None:
        ambiguous = False
    elif edges_used:
        ambiguous = alt["cost"] - best["cost"] < 4
    else:
        ambiguous = alt["err"] - best["err"] < sigma_px
    if ambiguous and alt["tilt"] < best["tilt"]:
        best, alt = alt, best

    def like_best(cands: list[dict]) -> dict | None:
        # из двух решений берём то, где стол наклонён так же, как в основном
        return max(cands, key=lambda s: float(np.dot(s["normal"], best["normal"])), default=None)

    ensemble = []
    for m in (1 - focal_rel_sigma, 1 + focal_rel_sigma):
        s = like_best(_solve(corners, size_mm, focal_px * m, cx, cy, use, sigma_px))
        if s:
            ensemble.append({"kind": "focal", "w": 1.0, "H": s["H"].tolist()})
    rng = np.random.default_rng(20261017)
    for _ in range(NOISE_SAMPLES):
        s = like_best(_solve(corners + rng.normal(0, sigma_px, corners.shape), size_mm, focal_px, cx, cy, use, sigma_px))
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
        "sheet_edges": len(lines) if edges_used else 0,
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
