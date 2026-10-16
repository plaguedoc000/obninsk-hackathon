import math

import numpy as np
import pytest

from app.errors import AppError
from app.geometry import (build_calibration, circle_from_3, is_self_intersecting, measure_polygon,
                          order_corners, polygon_area, polygon_perimeter, shape_to_polygon)
from tests.synth import rect_corners, tilted_view, warp_points


def test_shoelace_rectangle():
    p = np.array([[0, 0], [30, 0], [30, 40], [0, 40]], float)
    assert polygon_area(p) == pytest.approx(1200)
    assert polygon_area(p[::-1]) == pytest.approx(1200)
    assert polygon_perimeter(p) == pytest.approx(140)


def test_order_corners_any_input_order():
    sq = np.array([[10, 10], [20, 10], [20, 20], [10, 20]], float)
    for perm in ([2, 0, 3, 1], [3, 2, 1, 0], [1, 3, 0, 2]):
        assert np.allclose(order_corners(sq[perm]), sq)


@pytest.mark.parametrize("angle", [0, 13, 45, 77])
def test_scale_calibration_exact(angle):
    ppmm = 7.5
    m = rect_corners(300, 300, 10 * ppmm, 10 * ppmm, angle)
    cal = build_calibration(m, 10.0)
    assert cal["px_per_mm"] == pytest.approx(ppmm, rel=1e-9)
    assert not cal["perspective_used"]
    obj = rect_corners(700, 500, 30 * ppmm, 40 * ppmm, angle + 20)
    res = measure_polygon(cal, obj)
    assert res["area_mm2"] == pytest.approx(1200, rel=1e-9)
    assert res["perimeter_mm"] == pytest.approx(140, rel=1e-9)


def test_marker_size_parameter():
    m = rect_corners(300, 300, 60, 60)
    obj = rect_corners(600, 300, 120, 120)
    a10 = measure_polygon(build_calibration(m, 10.0), obj)["area_mm2"]
    a30 = measure_polygon(build_calibration(m, 30.0), obj)["area_mm2"]
    assert a10 == pytest.approx(400)
    assert a30 == pytest.approx(3600)


def test_perspective_recovers_true_area():
    Hm = tilted_view(tilt=0.25)
    ppmm = 10
    m = warp_points(Hm, rect_corners(500, 600, 10 * ppmm, 10 * ppmm))
    obj = warp_points(Hm, rect_corners(900, 650, 50 * ppmm, 30 * ppmm))
    cal = build_calibration(m, 10.0, perspective="on")
    assert cal["perspective_used"]
    res = measure_polygon(cal, obj)
    assert res["area_mm2"] == pytest.approx(1500, rel=1e-6)
    off = measure_polygon(build_calibration(m, 10.0, perspective="off"), obj)
    assert abs(off["area_mm2"] / 1500 - 1) > 0.01  # без перспективы — заметная ошибка


def test_affine_view_without_perspective():
    # параллелограмм (камера смотрит сбоку, но издалека) — аффинной модели достаточно
    A = np.array([[1.0, 0.25], [0.05, 0.8]])
    ppmm = 8
    sq = rect_corners(0, 0, 10 * ppmm, 10 * ppmm) @ A.T + [400, 400]
    ob = rect_corners(300, 0, 20 * ppmm, 20 * ppmm) @ A.T + [400, 400]
    cal = build_calibration(sq, 10.0)
    assert not cal["perspective_used"]
    assert measure_polygon(cal, ob)["area_mm2"] == pytest.approx(400, rel=1e-9)


def test_bad_corners_rejected():
    with pytest.raises(AppError):
        build_calibration([[0, 0], [10, 0], [10, 10]], 10)
    with pytest.raises(AppError):
        build_calibration([[0, 0], [100, 0], [100, 100], [50, 10]], 10)  # не выпуклый
    with pytest.raises(AppError):
        build_calibration([[0, 0], [100, 0], [100, 100], [0, 100]], 0)


def test_shapes():
    poly, spec = shape_to_polygon("circle", [[100, 100], [130, 100]])
    assert polygon_area(poly) == pytest.approx(math.pi * 30**2, rel=1e-4)
    c, r = circle_from_3(np.array([[0, 10.0], [10, 0], [-10, 0]]))
    assert np.allclose(c, [0, 0]) and r == pytest.approx(10)
    poly, _ = shape_to_polygon("ellipse", ellipse={"cx": 50, "cy": 50, "rx": 20, "ry": 10, "angle_deg": 30})
    assert polygon_area(poly) == pytest.approx(math.pi * 200, rel=1e-4)


def test_polygon_validation():
    assert is_self_intersecting(np.array([[0, 0], [10, 10], [10, 0], [0, 10]], float))
    assert not is_self_intersecting(np.array([[0, 0], [10, 0], [10, 10], [0, 10]], float))
    with pytest.raises(AppError) as e:
        shape_to_polygon("polygon", [[0, 0], [10, 10], [10, 0], [0, 10]])
    assert e.value.code == "SELF_INTERSECTION"
    with pytest.raises(AppError):
        shape_to_polygon("polygon", [[0, 0], [1, 1], [2, 2]])
    with pytest.raises(AppError):
        shape_to_polygon("polygon", [[0, 0], [1, 1]])


def test_warnings_small_marker_and_far_object():
    cal = build_calibration(rect_corners(100, 100, 30, 30), 10.0)
    assert any(w["code"] == "MARKER_SMALL" for w in cal["warnings"])
    res = measure_polygon(cal, rect_corners(1100, 100, 60, 60))
    assert any(w["code"] == "FAR_FROM_MARKER" for w in res["warnings"])


def test_auto_perspective_switches_on_strong_trapezoid():
    Hm = tilted_view(tilt=0.25)
    big = warp_points(Hm, rect_corners(800, 600, 400, 400))   # крупный эталон — трапеция заметна
    assert build_calibration(big, 30.0)["perspective_used"]
    flat = rect_corners(800, 600, 100, 100, 20)               # снято сверху — перспектива не нужна
    assert not build_calibration(flat, 10.0)["perspective_used"]
