import csv
import io
import zipfile

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import app
from tests.synth import rect_corners, render

client = TestClient(app)
DARK = (40, 45, 60)
PAPER = (232, 236, 236)


def jpeg_bytes(bgr, exif_orientation=None, quality=95):
    im = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
    buf = io.BytesIO()
    if exif_orientation:
        exif = Image.Exif()
        exif[0x0112] = exif_orientation
        im.save(buf, "JPEG", quality=quality, exif=exif.tobytes())
    else:
        im.save(buf, "JPEG", quality=quality)
    return buf.getvalue()


def scene(ppmm, w_mm=30, h_mm=40, size=(1600, 1200)):
    m = rect_corners(250, 250, 10 * ppmm, 10 * ppmm, 7)
    obj = rect_corners(250 + 10 * ppmm + 25 * ppmm, 250 + 20 * ppmm, w_mm * ppmm, h_mm * ppmm, 0)
    return render(size=size, shapes=[(m, DARK), (obj, PAPER)], noise=1.5), m, obj


def upload(name, data, **form):
    r = client.post("/api/images", files=[("files", (name, data, "image/jpeg"))], data=form)
    assert r.status_code == 200, r.text
    return r.json()["images"][0]


def test_full_flow_two_scales_same_object():
    a_img, _, a_obj = scene(6.0)
    b_img, _, b_obj = scene(12.0, size=(2000, 1500))
    a = upload("near.jpg", jpeg_bytes(a_img), group="flow")
    b = upload("far.png", cv2.imencode(".png", b_img)[1].tobytes(), group="flow")
    assert a["status"] == "calibrated" and b["status"] == "calibrated"
    assert a["calibration"]["px_per_mm"] == pytest.approx(6.0, rel=0.01)
    assert b["calibration"]["px_per_mm"] == pytest.approx(12.0, rel=0.01)

    ra = client.post(f"/api/images/{a['id']}/measurements", json={"points": a_obj.tolist(), "label": "A"}).json()
    rb = client.post(f"/api/images/{b['id']}/measurements", json={"points": b_obj.tolist(), "label": "B"}).json()
    assert ra["area_mm2"] == pytest.approx(1200, rel=0.015)
    assert rb["area_mm2"] == pytest.approx(1200, rel=0.015)

    cmp = client.post("/api/compare", json={"group": "flow"}).json()
    assert cmp["px_per_mm"] == pytest.approx(min(a["calibration"]["px_per_mm"], b["calibration"]["px_per_mm"]), rel=1e-3)
    sides = []
    for it in cmp["items"]:
        mk = np.array(it["marker_corners_out"])
        sides.append(np.linalg.norm(mk[1] - mk[0]))
        r = client.get(it["url"])
        assert r.status_code == 200 and r.headers["content-type"] == "image/jpeg"
        img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        assert [img.shape[1], img.shape[0]] == it["output_size"]
    # эталон на обоих приведённых фото одного размера
    assert sides[0] == pytest.approx(sides[1], rel=0.01)

    rr = client.post("/api/compare", json={"image_ids": [a["id"], b["id"]], "mode": "rectify"})
    assert rr.status_code == 200

    csv_resp = client.get("/api/export.csv", params={"group": "flow"})
    rows = list(csv.reader(io.StringIO(csv_resp.content.decode("utf-8-sig")), delimiter=";"))
    assert len(rows) == 3 and rows[0][0] == "Файл"
    z = zipfile.ZipFile(io.BytesIO(client.get("/api/export.zip", params={"group": "flow"}).content))
    names = z.namelist()
    assert "measurements.csv" in names and "report.json" in names
    assert sum(n.startswith("standardized/") for n in names) == 2


def test_exif_rotation_and_coordinates():
    img, m, obj = scene(8.0)
    # кладём «лежащую на боку» картинку и EXIF=6 (повернуть на 90° по часовой)
    raw = cv2.rotate(img, cv2.ROTATE_90_COUNTERCLOCKWISE)
    v = upload("phone.jpg", jpeg_bytes(raw, exif_orientation=6))
    assert v["rotated_by_exif"] is True
    assert (v["width"], v["height"]) == (1600, 1200)
    corners = np.array(v["calibration"]["corners_px"])
    assert np.allclose(corners.mean(axis=0), m.mean(axis=0), atol=1.0)


def test_manual_calibration_marker_size_and_preview():
    img, m, obj = scene(5.0)
    v = upload("manual.jpg", jpeg_bytes(img), detect="false")
    assert v["status"] == "uploaded"
    r = client.post(f"/api/images/{v['id']}/measurements", json={"points": obj.tolist(), "save": False}).json()
    assert r["area_mm2"] is None and r["warnings"][0]["code"] == "NOT_CALIBRATED"
    r = client.put(f"/api/images/{v['id']}/calibration", json={"corners": m.tolist()[::-1]})
    assert r.status_code == 200 and r.json()["calibration"]["method"] == "manual"
    pv = client.post(f"/api/images/{v['id']}/measurements", json={"points": obj.tolist(), "save": False}).json()
    assert pv["saved"] is False and pv["area_mm2"] == pytest.approx(1200, rel=1e-6)
    assert client.get(f"/api/images/{v['id']}").json()["measurements_count"] == 0
    client.post(f"/api/images/{v['id']}/measurements", json={"points": obj.tolist()})
    r = client.put(f"/api/images/{v['id']}/calibration", json={"marker_size_mm": 20})
    assert r.json()["measurements"][0]["area_mm2"] == pytest.approx(4800, rel=1e-4)


def test_measurement_edit_and_delete():
    img, m, obj = scene(6.0)
    v = upload("edit.jpg", jpeg_bytes(img))
    mm = client.post(f"/api/images/{v['id']}/measurements", json={"points": obj.tolist(), "label": "x"}).json()
    p = client.patch(f"/api/images/{v['id']}/measurements/{mm['id']}", json={"label": "Образец 1"}).json()
    assert p["label"] == "Образец 1"
    circ = client.patch(f"/api/images/{v['id']}/measurements/{mm['id']}",
                        json={"shape": "circle", "points": [obj.mean(axis=0).tolist(), (obj.mean(axis=0) + [60, 0]).tolist()]}).json()
    assert circ["area_mm2"] == pytest.approx(np.pi * 100, rel=0.02)
    assert client.delete(f"/api/images/{v['id']}/measurements/{mm['id']}").status_code == 200
    assert client.delete(f"/api/images/{v['id']}/measurements/{mm['id']}").status_code == 404


def test_errors_are_readable():
    r = client.post("/api/images", files=[("files", ("x.txt", b"hello", "text/plain"))])
    assert r.status_code == 415 and r.json()["detail"]["code"] == "UPLOAD_FAILED"
    r = client.post("/api/images", files=[("files", ("x.jpg", b"notajpeg", "image/jpeg"))])
    assert r.status_code == 415
    assert client.get("/api/images/doesnotexist").status_code == 404
    img, m, obj = scene(6.0)
    v = upload("err.jpg", jpeg_bytes(img), detect="false")
    r = client.post("/api/compare", json={"image_ids": [v["id"]]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "NOT_CALIBRATED"
    r = client.post(f"/api/images/{v['id']}/measurements", json={"points": [[0, 0], [99999, 0], [0, 5]]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "OUTSIDE_IMAGE"
    r = client.put(f"/api/images/{v['id']}/calibration", json={"corners": [[0, 0], [1, 1]]})
    assert r.status_code == 422


def test_autocontour_finds_paper_rectangle():
    img, m, obj = scene(6.0)
    v = upload("auto.jpg", jpeg_bytes(img))
    r = client.post(f"/api/images/{v['id']}/autocontour", json={"point": obj.mean(axis=0).tolist()}).json()
    assert r["preview"]["area_mm2"] == pytest.approx(1200, rel=0.03)


def test_groups_and_patch():
    img, _, _ = scene(6.0)
    v = upload("g.jpg", jpeg_bytes(img))
    client.patch(f"/api/images/{v['id']}", json={"group": "Эксперимент 1", "note": "контроль"})
    groups = {g["name"]: g["count"] for g in client.get("/api/groups").json()["groups"]}
    assert groups.get("Эксперимент 1") == 1
