"""OneScale — бэкенд для измерения площади по фото с эталоном (кейс 03, Обнинский хакатон 2026).

Запуск:  uvicorn app.main:app --reload --port 8000
Документация API в браузере:  http://localhost:8000/api/docs
"""
from __future__ import annotations

import time
from typing import Literal, Optional

from fastapi import FastAPI, File, Form, Query, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel, Field

from . import config, service
from .contour import autocontour
from .errors import AppError
from .imaging import HEIC_SUPPORTED, encode, resize_max
from .storage import Store

store = Store(config.DATA_DIR)

# Документация под /api/: на сервере наружу открыт только этот путь
app = FastAPI(
    title="OneScale API",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    version=service.VERSION,
    description=(
        "Измерение площади объектов по фото с квадратным эталоном и приведение фото к общему масштабу.\n\n"
        "**Все координаты — в пикселях исходного фото** (ширина и высота есть в ответе `/api/images`), "
        "а не в пикселях экрана. Учебный прототип, не медицинское изделие."
    ),
)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"],
                   expose_headers=["Content-Disposition", "X-Preview-Scale"])


# ---------------------------------------------------------------- ошибки

@app.exception_handler(AppError)
async def _app_error(_: Request, exc: AppError):
    return JSONResponse(status_code=exc.status, content={"detail": exc.to_dict()})


@app.exception_handler(RequestValidationError)
async def _validation_error(_: Request, exc: RequestValidationError):
    parts = []
    for e in exc.errors():
        loc = ".".join(str(x) for x in e.get("loc", []) if x != "body")
        parts.append(f"{loc}: {e.get('msg')}")
    return JSONResponse(status_code=422, content={"detail": {
        "code": "VALIDATION_ERROR", "message": "Неверные данные запроса — " + "; ".join(parts), "errors": exc.errors()}},
    )


@app.exception_handler(Exception)
async def _unexpected(_: Request, exc: Exception):  # pragma: no cover
    return JSONResponse(status_code=500, content={"detail": {"code": "INTERNAL_ERROR", "message": f"Внутренняя ошибка: {exc}"}})


# ---------------------------------------------------------------- модели запросов

Point = list[float]


class DetectRequest(BaseModel):
    polarity: Literal["dark", "light", "any"] = Field("dark", description="Эталон тёмный на светлом (dark), светлый на тёмном (light) или любой")
    marker_size_mm: Optional[float] = Field(None, gt=0, description="Сторона эталона, мм (по умолчанию 10)")
    auto_calibrate: bool = Field(True, description="Сразу откалибровать по лучшему найденному квадрату")
    perspective: Literal["auto", "on", "off"] = "auto"


class CalibrationRequest(BaseModel):
    corners: Optional[list[Point]] = Field(None, description="4 угла эталона [[x,y]×4] в пикселях фото, в любом порядке")
    candidate_index: Optional[int] = Field(None, ge=0, description="Или номер кандидата из результата /detect")
    marker_size_mm: Optional[float] = Field(None, gt=0, description="Сторона эталона, мм")
    perspective: Optional[Literal["auto", "on", "off"]] = Field(None, description="Исправление наклона: auto / on / off")


class MeasurementRequest(BaseModel):
    shape: Literal["polygon", "circle", "ellipse"] = "polygon"
    points: Optional[list[Point]] = Field(None, description="polygon: ≥3 точки; circle: [центр, точка на краю] или 3 точки на окружности")
    ellipse: Optional[dict] = Field(None, description="ellipse: {cx, cy, rx, ry, angle_deg}")
    label: Optional[str] = Field(None, max_length=200)
    save: bool = Field(True, description="false — только посчитать (предпросмотр), не сохранять")


class MeasurementPatch(BaseModel):
    shape: Optional[Literal["polygon", "circle", "ellipse"]] = None
    points: Optional[list[Point]] = None
    ellipse: Optional[dict] = None
    label: Optional[str] = Field(None, max_length=200)


class ImagePatch(BaseModel):
    group: Optional[str] = Field(None, max_length=100, description="Серия/эксперимент; пустая строка — убрать")
    note: Optional[str] = Field(None, max_length=1000)
    filename: Optional[str] = Field(None, max_length=255)


class CompareRequest(BaseModel):
    image_ids: Optional[list[str]] = Field(None, description="Какие фото сравнить (или group)")
    group: Optional[str] = None
    px_per_mm: Optional[float] = Field(None, gt=0, description="Общий масштаб; по умолчанию — наименьший из выбранных")
    mode: Literal["scale", "rectify"] = Field("scale", description="scale — только масштаб; rectify — ещё и выпрямить наклон")
    grid: bool = True
    annotate: bool = True


class AutocontourRequest(BaseModel):
    point: Point = Field(..., description="Точка внутри объекта [x, y]")
    tolerance: float = Field(25, ge=1, le=100, description="Чувствительность к цвету (больше — захватывает больше)")
    union: Optional[list[list[Point]]] = Field(None, max_length=50, description="Уже выделенные области: новая заливка объединится с ними")


def _ids(s: Optional[str]) -> Optional[list[str]]:
    if not s:
        return None
    return [x.strip() for x in s.split(",") if x.strip()]


# ---------------------------------------------------------------- служебное

@app.get("/api/health", tags=["Служебное"])
def health():
    return {"status": "ok", "version": service.VERSION, "images": len(store.list()), "heic_supported": HEIC_SUPPORTED,
            "default_marker_mm": config.DEFAULT_MARKER_MM}


# ---------------------------------------------------------------- фото

@app.post("/api/images", tags=["Фото"], summary="Загрузить одно или несколько фото")
async def upload_images(
    files: list[UploadFile] = File(..., description="Фото (можно несколько)"),
    detect: bool = Form(True, description="Сразу искать эталон и калибровать"),
    marker_size_mm: Optional[float] = Form(None, gt=0),
    group: Optional[str] = Form(None),
):
    results, errors = [], []
    for f in files:
        t0 = time.perf_counter()
        try:
            data = await f.read()
            meta, _ = store.add_image(f.filename or "photo.jpg", data, group=group or None)
            if detect:
                meta = service.run_detection(store, meta["id"], marker_size_mm=marker_size_mm)
            v = service.image_view(meta)
            v["processing_ms"] = round((time.perf_counter() - t0) * 1000, 1)
            results.append(v)
        except AppError as e:
            errors.append({"filename": f.filename, "status": e.status, **e.to_dict()})
    if not results and errors:
        return JSONResponse(status_code=errors[0]["status"],
                            content={"detail": {"code": "UPLOAD_FAILED", "message": errors[0]["message"], "errors": errors}})
    return {"images": results, "errors": errors}


@app.get("/api/images", tags=["Фото"], summary="Список фото")
def list_images(group: Optional[str] = None, with_measurements: bool = True):
    return {"images": [service.image_view(m, with_measurements) for m in store.list(group)]}


@app.get("/api/groups", tags=["Фото"], summary="Список групп (серий)")
def list_groups():
    groups: dict[str, int] = {}
    for m in store.list():
        if m.get("group"):
            groups[m["group"]] = groups.get(m["group"], 0) + 1
    return {"groups": [{"name": k, "count": v} for k, v in sorted(groups.items())]}


@app.get("/api/images/{image_id}", tags=["Фото"])
def get_image(image_id: str):
    return service.image_view(store.get(image_id))


@app.patch("/api/images/{image_id}", tags=["Фото"], summary="Изменить группу, заметку или имя")
def patch_image(image_id: str, body: ImagePatch):
    fields = {}
    if body.group is not None:
        fields["group"] = body.group.strip() or None
    if body.note is not None:
        fields["note"] = body.note
    if body.filename:
        fields["filename"] = body.filename
    meta = store.update(image_id, **fields)
    return service.image_view(meta)


@app.delete("/api/images/{image_id}", tags=["Фото"])
def delete_image(image_id: str):
    store.delete(image_id)
    return {"deleted": image_id}


@app.get("/api/images/{image_id}/file", tags=["Фото"], summary="Фото (повёрнутое по EXIF) — в его пикселях все координаты")
def image_file(image_id: str):
    p = store.work_path(image_id)
    return FileResponse(p, media_type="image/png" if p.suffix == ".png" else "image/jpeg")


@app.get("/api/images/{image_id}/original", tags=["Фото"], summary="Исходный файл без изменений")
def image_original(image_id: str):
    meta = store.get(image_id)
    return FileResponse(store.original_path(image_id), filename=meta["filename"])


@app.get("/api/images/{image_id}/preview", tags=["Фото"], summary="Уменьшенная копия для галереи")
def image_preview(image_id: str, max_side: int = Query(800, ge=64, le=4000)):
    store.get(image_id)
    small, s = resize_max(store.load_bgr(image_id), max_side)
    return Response(encode(small, "jpg", 85), media_type="image/jpeg", headers={"X-Preview-Scale": f"{s:.6f}"})


# ---------------------------------------------------------------- эталон

@app.post("/api/images/{image_id}/detect", tags=["Эталон"], summary="Найти эталон автоматически")
def detect(image_id: str, body: DetectRequest = DetectRequest()):
    meta = service.run_detection(store, image_id, body.polarity, body.marker_size_mm, body.auto_calibrate, body.perspective)
    return service.image_view(meta)


@app.put("/api/images/{image_id}/calibration", tags=["Эталон"],
         summary="Задать эталон: 4 угла вручную, выбрать кандидата или поменять сторону эталона")
def put_calibration(image_id: str, body: CalibrationRequest):
    meta = service.set_calibration(store, image_id, body.corners, body.candidate_index, body.marker_size_mm, body.perspective)
    return service.image_view(meta)


@app.get("/api/images/{image_id}/calibration", tags=["Эталон"])
def get_calibration(image_id: str):
    return {"calibration": store.get(image_id).get("calibration")}


@app.delete("/api/images/{image_id}/calibration", tags=["Эталон"])
def delete_calibration(image_id: str):
    return service.image_view(service.reset_calibration(store, image_id))


# ---------------------------------------------------------------- измерения

@app.post("/api/images/{image_id}/measurements", tags=["Измерения"], summary="Измерить площадь обводки (и сохранить)")
def add_measurement(image_id: str, body: MeasurementRequest):
    return service.add_measurement(store, image_id, body.shape, body.points, body.ellipse, body.label, body.save)


@app.get("/api/images/{image_id}/measurements", tags=["Измерения"])
def list_measurements(image_id: str):
    return {"measurements": service.image_view(store.get(image_id))["measurements"]}


@app.patch("/api/images/{image_id}/measurements/{mid}", tags=["Измерения"], summary="Поправить точки или подпись")
def patch_measurement(image_id: str, mid: str, body: MeasurementPatch):
    return service.update_measurement(store, image_id, mid, shape=body.shape, points=body.points,
                                      ellipse=body.ellipse, label=body.label)


@app.delete("/api/images/{image_id}/measurements/{mid}", tags=["Измерения"])
def delete_measurement(image_id: str, mid: str):
    service.delete_measurement(store, image_id, mid)
    return {"deleted": mid}


@app.post("/api/images/{image_id}/autocontour", tags=["Измерения"], summary="Волшебная палочка (бета): обвести объект по клику")
def auto_contour(image_id: str, body: AutocontourRequest):
    meta = store.get(image_id)
    res = autocontour(store.load_bgr(image_id), body.point, body.tolerance, union=body.union)
    if meta.get("calibration"):
        prev = service.add_measurement(store, image_id, "polygon", res["points_px"], save=False)
        res["preview"] = {k: prev.get(k) for k in ("area_mm2", "area_cm2", "perimeter_mm", "uncertainty_pct", "method")}
    return res


# ---------------------------------------------------------------- масштаб

@app.get("/api/images/{image_id}/standardized", tags=["Общий масштаб"], summary="Фото в заданном масштабе (картинка)")
def standardized(
    image_id: str,
    px_per_mm: Optional[float] = Query(None, gt=0, description="Пикселей на мм; по умолчанию — как у фото"),
    mode: Literal["scale", "rectify"] = "scale",
    grid: bool = False,
    annotate: bool = False,
    format: Literal["jpg", "png"] = "jpg",
):
    data, info = service.standardized_image(store, image_id, px_per_mm, mode, grid, annotate, format)
    return Response(data, media_type="image/png" if format == "png" else "image/jpeg",
                    headers={"X-Px-Per-Mm": str(info["px_per_mm"])})


@app.post("/api/compare", tags=["Общий масштаб"], summary="Привести выбранные фото к одному масштабу")
def compare(body: CompareRequest):
    return service.compare(store, body.image_ids, body.group, body.px_per_mm, body.mode, body.grid, body.annotate)


# ---------------------------------------------------------------- экспорт

@app.get("/api/export.csv", tags=["Экспорт"], summary="Таблица измерений CSV (для Excel)")
def export_csv(image_ids: Optional[str] = Query(None, description="id через запятую; пусто — все"),
               group: Optional[str] = None,
               sep: Literal[";", ",", "tab"] = ";",
               decimal: Literal[",", "."] = ",",
               tz: Optional[int] = Query(None, ge=-840, le=840, description="Часовой пояс для даты: минуты от UTC (Москва — 180)")):
    rows = service.export_rows(store, _ids(image_ids), group)
    data = service.to_csv(rows, "\t" if sep == "tab" else sep, decimal, tz)
    return Response(data, media_type="text/csv; charset=utf-8",
                    headers={"Content-Disposition": 'attachment; filename="measurements.csv"'})


@app.get("/api/export.zip", tags=["Экспорт"], summary="Архив: CSV + отчёт JSON + фото в общем масштабе")
def export_zip(image_ids: Optional[str] = Query(None), group: Optional[str] = None,
               px_per_mm: Optional[float] = Query(None, gt=0), mode: Literal["scale", "rectify"] = "scale"):
    data = service.export_zip(store, _ids(image_ids), group, px_per_mm, mode)
    return Response(data, media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="onescale_report.zip"'})
