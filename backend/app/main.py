from contextlib import asynccontextmanager

from fastapi import FastAPI

from . import llm
from .db import init_db
from .routers import issues, stats


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    yield


# Документация API: /api/docs
app = FastAPI(
    title="Обнинский хакатон 2026",
    docs_url="/api/docs",
    redoc_url=None,
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)

app.include_router(issues.router)
app.include_router(stats.router)


@app.get("/api/health", tags=["Служебное"])
def health() -> dict:
    return {"status": "ok", "llm": llm.provider() or "не подключён"}
