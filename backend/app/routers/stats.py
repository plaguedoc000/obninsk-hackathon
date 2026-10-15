from fastapi import APIRouter
from sqlmodel import SQLModel, func, select

from ..db import SessionDep
from ..models import Issue

router = APIRouter(prefix="/api/stats", tags=["Аналитика"])


class CountItem(SQLModel):
    name: str
    count: int


class Stats(SQLModel):
    total: int
    by_category: list[CountItem]
    by_status: list[CountItem]


@router.get("")
def get_stats(session: SessionDep) -> Stats:
    def count_by(column) -> list[CountItem]:
        rows = session.exec(select(column, func.count()).group_by(column)).all()
        return [CountItem(name=name, count=count) for name, count in rows]

    return Stats(
        total=session.exec(select(func.count()).select_from(Issue)).one(),
        by_category=count_by(Issue.category),
        by_status=count_by(Issue.status),
    )
