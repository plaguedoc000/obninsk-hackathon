"""Безопасность: чужие фото не видны, большие запросы и «бомбы» отклоняются, координаты съёмки не хранятся."""
import io

import numpy as np
import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from PIL import Image

from app import service
from app.imaging import strip_gps
from app.main import BodyLimit, app, raw_store
from app.workspace import COOKIE, owner_id


def jpeg(color=(200, 60, 60), size=(320, 240), gps=False, focal=None) -> bytes:
    im = Image.new("RGB", size, color)
    exif = Image.Exif()
    if gps:
        exif[0x8825] = {1: "N", 2: (55.0, 6.0, 30.5), 3: "E", 4: (36.0, 36.0, 10.0)}
    if focal:
        exif[0x8769] = {0xA405: focal}
    buf = io.BytesIO()
    im.save(buf, "JPEG", exif=exif.tobytes())
    return buf.getvalue()


def upload(client, name="a.jpg", data=None, **form):
    r = client.post("/api/images", files=[("files", (name, data or jpeg(), "image/jpeg"))], data={"detect": "false", **form})
    assert r.status_code == 200, r.text
    return r.json()["images"][0]


@pytest.fixture
def alice():
    return TestClient(app)


@pytest.fixture
def bob():
    return TestClient(app)


def test_other_browser_cannot_see_or_touch_photos(alice, bob):
    a = upload(alice, "alice.jpg", group="серия Алисы")
    upload(bob, "bob.jpg")
    ids = {m["id"] for m in bob.get("/api/images").json()["images"]}
    assert a["id"] not in ids and len(ids) == 1
    assert "серия Алисы" not in {g["name"] for g in bob.get("/api/groups").json()["groups"]}
    for path in ["", "/file", "/original", "/preview", "/calibration", "/measurements"]:
        assert bob.get(f"/api/images/{a['id']}{path}").status_code == 404, path
    assert bob.patch(f"/api/images/{a['id']}", json={"note": "взлом"}).status_code == 404
    assert bob.delete(f"/api/images/{a['id']}").status_code == 404
    assert bob.post(f"/api/images/{a['id']}/measurements", json={"points": [[1, 1], [9, 1], [9, 9]]}).status_code == 404
    assert bob.post("/api/compare", json={"image_ids": [a["id"]]}).status_code == 404
    assert bob.get("/api/export.csv", params={"image_ids": a["id"]}).status_code == 404
    # «выгрузить всё» — только своё
    assert "alice.jpg" not in bob.get("/api/export.csv").content.decode("utf-8-sig")
    # у Алисы всё на месте
    assert alice.get(f"/api/images/{a['id']}").json()["note"] is None


def test_workspace_cookie_is_issued_and_only_its_hash_is_stored(alice):
    r = alice.get("/api/health")
    key = r.cookies.get(COOKIE)
    assert key and len(key) >= 32
    v = upload(alice)
    meta = raw_store.get(v["id"])
    assert meta["owner"] == owner_id(key) and key not in str(meta)
    # тот же ключ — та же папка; поддельный короткий ключ заменяется новым
    assert alice.get("/api/health").cookies.get(COOKIE) is None
    alice.cookies.set(COOKIE, "x")
    assert alice.get("/api/health").cookies.get(COOKIE) not in (None, "x")


def test_claim_legacy_photos_once(alice, bob):
    # фото, загруженное до появления ключей: без владельца, в группе браузера
    meta, _ = raw_store.add_image("old.jpg", jpeg(), group="сессия-старая")
    assert alice.post("/api/workspace/claim", json={"group": "сессия-старая"}).json() == {"claimed": 1}
    assert meta["id"] in {m["id"] for m in alice.get("/api/images").json()["images"]}
    # второй раз чужое уже не забрать
    assert bob.post("/api/workspace/claim", json={"group": "сессия-старая"}).json() == {"claimed": 0}
    assert bob.get(f"/api/images/{meta['id']}").status_code == 404


def test_gps_is_removed_but_photo_and_focal_stay(alice):
    data = jpeg(gps=True, focal=28)
    assert Image.open(io.BytesIO(data)).getexif().get_ifd(0x8825)
    v = upload(alice, "gps.jpg", data)
    original = alice.get(f"/api/images/{v['id']}/original").content
    im = Image.open(io.BytesIO(original))
    assert not im.getexif().get_ifd(0x8825)
    assert im.getexif().get_ifd(0x8769).get(0xA405) == 28
    assert len(original) == len(data) and im.tobytes() == Image.open(io.BytesIO(data)).tobytes()


def test_strip_gps_survives_garbage():
    for junk in [b"", b"\xff\xd8", b"\xff\xd8\xff\xe1\x00\x08Exif\x00\x00", b"II*\x00\xff\xff\xff\xff", b"hello"]:
        assert len(strip_gps(junk)) == len(junk)


def test_decompression_bomb_is_rejected_before_decoding(alice):
    # 56 Мп одним цветом — в PNG несколько килобайт, а в памяти было бы ~170 МБ
    buf = io.BytesIO()
    Image.new("1", (8000, 7000)).save(buf, "PNG")
    assert len(buf.getvalue()) < 200_000
    r = alice.post("/api/images", files=[("files", ("bomb.png", buf.getvalue(), "image/png"))])
    assert r.status_code == 413 and r.json()["detail"]["errors"][0]["code"] == "IMAGE_TOO_LARGE"


def test_body_limit():
    mini = FastAPI()

    @mini.post("/echo")
    async def echo(request: Request):
        return {"n": len(await request.body())}

    client = TestClient(BodyLimit(mini, max_bytes=1000))
    assert client.post("/echo", content=b"x" * 1000).json() == {"n": 1000}
    r = client.post("/echo", content=b"x" * 1001)
    assert r.status_code == 413 and r.json()["detail"]["code"] == "REQUEST_TOO_LARGE"
    # без Content-Length (поток кусками) — тоже не дочитывается
    with pytest.raises(Exception):
        client.post("/echo", content=(b"x" * 600 for _ in range(3)))


def test_too_many_photos_per_browser(alice, monkeypatch):
    monkeypatch.setattr("app.config.MAX_IMAGES_PER_WORKSPACE", 1)
    upload(alice)
    r = alice.post("/api/images", files=[("files", ("b.jpg", jpeg(), "image/jpeg"))], data={"detect": "false"})
    assert r.status_code == 429 and r.json()["detail"]["errors"][0]["code"] == "TOO_MANY_IMAGES"


def test_filenames_are_cleaned_and_csv_formulas_escaped(alice):
    v = upload(alice, "../../etc/evil.jpg")
    assert v["filename"] == "evil.jpg"
    p = alice.patch(f"/api/images/{v['id']}", json={"filename": "=HYPERLINK(\"http://x\")\\..\\a.jpg"}).json()
    assert p["filename"] == "a.jpg"
    alice.patch(f"/api/images/{v['id']}", json={"filename": "=HYPERLINK(1).jpg"})
    alice.put(f"/api/images/{v['id']}/calibration", json={"corners": [[10, 10], [60, 10], [60, 60], [10, 60]]})
    alice.post(f"/api/images/{v['id']}/measurements", json={"points": [[100, 100], [200, 100], [200, 200]]})
    csv = alice.get("/api/export.csv", params={"image_ids": v["id"]}).content.decode("utf-8-sig")
    assert "'=HYPERLINK(1).jpg" in csv


def test_original_type_does_not_follow_renamed_filename(alice):
    v = upload(alice)
    alice.patch(f"/api/images/{v['id']}", json={"filename": "page.html"})
    r = alice.get(f"/api/images/{v['id']}/original")
    assert r.headers["content-type"] == "image/jpeg" and "attachment" in r.headers["content-disposition"]


def test_no_cors_for_other_sites(alice):
    r = alice.options("/api/images/x", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "DELETE"})
    assert "access-control-allow-origin" not in r.headers


def test_health_does_not_leak_photo_count(alice):
    assert "images" not in alice.get("/api/health").json()


def test_internal_errors_do_not_leak_details(alice, monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("/srv/app/data секретный путь")

    client = TestClient(app, raise_server_exceptions=False)
    upload(client)
    monkeypatch.setattr(service, "image_view", boom)
    r = client.get("/api/images")
    assert r.status_code == 500 and "секретный" not in r.text


def test_raw_ids_of_others_still_404_after_random_guess(alice):
    assert alice.get(f"/api/images/{np.random.default_rng(0).integers(1 << 40):012x}").status_code == 404
