import os
import tempfile

import pytest
from fastapi.testclient import TestClient

# Тесты работают с временной базой и без нейросети
os.environ["DATA_DIR"] = tempfile.mkdtemp()
os.environ["LLM_PROVIDER"] = ""

from app.main import app  # noqa: E402


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
