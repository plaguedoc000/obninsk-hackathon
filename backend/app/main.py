from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import llm
from .db import init_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


# Документация API: /api/docs
app = FastAPI(
    title="API",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

# Новые разделы API: файл в routers/ с APIRouter(prefix="/api/..."), затем app.include_router(...)


# Деплой проверяет этот адрес после выкладки — не удалять
@app.get("/api/health", tags=["Служебное"])
def health() -> dict:
    return {"status": "ok", "llm": llm.provider() or "не подключён"}
