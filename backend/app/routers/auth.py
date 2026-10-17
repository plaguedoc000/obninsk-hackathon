"""Вход через Флида ID (https://docs.flida.ru/id/sdk/web).

Браузер сам получает токены через Web SDK Флиды и присылает сюда access_token.
Сервер спрашивает у Флиды, чей это токен (UserInfo), и выдаёт свою сессию в cookie.
Токены Флиды сервер не хранит, Client Secret не нужен.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from fastapi import APIRouter, Request, Response
from pydantic import BaseModel, Field

from .. import config
from ..errors import AppError
from ..sessions import Sessions

router = APIRouter(prefix="/api/auth", tags=["Вход"])
sessions = Sessions(config.DATA_DIR / "sessions.json", config.SESSION_DAYS)
COOKIE = "onescale_session"


class FlidaLogin(BaseModel):
    access_token: str = Field(..., min_length=1, max_length=4096, description="access_token из Web SDK Флиды")


def flida_userinfo(access_token: str) -> dict | None:
    """Данные пользователя от Флиды; None — Флида токен не приняла."""
    req = urllib.request.Request(config.FLIDA_USERINFO_URL, headers={
        "Authorization": f"Bearer {access_token}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            return None
        raise AppError("FLIDA_UNAVAILABLE", f"Флида ID ответил ошибкой {e.code}. Попробуйте ещё раз", 502)
    except (OSError, ValueError):
        raise AppError("FLIDA_UNAVAILABLE", "Флида ID не отвечает. Попробуйте ещё раз", 502)
    if not isinstance(data, dict) or not isinstance(data.get("sub"), str) or not data["sub"]:
        raise AppError("FLIDA_UNAVAILABLE", "Флида ID ответил непонятно. Попробуйте ещё раз", 502)
    return data


def display_name(info: dict) -> str:
    """Какие поля придут, зависит от доступов в консоли Флиды — берём первое, что есть."""
    full = " ".join(str(info[k]).strip() for k in ("given_name", "family_name") if info.get(k))
    for name in (info.get("nickname"), full, info.get("email")):
        if isinstance(name, str) and name.strip():
            return name.strip()[:100]
    return "Пользователь Флида ID"


@router.get("/me", summary="Кто вошёл (user = null — никто) и Client ID Флиды для кнопки «Войти»")
def me(request: Request):
    return {"user": sessions.get(request.cookies.get(COOKIE)), "flida_client_id": config.FLIDA_CLIENT_ID or None}


@router.post("/flida", summary="Войти: access_token из Web SDK Флиды → сессия в cookie")
def login_flida(body: FlidaLogin, request: Request, response: Response):
    if not config.FLIDA_CLIENT_ID:
        raise AppError("FLIDA_NOT_CONFIGURED", "Вход через Флида ID не настроен: заполните FLIDA_CLIENT_ID в .env", 503)
    info = flida_userinfo(body.access_token)
    if info is None:
        raise AppError("FLIDA_TOKEN_REJECTED", "Флида ID не подтвердил вход. Войдите ещё раз", 401)
    user = {"id": info["sub"], "name": display_name(info)}
    sessions.delete(request.cookies.get(COOKIE))
    response.set_cookie(COOKIE, sessions.create(user), max_age=config.SESSION_DAYS * 86400, httponly=True,
                        samesite="lax", secure=request.url.scheme == "https")
    return {"user": user}


@router.post("/logout", summary="Выйти")
def logout(request: Request, response: Response):
    sessions.delete(request.cookies.get(COOKIE))
    response.delete_cookie(COOKIE, httponly=True, samesite="lax", secure=request.url.scheme == "https")
    return {"user": None}
