@echo off
rem Запуск бэкенда на Windows: двойной клик или run.bat в консоли
cd /d %~dp0
if not exist .venv (
  python -m venv .venv
  .venv\Scripts\pip install -r requirements.txt
)
.venv\Scripts\uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
