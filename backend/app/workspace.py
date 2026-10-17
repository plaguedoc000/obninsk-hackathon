"""Чьи фото: у каждого браузера свой секретный ключ в cookie, фото на сервере привязаны к его хэшу.

Ключ создаёт сам сайт (frontend/src/lib/workspace.ts) и хранит в localStorage. Если запрос пришёл без ключа
(например, из /api/docs), сервер выдаёт новый. Чужие фото для владельца ключа как будто не существуют: 404.
"""
from __future__ import annotations

import hashlib
import re
import secrets

from fastapi import Request

from .errors import AppError, not_found
from .storage import Store

COOKIE = "onescale_ws"
_VALID = re.compile(r"[A-Za-z0-9_-]{32,128}")


def owner_id(key: str) -> str:
    """В фото хранится только хэш ключа: по файлам на сервере чужой ключ не узнать."""
    return hashlib.sha256(key.encode()).hexdigest()[:32]


async def workspace_cookie(request: Request, call_next):
    key = request.cookies.get(COOKIE)
    new = not (key and _VALID.fullmatch(key))
    if new:
        key = secrets.token_urlsafe(32)
    request.state.owner = owner_id(key)
    response = await call_next(request)
    if new:
        # не HttpOnly: сайт сам кладёт этот же ключ из localStorage, а поверх HttpOnly-cookie браузер ему писать не даст
        response.set_cookie(COOKIE, key, max_age=365 * 86400, samesite="lax", secure=request.url.scheme == "https")
    return response


class OwnedStore:
    """Хранилище глазами одного владельца. Методы с image_id сначала проверяют, что фото его."""

    _BY_ID = {"update", "delete", "load_bgr", "work_path", "original_path", "cache_dir", "clear_cache"}

    def __init__(self, store: Store, owner: str, max_images: int):
        self.store = store
        self.owner = owner
        self.max_images = max_images

    def get(self, image_id: str) -> dict:
        m = self.store.get(image_id)
        if m.get("owner") != self.owner:
            raise not_found("Фото", image_id)
        return m

    def list(self, group: str | None = None) -> list[dict]:
        return [m for m in self.store.list(group) if m.get("owner") == self.owner]

    def save(self, meta: dict) -> None:
        self.get(meta["id"])
        self.store.save(meta)

    def add_image(self, filename: str, data: bytes, group: str | None = None):
        if len(self.list()) >= self.max_images:
            raise AppError("TOO_MANY_IMAGES", f"Больше {self.max_images} фото загрузить нельзя — удалите ненужные", 429)
        return self.store.add_image(filename, data, group=group, owner=self.owner)

    def claim(self, group: str) -> int:
        """Фото, загруженные до появления ключей, лежат без владельца в группе браузера — забираем их себе."""
        n = 0
        for m in self.store.list(group):
            if m.get("owner") is None:
                m["owner"] = self.owner
                self.store.save(m)
                n += 1
        return n

    def __getattr__(self, name: str):
        attr = getattr(self.store, name)
        if name not in self._BY_ID:
            return attr

        def checked(image_id: str, *args, **kwargs):
            self.get(image_id)
            return attr(image_id, *args, **kwargs)

        return checked
