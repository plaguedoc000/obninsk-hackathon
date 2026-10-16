"""Единый формат ошибок: {"detail": {"code": "...", "message": "..."}}."""
from __future__ import annotations


class AppError(Exception):
    def __init__(self, code: str, message: str, status: int = 400, extra: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.extra = extra or {}

    def to_dict(self) -> dict:
        d = {"code": self.code, "message": self.message}
        d.update(self.extra)
        return d


def not_found(what: str, ident: str) -> AppError:
    return AppError("NOT_FOUND", f"{what} «{ident}» не найдено", 404)


def bad_input(code: str, message: str) -> AppError:
    return AppError(code, message, 422)
