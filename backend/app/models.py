"""Модели данных (таблицы и схемы запросов).

Таблица: class Item(SQLModel, table=True) с полем id: int | None = Field(default=None, primary_key=True).
Схемы для API (что приходит в запросе): обычные классы SQLModel без table=True.
Изменили модели — увеличьте SCHEMA_VERSION в db.py.
"""

from sqlmodel import Field, SQLModel  # noqa: F401
