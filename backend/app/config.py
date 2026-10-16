"""Настройки бэкенда. Любое значение можно переопределить переменной окружения."""
from __future__ import annotations

import os
from pathlib import Path


def _env_float(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.environ.get(name, default))
    except ValueError:
        return default


# Где хранить загруженные фото и результаты
DATA_DIR = Path(os.environ.get("ONESCALE_DATA_DIR", Path(__file__).resolve().parent.parent / "data"))

# Сторона эталонного квадрата по умолчанию, мм (по ТЗ — 1×1 см)
DEFAULT_MARKER_MM = _env_float("ONESCALE_MARKER_MM", 10.0)

# Допуск изготовления эталона, мм (входит в оценку погрешности)
MARKER_TOLERANCE_MM = _env_float("ONESCALE_MARKER_TOL_MM", 0.1)

# Точность указания углов эталона, пикселей (1 сигма)
MANUAL_CORNER_SIGMA_PX = _env_float("ONESCALE_MANUAL_SIGMA_PX", 1.0)
MIN_AUTO_CORNER_SIGMA_PX = 0.3

# Когда включать исправление перспективы в режиме "auto":
# если противоположные стороны эталона отличаются больше чем на эту долю
# (эталон выглядит трапецией, а не параллелограммом)
TILT_SIDE_RATIO = _env_float("ONESCALE_TILT_SIDE_RATIO", 0.08)

# Предупреждения
SMALL_MARKER_PX = _env_float("ONESCALE_SMALL_MARKER_PX", 60.0)       # эталон мелкий
STRONG_TILT_DEG = _env_float("ONESCALE_STRONG_TILT_DEG", 12.0)       # заметный наклон камеры
NOT_SQUARE_RATIO = _env_float("ONESCALE_NOT_SQUARE_RATIO", 0.06)     # эталон не квадратный
FAR_FROM_MARKER_SIDES = _env_float("ONESCALE_FAR_SIDES", 12.0)       # объект далеко от эталона

# Поиск эталона: максимальная сторона уменьшенной копии
DETECT_MAX_SIDE = _env_int("ONESCALE_DETECT_MAX_SIDE", 1600)
DETECT_MAX_CANDIDATES = _env_int("ONESCALE_DETECT_MAX_CANDIDATES", 5)

# Ограничения на загрузку
MAX_UPLOAD_MB = _env_float("ONESCALE_MAX_UPLOAD_MB", 60.0)
MAX_IMAGE_PIXELS = _env_int("ONESCALE_MAX_IMAGE_PIXELS", 120_000_000)

# Сколько фото держать в памяти для быстрой работы (на маленьком сервере — меньше)
CACHE_IMAGES = max(1, _env_int("ONESCALE_CACHE_IMAGES", 6))

# Приведение к масштабу: ограничение размера выходной картинки
MAX_OUTPUT_SIDE = _env_int("ONESCALE_MAX_OUTPUT_SIDE", 8000)

ALLOWED_EXTENSIONS = {".jpg", ".jpeg", ".png", ".tif", ".tiff", ".bmp", ".webp", ".heic", ".heif"}
