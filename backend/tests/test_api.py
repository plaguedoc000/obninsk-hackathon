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
    b = upload("far.jpg", jpeg_bytes(b_img), group="flow")
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


def test_upload_limit_1mb():
    # сайт сжимает фото до 1 МБ сам, сервер крупнее не принимает
    img, _, _ = scene(12.0, size=(2000, 1500))
    big = cv2.imencode(".png", img)[1].tobytes()
    assert len(big) > 1024 * 1024
    r = client.post("/api/images", files=[("files", ("big.png", big, "image/png"))])
    assert r.status_code == 413 and r.json()["detail"]["errors"][0]["code"] == "FILE_TOO_LARGE"
    small = upload("small.png", cv2.imencode(".png", img[:500, :700])[1].tobytes())
    assert small["format"] == "PNG" and small["width"] == 700


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


def test_csv_has_only_six_columns_and_local_date():
    img, _, obj = scene(6.0)
    v = upload("csv.jpg", jpeg_bytes(img), group="csv6")
    client.post(f"/api/images/{v['id']}/measurements", json={"points": obj.tolist()})
    r = client.get("/api/export.csv", params={"image_ids": v["id"], "tz": 180})
    rows = list(csv.reader(io.StringIO(r.content.decode("utf-8-sig")), delimiter=";"))
    assert rows[0] == ["Файл", "Площадь, мм²", "Площадь, см²", "Периметр, мм", "Масштаб, пикс/мм", "Дата"]
    name, mm2, cm2, perim, ppm, date = rows[1]
    assert name == "csv.jpg"
    assert float(mm2.replace(",", ".")) == pytest.approx(1200, rel=0.015)
    assert float(cm2.replace(",", ".")) == pytest.approx(12, rel=0.015)
    assert float(perim.replace(",", ".")) == pytest.approx(140, rel=0.015)
    assert float(ppm.replace(",", ".")) == pytest.approx(6, rel=0.01)
    assert len(date) == 16 and date[2] == "." and date[5] == "." and date[13] == ":"  # 16.10.2026 21:24


def test_autocontour_union_merges_touching_regions():
    """Shift+клик «Авто»: новая заливка объединяется с уже выделенной областью."""
    ppm = 6.0
    m = rect_corners(250, 250, 10 * ppm, 10 * ppm, 0)
    left = rect_corners(700, 600, 30 * ppm, 40 * ppm, 0)  # 30×40 мм
    right = rect_corners(700 + 30 * ppm, 600, 30 * ppm, 40 * ppm, 0)  # вплотную справа, другого цвета
    img = render(shapes=[(m, DARK), (left, PAPER), (right, (90, 160, 90))], noise=1.5)
    v = upload("union.jpg", jpeg_bytes(img))
    a = client.post(f"/api/images/{v['id']}/autocontour", json={"point": left.mean(axis=0).tolist()}).json()
    assert a["preview"]["area_mm2"] == pytest.approx(1200, rel=0.04)
    b = client.post(f"/api/images/{v['id']}/autocontour",
                    json={"point": right.mean(axis=0).tolist(), "union": [a["points_px"]]}).json()
    assert len(b["contours_px"]) == 1
    assert b["preview"]["area_mm2"] == pytest.approx(2400, rel=0.04)


def test_autocontour_union_keeps_separate_parts():
    ppm = 6.0
    m = rect_corners(250, 250, 10 * ppm, 10 * ppm, 0)
    a_obj = rect_corners(600, 600, 30 * ppm, 30 * ppm, 0)
    b_obj = rect_corners(1200, 700, 20 * ppm, 20 * ppm, 0)
    img = render(shapes=[(m, DARK), (a_obj, PAPER), (b_obj, PAPER)], noise=1.5)
    v = upload("parts.jpg", jpeg_bytes(img))
    a = client.post(f"/api/images/{v['id']}/autocontour", json={"point": a_obj.mean(axis=0).tolist()}).json()
    b = client.post(f"/api/images/{v['id']}/autocontour",
                    json={"point": b_obj.mean(axis=0).tolist(), "union": [a["points_px"]]}).json()
    assert len(b["contours_px"]) == 2
    # первым идёт кусок, по которому щёлкнули
    first = np.array(b["contours_px"][0])
    assert np.allclose(first.mean(axis=0), b_obj.mean(axis=0), atol=15)


def test_export_files_in_common_scale_with_outlines_and_caption():
    """«Сохранить файлы»: фото в общем масштабе, контуры эталона и области, подпись слева внизу."""
    a_img, a_m, a_obj = scene(6.0)
    b_img, b_m, b_obj = scene(12.0, size=(2000, 1500))
    a = upload("a.jpg", jpeg_bytes(a_img), group="files")
    b = upload("b.jpg", jpeg_bytes(b_img), group="files")
    for v, obj in ((a, a_obj), (b, b_obj)):
        client.post(f"/api/images/{v['id']}/measurements", json={"points": obj.tolist()})
    r = client.get("/api/export/files", params={"image_ids": f"{a['id']},{b['id']}", "tz": 180})
    assert r.status_code == 200 and r.headers["content-type"] == "application/zip"
    z = zipfile.ZipFile(io.BytesIO(r.content))
    assert sorted(z.namelist()) == ["a.jpg", "b.jpg"]
    imgs = {n: cv2.imdecode(np.frombuffer(z.read(n), np.uint8), cv2.IMREAD_COLOR) for n in z.namelist()}
    # общий масштаб 6 px/мм: второе фото уменьшено вдвое, под фото добавлена полоса с подписью
    assert imgs["a.jpg"].shape[1] == 1600 and imgs["a.jpg"].shape[0] > 1200
    assert imgs["b.jpg"].shape[1] == 1000 and imgs["b.jpg"].shape[0] > 750
    out = imgs["b.jpg"].astype(int)
    k = 0.5  # пиксели исходного фото -> пиксели результата
    # контур эталона синий (#5170FF), контур области красный (#E01E3C)
    mx, my = np.round((b_m[0] + 0.5) * k - 0.5).astype(int)
    patch = out[my - 3:my + 4, mx - 3:mx + 4].reshape(-1, 3)
    assert any(p[0] > 200 and p[2] < 140 for p in patch)
    ox, oy = np.round((b_obj[0] + 0.5) * k - 0.5).astype(int)
    patch = out[oy - 3:oy + 4, ox - 3:ox + 4].reshape(-1, 3)
    assert any(p[2] > 180 and p[0] < 110 for p in patch)
    # полоса под фото тёмная, белый текст в ней слева, правая часть пустая; само фото не тронуто
    strip = out[750:]
    assert strip.mean() < 60
    assert strip[:, :300].max() > 200 and strip[:, -200:].max() < 60
    assert out[700:745, 900:990].mean() > 120
    # одно фото — сразу JPG
    one = client.get("/api/export/files", params={"image_ids": a["id"]})
    assert one.headers["content-type"] == "image/jpeg"


def test_export_files_needs_marker():
    img, _, _ = scene(6.0)
    v = upload("nomarker.jpg", jpeg_bytes(img), detect="false")
    r = client.get("/api/export/files", params={"image_ids": v["id"]})
    assert r.status_code == 409 and r.json()["detail"]["code"] == "NOT_CALIBRATED"


def test_segment_reference_by_ruler():
    """Эталон по отрезку известной длины: масштаб, площадь, смена длины, возврат к квадрату."""
    img, m, obj = scene(6.0)
    v = upload("ruler.jpg", jpeg_bytes(img), detect="false")
    # отрезок 300 пикс. под углом — это 50 мм, значит 6 пикс./мм, как у сцены
    seg = [[300.0, 900.0], [300.0 + 300 * 0.8, 900.0 - 300 * 0.6]]
    r = client.put(f"/api/images/{v['id']}/calibration", json={"segment": seg, "segment_mm": 50})
    assert r.status_code == 200, r.text
    cal = r.json()["calibration"]
    assert cal["kind"] == "segment" and cal["perspective_used"] is False
    assert cal["px_per_mm"] == pytest.approx(6.0, rel=1e-9)
    assert cal["segment_mm"] == 50 and cal["uncertainty_pct"] < 1.5
    pv = client.post(f"/api/images/{v['id']}/measurements", json={"points": obj.tolist()}).json()
    assert pv["area_mm2"] == pytest.approx(1200, rel=1e-6)
    assert pv["perimeter_mm"] == pytest.approx(140, rel=1e-6)

    # тот же отрезок, но это 25 мм: масштаб вдвое крупнее, площадь вчетверо меньше
    r = client.put(f"/api/images/{v['id']}/calibration", json={"segment_mm": 25})
    assert r.json()["calibration"]["kind"] == "segment"
    assert r.json()["measurements"][0]["area_mm2"] == pytest.approx(300, rel=1e-6)

    # квадрат по углам заменяет отрезок, и сторона эталона снова 10 мм
    r = client.put(f"/api/images/{v['id']}/calibration", json={"corners": m.tolist()})
    assert r.json()["calibration"]["kind"] == "square"
    assert r.json()["measurements"][0]["area_mm2"] == pytest.approx(1200, rel=0.01)

    # подпись в выгрузке и CSV работают и с отрезком
    client.put(f"/api/images/{v['id']}/calibration", json={"segment": seg, "segment_mm": 50})
    one = client.get("/api/export/files", params={"image_ids": v["id"]})
    assert one.status_code == 200 and one.headers["content-type"] == "image/jpeg"
    zr = client.get("/api/export.zip", params={"image_ids": v["id"]})
    assert zr.status_code == 200


def test_segment_reference_errors():
    img, _, _ = scene(6.0)
    v = upload("ruler_bad.jpg", jpeg_bytes(img), detect="false")
    url = f"/api/images/{v['id']}/calibration"
    r = client.put(url, json={"segment": [[10, 10], [500, 10]]})
    assert r.status_code == 422 and r.json()["detail"]["code"] == "NO_SEGMENT_LENGTH"
    r = client.put(url, json={"segment": [[10, 10]], "segment_mm": 10})
    assert r.status_code == 422
    r = client.put(url, json={"segment": [[10, 10], [11, 11]], "segment_mm": 10})
    assert r.json()["detail"]["code"] == "SEGMENT_TOO_SHORT"
    r = client.put(url, json={"segment": [[10, 10], [5000, 10]], "segment_mm": 10})
    assert r.json()["detail"]["code"] == "OUTSIDE_IMAGE"
    r = client.put(url, json={"segment": [[100, 100], [200, 100]], "segment_mm": 10})
    assert [w["code"] for w in r.json()["calibration"]["warnings"]] == ["SEGMENT_SHORT"]
    # «Найти эталон» возвращает квадрат вместо отрезка
    d = client.post(f"/api/images/{v['id']}/detect", json={}).json()
    assert d["calibration"]["kind"] == "square"
