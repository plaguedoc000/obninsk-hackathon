import numpy as np
import pytest

from app.detection import detect_marker
from app.geometry import build_calibration, measure_polygon, order_corners
from tests.synth import rect_corners, render, tilted_view, warp_points

DARK = (40, 45, 60)
PAPER = (232, 236, 236)


def corner_error(found, true):
    return float(np.max(np.linalg.norm(order_corners(np.array(found)) - order_corners(true), axis=1)))


@pytest.mark.parametrize("side,angle", [(30, 0), (30, 23), (60, 17), (120, 40), (250, 5)])
def test_detect_subpixel_and_area(side, angle):
    ppmm = side / 10
    m = rect_corners(300, 300, side, side, angle)
    obj = rect_corners(300 + side + 25 * ppmm, 300 + 25 * ppmm, 30 * ppmm, 40 * ppmm, 10)
    size = (int(max(1600, obj[:, 0].max() + 60)), int(max(1200, obj[:, 1].max() + 60)))
    img = render(size=size, shapes=[(m, DARK), (obj, PAPER)], seed=side)
    det = detect_marker(img)
    assert det["found"]
    assert corner_error(det["best"]["corners_px"], m) < 0.3
    cal = build_calibration(det["best"]["corners_px"], 10, method="auto", sigma_px=det["best"]["sigma_px"])
    area = measure_polygon(cal, obj)["area_mm2"]
    assert abs(area / 1200 - 1) < 0.015


def test_detect_prefers_square_over_dark_rectangle():
    m = rect_corners(300, 300, 60, 60, 10)
    card = rect_corners(800, 500, 340, 215, -5)  # тёмная «карта»
    img = render(shapes=[(card, (70, 110, 40)), (m, DARK)])
    det = detect_marker(img)
    assert corner_error(det["best"]["corners_px"], m) < 0.3


def test_detect_under_perspective():
    Hm = tilted_view(tilt=0.2)
    m = warp_points(Hm, rect_corners(600, 700, 80, 80))
    img = render(shapes=[(m, DARK)])
    det = detect_marker(img)
    assert corner_error(det["best"]["corners_px"], m) < 0.3


def test_detect_uneven_lighting():
    m = rect_corners(500, 400, 50, 50, 30)
    img = render(shapes=[(m, DARK)]).astype(np.float32)
    h, w = img.shape[:2]
    grad = np.linspace(0.45, 1.1, w)[None, :, None]
    img = np.clip(img * grad, 0, 255).astype(np.uint8)
    det = detect_marker(img)
    assert det["found"]
    assert corner_error(det["best"]["corners_px"], m) < 0.5


def test_not_found_on_empty_image():
    img = render(shapes=[])
    det = detect_marker(img)
    assert not det["found"]
    assert det["warnings"][0]["code"] == "MARKER_NOT_FOUND"


def test_light_marker_polarity():
    m = rect_corners(400, 400, 60, 60, 12)
    img = render(bg=(40, 40, 40), shapes=[(m, (235, 235, 235))])
    det = detect_marker(img, polarity="light")
    assert det["found"] and corner_error(det["best"]["corners_px"], m) < 0.3


def test_white_marker_found_by_default():
    # белый квадрат на тёмном столе находится без подсказки, какой эталон искать
    m = rect_corners(400, 400, 60, 60, 12)
    img = render(bg=(40, 40, 40), shapes=[(m, (235, 235, 235))])
    det = detect_marker(img)
    assert det["best"]["polarity"] == "light" and corner_error(det["best"]["corners_px"], m) < 0.3
    assert not det["warnings"]


@pytest.mark.parametrize("color,polarity", [
    ((0, 220, 245), "color"),  # жёлтый на белом: по яркости почти не отличается — находится по цвету
    ((60, 170, 70), "dark"),   # зелёный и синий заметно темнее белого
    ((200, 120, 40), "dark"),
])
def test_color_marker_on_white(color, polarity):
    m = rect_corners(500, 400, 60, 60, 20)
    img = render(bg=(236, 238, 238), shapes=[(m, color)])
    det = detect_marker(img)
    assert det["best"]["polarity"] == polarity and corner_error(det["best"]["corners_px"], m) < 0.3
    # найденный по цвету — с просьбой проверить, что это эталон, а не наклейка
    assert ("MARKER_BY_COLOR" in {w["code"] for w in det["warnings"]}) == (polarity == "color")


def test_black_marker_on_white_card_beats_card_and_sticker():
    # эталон на белой карточке на тёмном столе, рядом жёлтая наклейка: выбран чёрный эталон, карточка — подложка
    card = rect_corners(600, 500, 240, 240, 5)
    m = rect_corners(600, 500, 60, 60, 5)
    sticker = rect_corners(1100, 500, 70, 70, -8)
    img = render(bg=(45, 50, 55), shapes=[(card, (235, 235, 235)), (m, DARK), (sticker, (0, 220, 245))])
    det = detect_marker(img)
    assert det["best"]["polarity"] == "dark" and corner_error(det["best"]["corners_px"], m) < 0.3
    assert all(c["side_px"] < 200 for c in det["candidates"])


def test_white_marker_on_black_card():
    card = rect_corners(600, 500, 240, 240, -7)
    m = rect_corners(600, 500, 60, 60, -7)
    img = render(bg=(225, 228, 228), shapes=[(card, (30, 30, 35)), (m, (240, 240, 240))])
    det = detect_marker(img)
    assert det["best"]["polarity"] == "light" and corner_error(det["best"]["corners_px"], m) < 0.3
