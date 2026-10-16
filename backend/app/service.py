"""Логика приложения: калибровка, измерения, сравнение, экспорт."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import zipfile
from datetime import datetime, timedelta, timezone

import numpy as np

from . import config
from .detection import detect_marker
from .errors import AppError, bad_input, not_found
from .geometry import apply_transform, build_calibration, measure_polygon, shape_to_polygon
from .imaging import encode
from .standardize import annotate, plan_output, warp
from .storage import Store, new_id, now_iso

VERSION = "1.0.0"

METHOD_NOTE = (
    "Масштаб определяется по квадратному эталону известной стороны. "
    "По 4 углам эталона строится преобразование «пиксели -> мм на плоскости стола»: аффинное "
    "(масштаб, поворот, лёгкое растяжение) или, при заметном наклоне камеры, перспективное (гомография). "
    "Площадь обводки считается по формуле шнурка (Гаусса) в миллиметрах. "
    "Ограничения: объект и эталон должны лежать в одной плоскости; учебный прототип, не медицинское изделие."
)


# ---------------------------------------------------------------- представления

def _image_urls(image_id: str) -> dict:
    base = f"/api/images/{image_id}"
    return {
        "file": f"{base}/file",
        "preview": f"{base}/preview",
        "original": f"{base}/original",
        "standardized": f"{base}/standardized",
    }


def measurement_view(meta: dict, rec: dict) -> dict:
    poly, _ = shape_to_polygon(rec["shape"], rec.get("points"), rec.get("ellipse"))
    view = {k: v for k, v in rec.items()}
    cal = meta.get("calibration")
    if cal:
        view.update(measure_polygon(cal, poly))
        view["calibrated"] = True
    else:
        view.update({
            "area_mm2": None, "area_cm2": None, "perimeter_mm": None, "uncertainty_pct": None,
            "calibrated": False,
            "warnings": [{"code": "NOT_CALIBRATED", "message": "Фото не откалибровано: укажите эталон, чтобы получить площадь."}],
        })
    view["_polygon_px"] = poly
    return view


def public(view: dict) -> dict:
    return {k: v for k, v in view.items() if not k.startswith("_")}


def image_status(meta: dict) -> str:
    if meta.get("calibration"):
        return "calibrated"
    det = meta.get("detection")
    if det and det.get("found"):
        return "marker_found"
    if det:
        return "marker_not_found"
    return "uploaded"


def calibration_view(cal: dict | None) -> dict | None:
    if not cal:
        return None
    return dict(cal)


def image_view(meta: dict, with_measurements: bool = True) -> dict:
    v = {
        "id": meta["id"],
        "filename": meta["filename"],
        "width": meta["width"],
        "height": meta["height"],
        "size_bytes": meta["size_bytes"],
        "format": meta["format"],
        "rotated_by_exif": meta["rotated_by_exif"],
        "created_at": meta["created_at"],
        "group": meta.get("group"),
        "note": meta.get("note"),
        "status": image_status(meta),
        "urls": _image_urls(meta["id"]),
        "detection": meta.get("detection"),
        "calibration": calibration_view(meta.get("calibration")),
        "measurements_count": len(meta.get("measurements", [])),
    }
    if with_measurements:
        v["measurements"] = [public(measurement_view(meta, r)) for r in meta.get("measurements", [])]
    return v


# ---------------------------------------------------------------- эталон

def run_detection(store: Store, image_id: str, polarity: str = "dark", marker_size_mm: float | None = None,
                  auto_calibrate: bool = True, perspective: str = "auto") -> dict:
    meta = store.get(image_id)
    if polarity not in ("dark", "light", "any"):
        raise bad_input("BAD_POLARITY", "polarity: допустимо 'dark', 'light' или 'any'")
    bgr = store.load_bgr(image_id)
    det = detect_marker(bgr, polarity=polarity)
    meta["detection"] = det
    if auto_calibrate and det["found"]:
        size = marker_size_mm or (meta.get("calibration") or {}).get("marker_size_mm") or config.DEFAULT_MARKER_MM
        meta["calibration"] = _calibrate(meta, det["best"]["corners_px"], size, perspective, "auto",
                                         det["best"]["sigma_px"], candidate_index=0)
    store.clear_cache(image_id)
    store.save(meta)
    return meta


def _calibrate(meta: dict, corners, size_mm: float, perspective: str, method: str, sigma: float | None,
               candidate_index: int | None = None) -> dict:
    cal = build_calibration(corners, marker_size_mm=size_mm, perspective=perspective, method=method,
                            sigma_px=sigma, image_size=(meta["width"], meta["height"]))
    cal["candidate_index"] = candidate_index
    cal["updated_at"] = now_iso()
    _check_inside(meta, cal["corners_px"], "corners")
    return cal


def _check_inside(meta: dict, pts, name: str) -> None:
    p = np.asarray(pts, dtype=np.float64)
    w, h = meta["width"], meta["height"]
    tol = 0.02 * max(w, h)
    if np.any(p[:, 0] < -tol) or np.any(p[:, 1] < -tol) or np.any(p[:, 0] > w + tol) or np.any(p[:, 1] > h + tol):
        raise bad_input("OUTSIDE_IMAGE",
                        f"{name}: точки за пределами фото {w}×{h}. Координаты должны быть в пикселях исходного фото, а не экрана.")


def set_calibration(store: Store, image_id: str, corners=None, candidate_index: int | None = None,
                    marker_size_mm: float | None = None, perspective: str | None = None) -> dict:
    meta = store.get(image_id)
    old = meta.get("calibration") or {}
    size = marker_size_mm or old.get("marker_size_mm") or config.DEFAULT_MARKER_MM
    persp = perspective or old.get("perspective_mode") or "auto"
    if corners is not None:
        cal = _calibrate(meta, corners, size, persp, "manual", None)
    elif candidate_index is not None:
        det = meta.get("detection")
        if not det or not det.get("candidates"):
            raise AppError("NO_DETECTION", "Сначала запустите поиск эталона (/detect)", 409)
        if not (0 <= candidate_index < len(det["candidates"])):
            raise bad_input("BAD_CANDIDATE", f"candidate_index: от 0 до {len(det['candidates']) - 1}")
        c = det["candidates"][candidate_index]
        cal = _calibrate(meta, c["corners_px"], size, persp, "auto", c["sigma_px"], candidate_index)
    elif old:
        cal = _calibrate(meta, old["corners_px"], size, persp, old["method"], old.get("sigma_px"), old.get("candidate_index"))
    else:
        raise bad_input("NO_CORNERS", "Передайте corners (4 угла) или candidate_index")
    meta["calibration"] = cal
    store.clear_cache(image_id)
    store.save(meta)
    return meta


def reset_calibration(store: Store, image_id: str) -> dict:
    meta = store.get(image_id)
    meta["calibration"] = None
    store.clear_cache(image_id)
    store.save(meta)
    return meta


# ---------------------------------------------------------------- измерения

def _make_record(shape: str, points, ellipse, label: str | None) -> dict:
    poly, spec = shape_to_polygon(shape, points, ellipse)
    rec = {"id": new_id(), "label": (label or "").strip() or None, "created_at": now_iso()}
    rec.update(spec)
    return rec


def add_measurement(store: Store, image_id: str, shape: str, points=None, ellipse=None,
                    label: str | None = None, save: bool = True) -> dict:
    meta = store.get(image_id)
    rec = _make_record(shape, points, ellipse, label)
    poly, _ = shape_to_polygon(rec["shape"], rec.get("points"), rec.get("ellipse"))
    _check_inside(meta, poly, "points")
    view = public(measurement_view(meta, rec))
    if save:
        meta.setdefault("measurements", []).append(rec)
        store.clear_cache(image_id)
        store.save(meta)
    else:
        view["id"] = None
    view["saved"] = save
    return view


def update_measurement(store: Store, image_id: str, mid: str, **changes) -> dict:
    meta = store.get(image_id)
    recs = meta.get("measurements", [])
    for i, r in enumerate(recs):
        if r["id"] == mid:
            break
    else:
        raise not_found("Измерение", mid)
    r = recs[i]
    if any(changes.get(k) is not None for k in ("shape", "points", "ellipse")):
        shape = changes.get("shape") or r["shape"]
        new = _make_record(shape, changes.get("points") if changes.get("points") is not None else r.get("points"),
                           changes.get("ellipse") if changes.get("ellipse") is not None else r.get("ellipse"),
                           r.get("label"))
        new["id"], new["created_at"] = r["id"], r["created_at"]
        poly, _ = shape_to_polygon(new["shape"], new.get("points"), new.get("ellipse"))
        _check_inside(meta, poly, "points")
        r = new
    if "label" in changes and changes["label"] is not None:
        r["label"] = changes["label"].strip() or None
    r["updated_at"] = now_iso()
    recs[i] = r
    store.clear_cache(image_id)
    store.save(meta)
    return public(measurement_view(meta, r))


def delete_measurement(store: Store, image_id: str, mid: str) -> None:
    meta = store.get(image_id)
    before = len(meta.get("measurements", []))
    meta["measurements"] = [r for r in meta.get("measurements", []) if r["id"] != mid]
    if len(meta["measurements"]) == before:
        raise not_found("Измерение", mid)
    store.clear_cache(image_id)
    store.save(meta)


# ---------------------------------------------------------------- приведение к масштабу

def _require_cal(meta: dict) -> dict:
    cal = meta.get("calibration")
    if not cal:
        raise AppError("NOT_CALIBRATED", f"Фото «{meta['filename']}» не откалибровано: сначала укажите эталон", 409,
                       {"image_id": meta["id"]})
    return cal


def standardized_image(store: Store, image_id: str, px_per_mm: float | None, mode: str = "scale",
                       grid: bool = False, annotate_flag: bool = False, fmt: str = "jpg") -> tuple[bytes, dict]:
    meta = store.get(image_id)
    cal = _require_cal(meta)
    target = float(px_per_mm) if px_per_mm else cal["px_per_mm"]
    key_src = json.dumps([round(target, 5), mode, grid, annotate_flag, fmt, cal.get("updated_at"),
                          [(r["id"], r.get("updated_at"), r.get("label")) for r in meta.get("measurements", [])]])
    key = hashlib.md5(key_src.encode()).hexdigest()[:16]
    path = store.cache_dir(image_id) / f"std_{key}.{fmt}"
    M, size, info = plan_output(cal, (meta["width"], meta["height"]), target, mode)
    info = {"px_per_mm": target, "mode": mode, "output_size": list(size), **info}
    if path.is_file():
        return path.read_bytes(), info
    bgr = store.load_bgr(image_id)
    out = warp(bgr, M, size, mode)
    if grid or annotate_flag:
        views = [measurement_view(meta, r) for r in meta.get("measurements", [])] if annotate_flag else []
        out = annotate(out, M, cal, target, views, grid=grid, outlines=annotate_flag)
    data = encode(out, fmt, quality=90)
    path.write_bytes(data)
    return data, info


def _select(store: Store, image_ids: list[str] | None, group: str | None) -> list[dict]:
    if image_ids:
        return [store.get(i) for i in image_ids]
    if group:
        items = store.list(group)
        if not items:
            raise AppError("EMPTY_GROUP", f"В группе «{group}» нет фото", 404)
        return items
    return store.list()


def compare(store: Store, image_ids: list[str] | None = None, group: str | None = None,
            px_per_mm: float | None = None, mode: str = "scale", grid: bool = True,
            annotate_flag: bool = True) -> dict:
    metas = _select(store, image_ids, group)
    if len(metas) < 1:
        raise bad_input("NO_IMAGES", "Выберите хотя бы одно фото")
    missing = [m["filename"] for m in metas if not m.get("calibration")]
    if missing:
        raise AppError("NOT_CALIBRATED", "Не откалиброваны: " + ", ".join(missing), 409,
                       {"filenames": missing})
    if mode not in ("scale", "rectify"):
        raise bad_input("BAD_MODE", "mode: допустимо 'scale' или 'rectify'")
    if px_per_mm:
        target = float(px_per_mm)
    else:
        # по умолчанию — самый «мелкий» масштаб из выбранных: ничего не растягиваем, только уменьшаем
        target = min(m["calibration"]["px_per_mm"] for m in metas)
        # и следим, чтобы результат не был гигантским
        for m in metas:
            k = target / m["calibration"]["px_per_mm"]
            side = max(m["width"], m["height"]) * k
            if side > config.MAX_OUTPUT_SIDE:
                target *= config.MAX_OUTPUT_SIDE / side
    target = round(target, 4)
    items = []
    for m in metas:
        cal = m["calibration"]
        M, size, info = plan_output(cal, (m["width"], m["height"]), target, mode)
        marker_out = apply_transform(M, np.array(cal["corners_px"]))
        meas = []
        for r in m.get("measurements", []):
            v = measurement_view(m, r)
            meas.append({
                "id": r["id"], "label": r.get("label"),
                "area_mm2": v["area_mm2"], "area_cm2": v["area_cm2"], "uncertainty_pct": v["uncertainty_pct"],
                "points_out": apply_transform(M, v["_polygon_px"]).round(2).tolist() if r["shape"] == "polygon"
                else apply_transform(M, v["_polygon_px"][::8]).round(2).tolist(),
            })
        q = f"px_per_mm={target}&mode={mode}&grid={'true' if grid else 'false'}&annotate={'true' if annotate_flag else 'false'}"
        items.append({
            "image_id": m["id"],
            "filename": m["filename"],
            "group": m.get("group"),
            "source_px_per_mm": cal["px_per_mm"],
            "scale_factor": info.get("scale_factor"),
            "output_size": list(size),
            "cropped": info.get("cropped", False),
            "url": f"/api/images/{m['id']}/standardized?{q}",
            "marker_corners_out": marker_out.round(2).tolist(),
            "measurements": meas,
        })
    return {
        "px_per_mm": target,
        "one_cm_px": round(10 * target, 3),
        "mode": mode,
        "items": items,
    }


# ---------------------------------------------------------------- экспорт

# Колонки CSV для Excel. Остальные подробности измерения — в report.json архива
CSV_COLUMNS = [
    ("image_filename", "Файл"),
    ("area_mm2", "Площадь, мм²"),
    ("area_cm2", "Площадь, см²"),
    ("perimeter_mm", "Периметр, мм"),
    ("px_per_mm", "Масштаб, пикс/мм"),
    ("measured_at", "Дата"),
]


def _local_date(iso: str, tz_minutes: int | None) -> str:
    """ISO-время сервера -> «16.10.2026 21:24» в часовом поясе пользователя (смещение от UTC в минутах)."""
    try:
        t = datetime.fromisoformat(iso)
    except (TypeError, ValueError):
        return iso or ""
    if tz_minutes is not None:
        t = t.astimezone(timezone(timedelta(minutes=tz_minutes)))
    return t.strftime("%d.%m.%Y %H:%M")


def export_rows(store: Store, image_ids: list[str] | None = None, group: str | None = None) -> list[dict]:
    rows = []
    for m in _select(store, image_ids, group):
        cal = m.get("calibration")
        for r in m.get("measurements", []):
            v = measurement_view(m, r)
            warns = (cal or {}).get("warnings", []) + v.get("warnings", [])
            rows.append({
                "image_filename": m["filename"],
                "image_id": m["id"],
                "group": m.get("group") or "",
                "measurement_id": r["id"],
                "label": r.get("label") or "",
                "shape": {"polygon": "многоугольник", "circle": "круг", "ellipse": "эллипс"}[r["shape"]],
                "area_mm2": v["area_mm2"],
                "area_cm2": v["area_cm2"],
                "perimeter_mm": v["perimeter_mm"],
                "uncertainty_pct": v["uncertainty_pct"],
                "method": {"scale": "масштаб", "perspective": "перспектива"}.get(v.get("method"), "") if cal else "",
                "px_per_mm": cal["px_per_mm"] if cal else None,
                "marker_size_mm": cal["marker_size_mm"] if cal else None,
                "calibration": {"auto": "авто", "manual": "вручную"}.get(cal["method"], "") if cal else "нет",
                "warnings": "; ".join(w["message"] for w in warns),
                "measured_at": r.get("updated_at") or r["created_at"],
            })
    return rows


def to_csv(rows: list[dict], sep: str = ";", decimal: str = ",", tz_minutes: int | None = None) -> bytes:
    buf = io.StringIO()
    wr = csv.writer(buf, delimiter=sep, lineterminator="\r\n")
    wr.writerow([title for _, title in CSV_COLUMNS])

    def fmt(v, key):
        if v is None:
            return ""
        if key == "measured_at":
            return _local_date(v, tz_minutes)
        if isinstance(v, float):
            digits = {"area_mm2": 1, "area_cm2": 3, "perimeter_mm": 1, "uncertainty_pct": 1, "px_per_mm": 4, "marker_size_mm": 2}.get(key, 3)
            s = f"{v:.{digits}f}"
            return s.replace(".", decimal) if decimal != "." else s
        return str(v)

    for row in rows:
        wr.writerow([fmt(row[k], k) for k, _ in CSV_COLUMNS])
    return ("﻿" + buf.getvalue()).encode("utf-8")


def export_zip(store: Store, image_ids: list[str] | None = None, group: str | None = None,
               px_per_mm: float | None = None, mode: str = "scale") -> bytes:
    metas = _select(store, image_ids, group)
    rows = export_rows(store, [m["id"] for m in metas])
    calibrated = [m for m in metas if m.get("calibration")]
    report = {
        "generated_at": now_iso(),
        "software": f"OneScale backend {VERSION}",
        "method": METHOD_NOTE,
        "images": [image_view(m) for m in metas],
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("measurements.csv", to_csv(rows))
        z.writestr("report.json", json.dumps(report, ensure_ascii=False, indent=1))
        if calibrated:
            cmp = compare(store, [m["id"] for m in calibrated], px_per_mm=px_per_mm, mode=mode)
            used = set()
            for it in cmp["items"]:
                data, _ = standardized_image(store, it["image_id"], cmp["px_per_mm"], mode, grid=True, annotate_flag=True)
                stem = it["filename"].rsplit(".", 1)[0]
                name = f"standardized/{stem}_std.jpg"
                n = 2
                while name in used:
                    name = f"standardized/{stem}_std_{n}.jpg"
                    n += 1
                used.add(name)
                z.writestr(name, data)
        z.writestr("README.txt",
                   "Отчёт OneScale\r\n\r\n"
                   "measurements.csv — таблица измерений (открывается в Excel)\r\n"
                   "report.json — полные параметры калибровки и измерений\r\n"
                   "standardized/ — фото, приведённые к общему масштабу, с сеткой 1 см\r\n\r\n"
                   + METHOD_NOTE + "\r\n")
    return buf.getvalue()
