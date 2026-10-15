"""Модели данных. Пример — обращения жителей. Замените на сущности своего кейса."""

from datetime import datetime, timezone
from typing import Literal

from sqlmodel import Field, SQLModel

Status = Literal["new", "in_progress", "done"]

CATEGORIES = ["Дороги", "ЖКХ", "Благоустройство", "Экология", "Транспорт", "Другое"]


class IssueBase(SQLModel):
    title: str = Field(min_length=3, max_length=200)
    description: str = Field(default="", max_length=5000)
    category: str = Field(default="Другое", max_length=50)
    lat: float | None = None
    lng: float | None = None


class Issue(IssueBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    status: str = Field(default="new")
    ai_comment: str | None = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class IssueCreate(IssueBase):
    pass


class IssueUpdate(SQLModel):
    title: str | None = Field(default=None, min_length=3, max_length=200)
    description: str | None = Field(default=None, max_length=5000)
    category: str | None = Field(default=None, max_length=50)
    status: Status | None = None
