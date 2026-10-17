import pytest
from fastapi.testclient import TestClient

from app import config
from app.main import app
from app.routers import auth

# Флида в тестах не нужна: подменяем ответ UserInfo. Пользователь выдуманный
FAKE_USER = {"sub": "v1.test-sub", "given_name": "Иван", "family_name": "Тестов", "email": "ivan@example.com"}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(config, "FLIDA_CLIENT_ID", "test-client-id")
    monkeypatch.setattr(auth, "flida_userinfo", lambda token: FAKE_USER if token == "good-token" else None)
    return TestClient(app)


def test_login_me_logout(client):
    r = client.get("/api/auth/me")
    assert r.status_code == 200
    assert r.json() == {"user": None, "flida_client_id": "test-client-id"}

    r = client.post("/api/auth/flida", json={"access_token": "good-token"})
    assert r.status_code == 200, r.text
    assert r.json()["user"] == {"id": "v1.test-sub", "name": "Иван Тестов"}
    cookie = r.cookies.get(auth.COOKIE)
    assert cookie and "httponly" in r.headers["set-cookie"].lower()
    # в файле сессий только хэш ключа, сам ключ не хранится
    assert cookie not in auth.sessions.path.read_text(encoding="utf-8")

    assert client.get("/api/auth/me").json()["user"]["name"] == "Иван Тестов"

    assert client.post("/api/auth/logout").json() == {"user": None}
    # старый ключ после выхода больше не пускает
    client.cookies.set(auth.COOKIE, cookie)
    assert client.get("/api/auth/me").json()["user"] is None


def test_rejected_token(client):
    r = client.post("/api/auth/flida", json={"access_token": "stolen"})
    assert r.status_code == 401
    assert r.json()["detail"]["code"] == "FLIDA_TOKEN_REJECTED"
    assert auth.COOKIE not in r.cookies


def test_fake_cookie_is_not_a_session(client):
    client.cookies.set(auth.COOKIE, "made-up")
    assert client.get("/api/auth/me").json()["user"] is None


def test_not_configured(client, monkeypatch):
    monkeypatch.setattr(config, "FLIDA_CLIENT_ID", "")
    assert client.get("/api/auth/me").json()["flida_client_id"] is None
    r = client.post("/api/auth/flida", json={"access_token": "good-token"})
    assert r.status_code == 503
    assert r.json()["detail"]["code"] == "FLIDA_NOT_CONFIGURED"


@pytest.mark.parametrize("info, name", [
    ({"sub": "x", "nickname": "Тестов И."}, "Тестов И."),
    ({"sub": "x", "given_name": "Иван"}, "Иван"),
    ({"sub": "x", "email": "ivan@example.com"}, "ivan@example.com"),
    ({"sub": "x"}, "Пользователь Флида ID"),
])
def test_display_name(info, name):
    assert auth.display_name(info) == name


def test_health_still_ok(client):
    assert client.get("/api/health").json()["status"] == "ok"
