"""Сессии входа: data/sessions.json. База данных не нужна.

Ключ сессии живёт только в cookie браузера, в файле — его SHA-256,
поэтому по копии файла войти чужим именем нельзя.
"""
from __future__ import annotations

import hashlib
import json
import os
import secrets
import threading
import time
from pathlib import Path


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Sessions:
    def __init__(self, path: Path, days: int):
        self.path = Path(path)
        self.ttl = days * 86400
        self._lock = threading.Lock()
        self._items: dict[str, dict] = {}
        try:
            self._items = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass

    def _save(self) -> None:
        now = time.time()
        self._items = {k: v for k, v in self._items.items() if v.get("expires", 0) > now}
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._items, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, self.path)

    def create(self, user: dict) -> str:
        token = secrets.token_urlsafe(32)
        with self._lock:
            self._items[_hash(token)] = {"user": user, "expires": time.time() + self.ttl}
            self._save()
        return token

    def get(self, token: str | None) -> dict | None:
        if not token:
            return None
        item = self._items.get(_hash(token))
        if not item or item.get("expires", 0) <= time.time():
            return None
        return item["user"]

    def delete(self, token: str | None) -> None:
        if not token:
            return
        with self._lock:
            if self._items.pop(_hash(token), None) is not None:
                self._save()
