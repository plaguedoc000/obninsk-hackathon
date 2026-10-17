"""Хранение фото и результатов: папка на диске + JSON на каждое фото. База данных не нужна.

data/images/<id>/
    original.<ext>   — исходный файл как загружен (никогда не меняется)
    image.jpg|png    — рабочая копия, повернутая по EXIF (все координаты — в ней)
    meta.json        — калибровка, обводки, подписи
    cache/           — приведённые к масштабу картинки
"""
from __future__ import annotations

import json
import os
import shutil
import threading
import uuid
from collections import OrderedDict
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np

from . import config
from .errors import AppError, not_found
from .imaging import decode_upload, encode


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def new_id() -> str:
    return uuid.uuid4().hex[:12]


class Store:
    def __init__(self, root: Path):
        self.root = Path(root)
        self.images_dir = self.root / "images"
        self.images_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._meta: dict[str, dict] = {}
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()
        self._load_all()

    # ------------------------------------------------------------ служебное
    def _load_all(self) -> None:
        for d in sorted(self.images_dir.iterdir()):
            mf = d / "meta.json"
            if mf.is_file():
                try:
                    self._meta[d.name] = json.loads(mf.read_text(encoding="utf-8"))
                except Exception:
                    continue

    def _dir(self, image_id: str) -> Path:
        return self.images_dir / image_id

    def _write_meta(self, meta: dict) -> None:
        d = self._dir(meta["id"])
        tmp = d / "meta.json.tmp"
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, d / "meta.json")

    # ------------------------------------------------------------ фото
    def add_image(self, filename: str, data: bytes, group: str | None = None) -> tuple[dict, np.ndarray]:
        if len(data) == 0:
            raise AppError("EMPTY_FILE", f"Файл «{filename}» пустой", 422)
        if len(data) > config.MAX_UPLOAD_MB * 1024 * 1024:
            raise AppError("FILE_TOO_LARGE", f"Файл «{filename}» больше {config.MAX_UPLOAD_MB:.0f} МБ", 413)
        ext = Path(filename).suffix.lower()
        if ext and ext not in config.ALLOWED_EXTENSIONS:
            raise AppError("BAD_FILE_TYPE", f"Файл «{filename}»: формат {ext} не поддерживается", 415)
        bgr, info = decode_upload(data)
        h, w = bgr.shape[:2]
        image_id = new_id()
        d = self._dir(image_id)
        d.mkdir(parents=True)
        (d / f"original{ext or '.bin'}").write_bytes(data)
        lossless = info["format"] in ("PNG", "TIFF", "BMP")
        work_name = "image.png" if lossless else "image.jpg"
        (d / work_name).write_bytes(encode(bgr, "png" if lossless else "jpg", quality=95))
        meta = {
            "id": image_id,
            "filename": filename,
            "original_file": f"original{ext or '.bin'}",
            "work_file": work_name,
            "width": w,
            "height": h,
            "size_bytes": len(data),
            "format": info["format"],
            "rotated_by_exif": info["rotated_by_exif"],
            "focal35_mm": info.get("focal35_mm"),
            "created_at": now_iso(),
            "group": group or None,
            "note": None,
            "detection": None,
            "calibration": None,
            "measurements": [],
        }
        with self._lock:
            self._write_meta(meta)
            self._meta[image_id] = meta
            self._remember(image_id, bgr)
        return meta, bgr

    def _remember(self, image_id: str, bgr: np.ndarray) -> None:
        self._cache[image_id] = bgr
        self._cache.move_to_end(image_id)
        while len(self._cache) > config.CACHE_IMAGES:
            self._cache.popitem(last=False)

    def get(self, image_id: str) -> dict:
        with self._lock:
            m = self._meta.get(image_id)
            if m is None:
                raise not_found("Фото", image_id)
            return m

    def list(self, group: str | None = None) -> list[dict]:
        with self._lock:
            items = list(self._meta.values())
        if group:
            items = [m for m in items if m.get("group") == group]
        return sorted(items, key=lambda m: m["created_at"])

    def update(self, image_id: str, **fields) -> dict:
        with self._lock:
            m = self.get(image_id)
            m.update(fields)
            self._write_meta(m)
            return m

    def save(self, meta: dict) -> None:
        with self._lock:
            self._write_meta(meta)
            self._meta[meta["id"]] = meta

    def delete(self, image_id: str) -> None:
        with self._lock:
            self.get(image_id)
            shutil.rmtree(self._dir(image_id), ignore_errors=True)
            self._meta.pop(image_id, None)
            self._cache.pop(image_id, None)

    def load_bgr(self, image_id: str) -> np.ndarray:
        with self._lock:
            if image_id in self._cache:
                self._cache.move_to_end(image_id)
                return self._cache[image_id]
            m = self.get(image_id)
        bgr = cv2.imread(str(self._dir(image_id) / m["work_file"]), cv2.IMREAD_COLOR)
        if bgr is None:
            raise AppError("FILE_MISSING", "Файл фото повреждён или удалён", 500)
        with self._lock:
            self._remember(image_id, bgr)
        return bgr

    def work_path(self, image_id: str) -> Path:
        return self._dir(image_id) / self.get(image_id)["work_file"]

    def original_path(self, image_id: str) -> Path:
        return self._dir(image_id) / self.get(image_id)["original_file"]

    def cache_dir(self, image_id: str) -> Path:
        p = self._dir(image_id) / "cache"
        p.mkdir(exist_ok=True)
        return p

    def clear_cache(self, image_id: str) -> None:
        shutil.rmtree(self._dir(image_id) / "cache", ignore_errors=True)
