"""Подключение к SQLite.

Миграций нет. Если поменяли модели в models.py, увеличьте SCHEMA_VERSION:
при следующем запуске таблицы пересоздадутся и заполнятся из seed.py.
"""

from typing import Annotated, Iterator

from fastapi import Depends
from sqlalchemy import MetaData, text
from sqlmodel import Session, SQLModel, create_engine

from .config import DATABASE_URL

SCHEMA_VERSION = 2

engine = create_engine(DATABASE_URL, connect_args={"check_same_thread": False})


def init_db() -> None:
    from . import models  # noqa: F401  регистрирует таблицы
    from .seed import seed

    with engine.connect() as conn:
        current = conn.execute(text("PRAGMA user_version")).scalar()

    if current != SCHEMA_VERSION:
        # Удаляем все таблицы в базе, включая те, чьих моделей уже нет
        existing = MetaData()
        existing.reflect(engine)
        existing.drop_all(engine)
        SQLModel.metadata.create_all(engine)
        with engine.begin() as conn:
            conn.execute(text(f"PRAGMA user_version = {SCHEMA_VERSION}"))
        with Session(engine) as session:
            seed(session)
    else:
        SQLModel.metadata.create_all(engine)


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_session)]
