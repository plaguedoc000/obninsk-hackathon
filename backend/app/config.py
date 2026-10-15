"""Настройки приложения. Все секреты и ключи берутся из файла .env в корне репозитория."""

import os
from pathlib import Path

from dotenv import load_dotenv

# backend/app/config.py -> корень репозитория (на сервере это /srv/app)
ROOT_DIR = Path(__file__).resolve().parents[2]
load_dotenv(ROOT_DIR / ".env")

# Папка с базой данных. Лежит вне backend/, чтобы деплой её не затирал.
DATA_DIR = Path(os.getenv("DATA_DIR") or ROOT_DIR / "data")
DATA_DIR.mkdir(parents=True, exist_ok=True)

DATABASE_URL = f"sqlite:///{DATA_DIR / 'app.db'}"
