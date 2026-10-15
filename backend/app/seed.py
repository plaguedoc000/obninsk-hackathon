"""Демо-данные. Заполняются при первом запуске и после увеличения SCHEMA_VERSION."""

from sqlmodel import Session


def seed(session: Session) -> None:
    # Пример: session.add(Item(name="Тестовая запись"))
    session.commit()
