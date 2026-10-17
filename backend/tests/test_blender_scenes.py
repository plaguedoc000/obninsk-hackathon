"""Сложные синтетические фото из Blender: весь путь, как у пользователя.

Фото (tests/fixtures/blender, генератор — tests/blender/make_scenes.py) загружаются в API →
сайт сам ищет эталон и калибрует → по настоящему контуру образца считается площадь →
сравниваем с точной площадью из 3D-сцены. Отдельно проверяем «волшебную палочку»,
общий масштаб для серии снимков, поворот по EXIF и честность предупреждений.
"""
from __future__ import annotations

import io
import json
from functools import cache
from pathlib import Path

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.geometry import order_corners
from app.main import app

FIX = Path(__file__).parent / "fixtures" / "blender"
SCENES = json.loads((FIX / "manifest.json").read_text("utf-8"))["scenes"]
client = TestClient(app)


# Требования к каждой сцене:
#   corner — макс. ошибка угла эталона, в долях стороны эталона (0,01 ≈ 0,7 пикс. при эталоне 70 пикс.);
#   area — макс. ошибка площади образца по точному контуру, %;
#   warn — предупреждения, которые обязаны появиться;
#   polarity — искать светлый эталон («light»);
#   wand — минимальное совпадение (IoU) обводки «волшебной палочки» с настоящим контуром;
#   issues — известные слабости (тест помечен xfail, см. cases()).
EXPECT: dict[str, dict] = {
    "01_top_baseline": dict(corner=0.01, area=2.0, wand=0.95),
    "02_tilt_25": dict(corner=0.015, area=3.0, wand=0.95),
    "03_tilt_45": dict(corner=0.015, area=3.0, wand=0.95),
    # эталон под 60° сжат на фото вдвое: сам по себе он не квадрат, но на виде сверху по листу — квадрат
    "04_tilt_60": dict(corner=0.02, area=3.0, wand=0.9, warn=["STRONG_TILT"]),
    "05_hard_shadow": dict(corner=0.01, area=3.0, wand=0.95),
    # эталон на 0,1 мм выше бумаги: низкий боковой свет даёт от этой ступеньки тень в 1,5 пикс. с одной стороны
    "06_side_gradient": dict(corner=0.025, area=3.0, wand=0.95),
    # угол глянцевого эталона засвечен бликом и достроен по сторонам — точность угла ниже;
    # наклон 28° уточняют три видимые стороны листа
    "07_glare": dict(corner=0.025, area=3.0, wand=0.95, warn=["STRONG_TILT", "MARKER_CORNER_RESTORED"]),
    "08_flash": dict(corner=0.01, area=3.0, wand=0.95),
    "09_low_light": dict(corner=0.025, area=3.0, wand=0.95, warn=["MULTIPLE_CANDIDATES"]),
    "10_dof": dict(corner=0.02, area=3.0, wand=0.95),
    "11_motion_blur": dict(corner=0.02, area=3.0, wand=0.9),
    # листа нет, перспектива — по линиям сетки коврика; линии у краёв эталона не сбивают уточнение углов
    "12_cutting_mat": dict(corner=0.015, area=2.0, wand=0.95),
    # жирная линия миллиметровки (0,25 мм) проходит ровно по краю эталона: её половина снаружи сливается с краем
    "13_graph_paper": dict(corner=0.015, area=3.0, wand=0.95),
    "14_dark_distractors": dict(corner=0.01, area=3.0, wand=0.95),
    "15_two_squares": dict(corner=0.01, area=3.0, wand=0.95, warn=["MULTIPLE_CANDIDATES"]),
    "16_white_on_dark": dict(corner=0.015, area=3.0, polarity="light", wand=0.95),
    "17_small_far": dict(corner=0.02, area=3.0, wand=0.95, warn=["MARKER_SMALL"]),
    "18_highres_8mp": dict(corner=0.01, area=3.0, wand=0.95),
    # синяя ручка лежит поверх угла эталона: по цвету отделяется, закрытый угол достраивается по сторонам
    "19_occluded": dict(corner=0.02, area=3.0, wand=0.95, warn=["MARKER_CORNER_RESTORED"]),
    "21_low_contrast": dict(corner=0.01, area=3.0, wand=0.95),
    "22_series_a": dict(corner=0.01, area=2.0, wand=0.95),
    "22_series_b": dict(corner=0.015, area=3.0, wand=0.95, warn=["STRONG_TILT"]),
    "22_series_c": dict(corner=0.015, area=3.0, wand=0.95),
    "23_card_dark_table": dict(corner=0.01, area=3.0, wand=0.95),
    # контрольные сцены: добавлены после настройки и прошли проверку «вслепую», ничего под них не подгонялось
    "24_lens24_noexif": dict(corner=0.01, area=3.0, wand=0.95),
    "25_lens28_exif": dict(corner=0.01, area=3.0, wand=0.95),
    "26_tele52_exif": dict(corner=0.01, area=3.0, wand=0.95),
    "27_tele52_noexif": dict(corner=0.01, area=3.0, wand=0.95),
    "28_center_marker": dict(corner=0.01, area=3.0, wand=0.95),
    "29_dark_table_tilt18": dict(corner=0.01, area=3.0, wand=0.95),
    "30_white_tray": dict(corner=0.01, area=3.0, wand=0.95),
    "31_blue_paper_white_table": dict(corner=0.01, area=3.0, wand=0.95),
}


def upload_bytes(name: str, data: bytes, **form) -> dict:
    r = client.post("/api/images", files=[("files", (name, data, "image/jpeg"))], data=form)
    assert r.status_code == 200, r.text
    return r.json()["images"][0]


@cache
def uploaded(name: str) -> dict:
    sc = SCENES[name]
    return upload_bytes(sc["file"], (FIX / sc["file"]).read_bytes(), group=f"blender-{name[:2]}")


def warning_codes(v: dict) -> set[str]:
    codes = {w["code"] for w in (v["detection"] or {}).get("warnings", [])}
    return codes | {w["code"] for w in (v["calibration"] or {}).get("warnings", [])}


def marker_side_px(corners) -> float:
    c = order_corners(np.asarray(corners, float))
    d1, d2 = c[2] - c[0], c[3] - c[1]  # площадь по диагоналям
    return float(np.sqrt(abs(d1[0] * d2[1] - d1[1] * d2[0]) / 2))


def corner_error(v: dict, name: str) -> float:
    """Макс. ошибка угла эталона в долях стороны эталона."""
    true = order_corners(np.array(SCENES[name]["marker_px"]))
    found = order_corners(np.array(v["calibration"]["corners_px"]))
    return float(np.linalg.norm(found - true, axis=1).max()) / marker_side_px(true)


def measure(v: dict, points) -> dict:
    r = client.post(f"/api/images/{v['id']}/measurements", json={"points": points, "save": False})
    assert r.status_code == 200, r.text
    return r.json()


def area_error_pct(v: dict, sample: dict) -> tuple[float, dict]:
    r = measure(v, sample["outline_px"])
    return (r["area_mm2"] / sample["area_mm2"] - 1) * 100, r


def mask(points, size) -> np.ndarray:
    W, H = size
    m = np.zeros((H, W), np.uint8)
    cv2.fillPoly(m, [np.round(np.asarray(points) * 16).astype(np.int32)], 1, lineType=cv2.LINE_8, shift=4)
    return m.astype(bool)


def iou(a, b, size) -> float:
    ma, mb = mask(a, size), mask(b, size)
    return float((ma & mb).sum() / max((ma | mb).sum(), 1))


def detect(v: dict, polarity: str) -> dict:
    r = client.post(f"/api/images/{v['id']}/detect", json={"polarity": polarity})
    assert r.status_code == 200, r.text
    return r.json()


def calibrated(name: str) -> dict:
    v = uploaded(name)
    pol = EXPECT[name].get("polarity")
    return detect(v, pol) if pol else v


MARKED = [n for n in EXPECT if SCENES[n]["marker_px"]]
SAMPLES = [(n, i) for n in MARKED for i in range(len(SCENES[n]["samples"]))]


def cases(kind: str, items: list) -> list:
    """Параметры теста. Известная слабость из EXPECT[...]["issues"] помечается xfail(strict):
    тест не мешает деплою, но «покраснеет», когда слабость починят, — тогда пометку надо снять."""
    out = []
    for it in items:
        name, idx = it if isinstance(it, tuple) else (it, None)
        issue = EXPECT[name].get("issues", {}).get(kind)
        if isinstance(issue, dict):
            issue = issue.get(idx)
        marks = [pytest.mark.xfail(reason=issue, strict=True)] if issue else []
        out.append(pytest.param(it, marks=marks, id=name if idx is None else f"{name}-{idx}"))
    return out


@pytest.mark.parametrize("name", cases("marker", MARKED))
def test_marker_found_precisely(name):
    v = calibrated(name)
    assert v["status"] == "calibrated", warning_codes(v)
    assert corner_error(v, name) <= EXPECT[name]["corner"]


@pytest.mark.parametrize("name", cases("warn", [n for n in MARKED if EXPECT[n].get("warn")]))
def test_expected_warnings(name):
    assert set(EXPECT[name]["warn"]) <= warning_codes(calibrated(name))


@pytest.mark.parametrize("case", cases("area", SAMPLES))
def test_area_by_true_outline(case):
    name, idx = case
    v = calibrated(name)
    assert v["status"] == "calibrated"
    err, _ = area_error_pct(v, SCENES[name]["samples"][idx])
    assert abs(err) <= EXPECT[name]["area"]


@pytest.mark.parametrize("case", cases("honest", SAMPLES))
def test_silent_error_is_within_reported_uncertainty(case):
    """Честность: если сайт ни о чём не предупредил, ошибка площади не больше 3× заявленной погрешности."""
    name, idx = case
    v = calibrated(name)
    if v["status"] != "calibrated":
        return  # эталон не найден — сайт об этом сказал
    err, r = area_error_pct(v, SCENES[name]["samples"][idx])
    warned = warning_codes(v) | {w["code"] for w in r["warnings"]}
    if not warned:
        assert abs(err) <= 3 * r["uncertainty_pct"], f"ошибка {err:+.1f}%, а обещано ±{r['uncertainty_pct']:.1f}%"


WAND = [(n, i) for n, i in SAMPLES if "wand" in EXPECT[n]]


@pytest.mark.parametrize("case", cases("wand", WAND))
def test_magic_wand_outline(case):
    """Палочка либо обводит образец точно, либо предупреждает (FLOOD_TOO_BIG / FLOOD_TOO_SMALL)."""
    name, idx = case
    v = calibrated(name)
    s = SCENES[name]["samples"][idx]
    r = client.post(f"/api/images/{v['id']}/autocontour", json={"point": s["seed_px"]})
    assert r.status_code == 200, r.text
    res = r.json()
    if s["contrast"] == "low" or res["warnings"]:
        assert res["warnings"] or iou(res["points_px"], s["outline_px"], SCENES[name]["size"]) >= EXPECT[name]["wand"]
    else:
        assert iou(res["points_px"], s["outline_px"], SCENES[name]["size"]) >= EXPECT[name]["wand"]


def test_no_marker_is_reported():
    """Жёлтая квадратная наклейка 12 мм — не эталон: эталон чёрный, втрое и больше темнее фона."""
    v = uploaded("20_no_marker")
    assert v["status"] == "marker_not_found"
    assert "MARKER_NOT_FOUND" in warning_codes(v)


def test_two_squares_ambiguity_is_reported():
    """Квадраты 1 и 2 см неразличимы по форме: сайт должен либо выбрать эталон, либо предупредить."""
    v = uploaded("15_two_squares")
    picked_right = v["calibration"] and corner_error(v, "15_two_squares") < 0.05
    assert picked_right or "MULTIPLE_CANDIDATES" in warning_codes(v)


@pytest.mark.parametrize("name", ["12_cutting_mat", "13_graph_paper"])
def test_grid_gives_perspective(name):
    """Листа нет, но эталон лежит на сетке: перспектива — по точкам схода её линий."""
    plane = calibrated(name)["calibration"]["plane"]
    assert plane["source"] == "grid" and min(plane["lines"]) >= 5


def test_visible_sheet_sides_refine_pose():
    """Лист виден не целиком (две стороны): они уточняют позу эталона."""
    plane = calibrated("19_occluded")["calibration"]["plane"]
    assert plane["source"] == "pose" and plane["sheet_edges"] == 2


def test_exif_focal_length_is_used():
    """В фото с телефона фокусное расстояние лежит в EXIF — по нему сайт восстанавливает наклон камеры."""
    v = uploaded("26_tele52_exif")
    assert v["calibration"]["focal_from_exif"]
    assert not uploaded("27_tele52_noexif")["calibration"]["focal_from_exif"]


def test_exif_rotated_phone_photo():
    """Телефон сохранил кадр «на боку» с EXIF=6: углы эталона должны совпасть с исходным кадром."""
    name = "01_top_baseline"
    im = Image.open(FIX / SCENES[name]["file"]).transpose(Image.Transpose.ROTATE_90)  # лёг на бок
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=92, exif=exif.tobytes())
    v = upload_bytes("phone.jpg", buf.getvalue())
    assert v["rotated_by_exif"] and [v["width"], v["height"]] == SCENES[name]["size"]
    assert corner_error(v, name) <= EXPECT[name]["corner"] * 2


def test_series_in_one_scale():
    """Один лист снят близко и издалека вертикальным кадром → после «одного масштаба» он одного размера."""
    names = ["22_series_a", "22_series_c"]
    vs = [calibrated(n) for n in names]
    for v, n in zip(vs, names):
        r = client.post(f"/api/images/{v['id']}/measurements", json={"points": SCENES[n]["samples"][0]["outline_px"], "label": "Лист"})
        assert r.status_code == 200
    cmp = client.post("/api/compare", json={"image_ids": [v["id"] for v in vs], "grid": False, "annotate": False}).json()
    target = cmp["px_per_mm"]
    truth = SCENES[names[0]]["samples"][0]["area_mm2"]
    sides, areas = [], []
    for it in cmp["items"]:
        sides.append(marker_side_px(it["marker_corners_out"]))
        pts = np.array(it["measurements"][0]["points_out"])
        x, y = pts[:, 0], pts[:, 1]
        areas.append(0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / target**2)
    assert max(sides) / min(sides) - 1 < 0.03, sides
    for a in areas:
        assert abs(a / truth - 1) * 100 <= EXPECT["22_series_c"]["area"], areas
    # на приведённой картинке лист лежит там, куда указывают пересчитанные точки
    it = cmp["items"][1]
    img = cv2.imdecode(np.frombuffer(client.get(it["url"]).content, np.uint8), cv2.IMREAD_COLOR)
    h, w = img.shape[:2]
    inside = cv2.erode(mask(it["measurements"][0]["points_out"], (w, h)).astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    b, g, r = (img[..., k].astype(int) for k in range(3))
    green = (g > r + 15) & (g > b + 15)
    assert green[inside].mean() > 0.97
