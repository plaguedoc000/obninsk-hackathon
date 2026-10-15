"""Демо-данные. Заполняются при первом запуске и после увеличения SCHEMA_VERSION."""

from sqlmodel import Session

from .models import Issue

DEMO_ISSUES = [
    dict(
        title="Яма на проспекте Ленина",
        description="Глубокая яма у остановки, машины объезжают по встречной.",
        category="Дороги",
        lat=55.1003,
        lng=36.6098,
        status="in_progress",
    ),
    dict(
        title="Не горят фонари в сквере",
        description="Вечером в сквере полностью темно уже неделю.",
        category="Благоустройство",
        lat=55.0952,
        lng=36.6151,
    ),
    dict(
        title="Переполнены мусорные контейнеры",
        description="Контейнеры во дворе не вывозили с понедельника.",
        category="ЖКХ",
        lat=55.0921,
        lng=36.6040,
    ),
    dict(
        title="Сломана скамейка в парке",
        description="У главной аллеи сломана спинка скамейки.",
        category="Благоустройство",
        lat=55.1088,
        lng=36.6012,
        status="done",
    ),
    dict(
        title="Автобус ходит с большими интервалами",
        description="Утром автобус приходит раз в 40 минут вместо 15.",
        category="Транспорт",
        lat=55.0985,
        lng=36.6220,
    ),
    dict(
        title="Свалка у реки",
        description="На берегу Протвы оставили строительный мусор.",
        category="Экология",
        lat=55.1120,
        lng=36.6205,
    ),
]


def seed(session: Session) -> None:
    for item in DEMO_ISSUES:
        session.add(Issue(**item))
    session.commit()
