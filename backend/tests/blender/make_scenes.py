"""Синтетические «фотографии» для тестов, отрендеренные в Blender (Cycles).

Каждая сцена — стол, лист бумаги, чёрный квадрат-эталон 10×10 мм и образцы с точно известной
площадью; плюс свет, тени, блики, текстуры, наклон камеры, размытие, шум. Рядом с картинками
пишется manifest.json с «правдой»: где на фото углы эталона и контуры образцов (в пикселях)
и какая у образцов настоящая площадь в мм².

Запуск из корня репозитория (нужен Blender 4.2+; рендер идёт на видеокарте, если она есть):

    /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup \
        -P backend/tests/blender/make_scenes.py -- [имена сцен] [--preview] [--truth-only]

Без имён рендерятся все сцены. --preview — маленькие картинки во временную папку, чтобы проверить свет.
--truth-only — только пересчитать manifest.json (геометрия детерминирована, картинки не меняются).
"""
from __future__ import annotations

import json
import math
import re
import sys
import tempfile
from pathlib import Path

import bpy
import numpy as np
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Matrix, Quaternion, Vector

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "fixtures" / "blender"
PREVIEW = Path(tempfile.gettempdir()) / "onescale_blender_preview"
HDRI = Path(bpy.utils.system_resource("DATAFILES", path="studiolights/world"))

MM = 0.001
Z_PAPER = 0.0001  # лист бумаги чуть выше стола
Z_TOP = 0.0002  # эталон и образцы — в одной плоскости
PAPER_A4 = (297.0, 210.0)


# ---------------------------------------------------------------- формы образцов (мм, центр в 0)

def shoelace(p) -> float:
    p = np.asarray(p)
    x, y = p[:, 0], p[:, 1]
    return 0.5 * float(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def ccw(p):
    return p if shoelace(p) > 0 else p[::-1]


def rect(w, h):
    return [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]


def ellipse(rx, ry, n=360):
    return [(rx * math.cos(t), ry * math.sin(t)) for t in np.linspace(0, 2 * math.pi, n, endpoint=False)]


def leaf(length, width, teeth=0, tooth=0.0, n=300):
    """Лист: шире у основания, острый кончик, по краю — зубчики."""
    top, bot = [], []
    for i in range(n + 1):
        u = i / n
        x = (u - 0.5) * length
        w = 0.5 * width * math.sin(math.pi * u) ** 0.85 * (1.15 - 0.45 * u)
        if teeth:
            w *= 1 + tooth * abs(math.sin(math.pi * teeth * u))
        top.append((x, w))
        bot.append((x, -0.9 * w))
    return top + bot[-2:0:-1]


def star(r_out, r_in, spikes):
    pts = []
    for k in range(2 * spikes):
        r = r_out if k % 2 == 0 else r_in
        a = math.pi * k / spikes + math.pi / 2
        pts.append((r * math.cos(a), r * math.sin(a)))
    return pts


def c_shape(r_out, r_in, gap_deg=70, n=200):
    a0 = math.radians(gap_deg / 2)
    a1 = 2 * math.pi - a0
    outer = [(r_out * math.cos(t), r_out * math.sin(t)) for t in np.linspace(a0, a1, n)]
    inner = [(r_in * math.cos(t), r_in * math.sin(t)) for t in np.linspace(a1, a0, n)]
    return outer + inner


def blob(r, seed, n=360, bumps=5, amp=0.18):
    rng = np.random.default_rng(seed)
    a = rng.uniform(0.3, 1.0, bumps) * amp / np.arange(1, bumps + 1) ** 0.5
    ph = rng.uniform(0, 2 * math.pi, bumps)
    pts = []
    for t in np.linspace(0, 2 * math.pi, n, endpoint=False):
        rr = r * (1 + sum(a[k] * math.cos((k + 2) * t + ph[k]) for k in range(bumps)))
        pts.append((rr * math.cos(t), rr * math.sin(t)))
    return pts


# ---------------------------------------------------------------- материалы

def lin(c):
    """sRGB 0..255 -> линейный цвет для шейдера."""
    def f(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (f(c[0]), f(c[1]), f(c[2]), 1.0)


def _new_material(name):
    m = bpy.data.materials.new(name)
    if hasattr(m, "use_nodes") and not m.use_nodes:
        m.use_nodes = True
    return m, m.node_tree, m.node_tree.nodes["Principled BSDF"]


def matte(name, srgb, rough=0.6, spec=0.5, metallic=0.0):
    m, _, b = _new_material(name)
    b.inputs["Base Color"].default_value = lin(srgb)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Specular IOR Level"].default_value = spec
    b.inputs["Metallic"].default_value = metallic
    return m


def _ramp(nt, stops):
    r = nt.nodes.new("ShaderNodeValToRGB")
    els = r.color_ramp.elements
    els[0].position, els[0].color = stops[0][0], lin(stops[0][1])
    els[1].position, els[1].color = stops[-1][0], lin(stops[-1][1])
    for pos, col in stops[1:-1]:
        e = els.new(pos)
        e.color = lin(col)
    return r


def _coords(nt, scale=(1, 1, 1)):
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Scale"].default_value = scale
    nt.links.new(tc.outputs["Object"], mp.inputs["Vector"])
    return mp.outputs["Vector"]


def _bump(nt, b, height_socket, strength):
    bp = nt.nodes.new("ShaderNodeBump")
    bp.inputs["Strength"].default_value = strength
    bp.inputs["Distance"].default_value = 0.0005
    nt.links.new(height_socket, bp.inputs["Height"])
    nt.links.new(bp.outputs["Normal"], b.inputs["Normal"])


def mottled(name, c1, c2, scale=300, rough=0.55, bump=0.05):
    """Неровный цвет (лист, ткань образца): шум между двумя цветами."""
    m, nt, b = _new_material(name)
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = scale
    n.inputs["Detail"].default_value = 6
    nt.links.new(_coords(nt), n.inputs["Vector"])
    r = _ramp(nt, [(0.3, c1), (0.7, c2)])
    nt.links.new(n.outputs["Fac"], r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    if bump:
        _bump(nt, b, n.outputs["Fac"], bump)
    return m


def wood(name, dark=False):
    m, nt, b = _new_material(name)
    w = nt.nodes.new("ShaderNodeTexWave")
    w.wave_type = "BANDS"
    w.bands_direction = "X"
    w.inputs["Scale"].default_value = 9
    w.inputs["Distortion"].default_value = 7
    w.inputs["Detail"].default_value = 5
    w.inputs["Detail Scale"].default_value = 1.5
    nt.links.new(_coords(nt, (1, 7, 1)), w.inputs["Vector"])
    stops = [(0.0, (62, 38, 24)), (0.5, (92, 58, 36)), (1.0, (110, 72, 44))] if dark else \
            [(0.0, (150, 104, 62)), (0.5, (190, 140, 88)), (1.0, (205, 160, 105))]
    r = _ramp(nt, stops)
    nt.links.new(w.outputs["Fac"], r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.35
    b.inputs["Coat Weight"].default_value = 0.4
    _bump(nt, b, w.outputs["Fac"], 0.08)
    return m


def fabric(name, c1, c2):
    """Плетение: полосы по X и Y + ворс."""
    m, nt, b = _new_material(name)
    vec = _coords(nt)
    wx = nt.nodes.new("ShaderNodeTexWave")
    wy = nt.nodes.new("ShaderNodeTexWave")
    for wv, d in ((wx, "X"), (wy, "Y")):
        wv.wave_type, wv.bands_direction = "BANDS", d
        wv.inputs["Scale"].default_value = 450
        wv.inputs["Distortion"].default_value = 0.5
        nt.links.new(vec, wv.inputs["Vector"])
    mul = nt.nodes.new("ShaderNodeMath")
    mul.operation = "MULTIPLY"
    nt.links.new(wx.outputs["Fac"], mul.inputs[0])
    nt.links.new(wy.outputs["Fac"], mul.inputs[1])
    r = _ramp(nt, [(0.0, c1), (1.0, c2)])
    nt.links.new(mul.outputs["Value"], r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.9
    b.inputs["Specular IOR Level"].default_value = 0.2
    _bump(nt, b, mul.outputs["Value"], 0.3)
    return m


def grid(name, base, line, step_mm, line_mm, fine_step_mm=None, fine_line_mm=None, rough=0.6):
    """Сетка линиями (коврик для резки, миллиметровка) через «кирпичную» текстуру без сдвига рядов."""
    m, nt, b = _new_material(name)
    vec = _coords(nt)

    def bricks(step, width):
        t = nt.nodes.new("ShaderNodeTexBrick")
        t.offset, t.squash = 0.0, 1.0
        t.inputs["Scale"].default_value = 1.0
        t.inputs["Brick Width"].default_value = step * MM
        t.inputs["Row Height"].default_value = step * MM
        t.inputs["Mortar Size"].default_value = width * MM / 2
        t.inputs["Mortar Smooth"].default_value = 0.2
        nt.links.new(vec, t.inputs["Vector"])
        return t.outputs["Fac"]

    fac = bricks(step_mm, line_mm)
    if fine_step_mm:
        half = nt.nodes.new("ShaderNodeMath")
        half.operation = "MULTIPLY"
        half.inputs[1].default_value = 0.45
        nt.links.new(bricks(fine_step_mm, fine_line_mm), half.inputs[0])
        mx = nt.nodes.new("ShaderNodeMath")
        mx.operation = "MAXIMUM"
        nt.links.new(fac, mx.inputs[0])
        nt.links.new(half.outputs["Value"], mx.inputs[1])
        fac = mx.outputs["Value"]
    r = _ramp(nt, [(0.0, base), (1.0, line)])
    nt.links.new(fac, r.inputs["Fac"])
    nt.links.new(r.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = rough
    return m


def paper(name="Бумага", srgb=(242, 241, 236), rough=0.75):
    m, nt, b = _new_material(name)
    n = nt.nodes.new("ShaderNodeTexNoise")
    n.inputs["Scale"].default_value = 2500
    n.inputs["Detail"].default_value = 3
    nt.links.new(_coords(nt), n.inputs["Vector"])
    b.inputs["Base Color"].default_value = lin(srgb)
    b.inputs["Roughness"].default_value = rough
    _bump(nt, b, n.outputs["Fac"], 0.03)
    return m


# ---------------------------------------------------------------- объекты

def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def flat(name, pts_mm, mat, at_mm=(0, 0), rot_deg=0.0, z=Z_TOP):
    """Плоская фигура на столе. Возвращает объект и контур в локальных мм."""
    pts = ccw(list(pts_mm))
    me = bpy.data.meshes.new(name)
    me.from_pydata([(x * MM, y * MM, 0.0) for x, y in pts], [], [list(range(len(pts)))])
    me.update()
    me.materials.append(mat)
    ob = link(bpy.data.objects.new(name, me))
    ob.location = (at_mm[0] * MM, at_mm[1] * MM, z)
    ob.rotation_euler = (0, 0, math.radians(rot_deg))
    return ob, pts


def box(name, size_mm, at_mm, mat, rot_deg=0.0):
    me = bpy.data.meshes.new(name)
    sx, sy, sz = (s * MM / 2 for s in size_mm)
    v = [(x, y, z) for z in (-sz, sz) for y in (-sy, sy) for x in (-sx, sx)]
    f = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    me.from_pydata(v, [], f)
    me.update()
    me.materials.append(mat)
    ob = link(bpy.data.objects.new(name, me))
    ob.location = (at_mm[0] * MM, at_mm[1] * MM, size_mm[2] * MM / 2)
    ob.rotation_euler = (0, 0, math.radians(rot_deg))
    for p in me.polygons:
        p.use_smooth = False
    return ob


def cylinder(name, r_mm, h_mm, at_mm, mat, lying_deg=None, n=64):
    """Цилиндр: стоя (кружка, монета) или лёжа под углом lying_deg (ручка)."""
    me = bpy.data.meshes.new(name)
    r, h = r_mm * MM, h_mm * MM
    ring = [(r * math.cos(t), r * math.sin(t)) for t in np.linspace(0, 2 * math.pi, n, endpoint=False)]
    v = [(x, y, -h / 2) for x, y in ring] + [(x, y, h / 2) for x, y in ring]
    f = [(i, (i + 1) % n, n + (i + 1) % n, n + i) for i in range(n)]
    f += [tuple(range(n - 1, -1, -1)), tuple(range(n, 2 * n))]
    me.from_pydata(v, [], f)
    me.update()
    for p in me.polygons[:n]:
        p.use_smooth = True
    me.materials.append(mat)
    ob = link(bpy.data.objects.new(name, me))
    if lying_deg is None:
        ob.location = (at_mm[0] * MM, at_mm[1] * MM, h / 2)
    else:
        ob.location = (at_mm[0] * MM, at_mm[1] * MM, r)
        ob.rotation_euler = (0, math.pi / 2, math.radians(lying_deg))  # XYZ: сначала положить, потом повернуть
    return ob


# ---------------------------------------------------------------- свет и окружение

def world(hdri="interior.exr", strength=0.5, rot_deg=0.0):
    w = bpy.data.worlds.new("Окружение")
    bpy.context.scene.world = w
    if hasattr(w, "use_nodes") and not w.use_nodes:
        w.use_nodes = True
    nt = w.node_tree
    bg = nt.nodes["Background"]
    bg.inputs["Strength"].default_value = strength
    env = nt.nodes.new("ShaderNodeTexEnvironment")
    env.image = bpy.data.images.load(str(HDRI / hdri), check_existing=True)
    tc = nt.nodes.new("ShaderNodeTexCoord")
    mp = nt.nodes.new("ShaderNodeMapping")
    mp.inputs["Rotation"].default_value = (0, 0, math.radians(rot_deg))
    nt.links.new(tc.outputs["Generated"], mp.inputs["Vector"])
    nt.links.new(mp.outputs["Vector"], env.inputs["Vector"])
    nt.links.new(env.outputs["Color"], bg.inputs["Color"])


def aim(ob, target):
    d = Vector(target) - ob.location
    ob.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


def lamp(kind, at, target=(0, 0, 0), energy=10.0, size=0.1, color=(1, 1, 1), angle_deg=None, spot_deg=None):
    li = bpy.data.lights.new(kind, type=kind)
    li.energy = energy
    li.color = color
    if kind == "AREA":
        li.shape = "DISK"
        li.size = size
    elif kind == "SUN":
        li.angle = math.radians(angle_deg if angle_deg is not None else 2.0)
    else:
        li.shadow_soft_size = size
    if kind == "SPOT":
        li.spot_size = math.radians(spot_deg or 60)
        li.spot_blend = 0.6
    ob = link(bpy.data.objects.new(kind, li))
    ob.location = at
    aim(ob, target)
    return ob


def sun_from(azim_deg, elev_deg, energy, angle_deg=1.0, color=(1, 1, 1)):
    a, e = math.radians(azim_deg), math.radians(elev_deg)
    d = Vector((math.cos(a) * math.cos(e), math.sin(a) * math.cos(e), math.sin(e)))
    return lamp("SUN", d, (0, 0, 0), energy, angle_deg=angle_deg, color=color)


# ---------------------------------------------------------------- камера

def camera(target_mm=(0, 0), dist=0.22, tilt=0.0, azim=-90.0, roll=0.0, lens=26.0, sensor=34.6,
           fstop=None, focus_mm=None):
    """Камера смотрит на точку стола с расстояния dist (м); tilt — отклонение от вертикали, azim — откуда смотрит."""
    t, a = math.radians(tilt), math.radians(azim)
    target = Vector((target_mm[0] * MM, target_mm[1] * MM, 0))
    loc = target + dist * Vector((math.sin(t) * math.cos(a), math.sin(t) * math.sin(a), math.cos(t)))
    f = (target - loc).normalized()
    hint = Vector((-math.cos(a), -math.sin(a), 0))  # верх кадра — дальняя от камеры сторона стола
    up = (hint - hint.dot(f) * f).normalized()
    z = -f
    x = up.cross(z)
    rot = Matrix((x, up, z)).transposed().to_quaternion() @ Quaternion((0, 0, 1), math.radians(roll))
    cd = bpy.data.cameras.new("Камера")
    cd.lens, cd.sensor_width, cd.sensor_fit = lens, sensor, "AUTO"
    cd.clip_start, cd.clip_end = 0.005, 50
    if fstop:
        cd.dof.use_dof = True
        cd.dof.aperture_fstop = fstop
        fp = Vector(((focus_mm or target_mm)[0] * MM, (focus_mm or target_mm)[1] * MM, 0))
        cd.dof.focus_distance = (fp - loc).dot(f)
    ob = link(bpy.data.objects.new("Камера", cd))
    ob.location = loc
    ob.rotation_mode = "QUATERNION"
    ob.rotation_quaternion = rot
    bpy.context.scene.camera = ob
    return ob


def shake(cam, shift_mm=(1.2, 0.6), turn_deg=0.5):
    """Дрожание рук: камера равномерно сдвигается и поворачивается за время выдержки (кадры 0 -> 2)."""
    sc = bpy.context.scene
    sc.render.use_motion_blur = True
    sc.render.motion_blur_shutter = 1.0
    base_loc, base_rot = cam.location.copy(), cam.rotation_quaternion.copy()
    d = Vector((shift_mm[0] * MM, shift_mm[1] * MM, 0))
    tw = Quaternion((1, 0.4, 0), math.radians(turn_deg))
    for frame, k in ((0, -1), (2, 1)):
        cam.location = base_loc + k * d
        cam.rotation_quaternion = base_rot @ Quaternion(tw.axis, k * tw.angle)
        cam.keyframe_insert("location", frame=frame)
        cam.keyframe_insert("rotation_quaternion", frame=frame)
    anim = cam.animation_data.action
    curves = anim.fcurves if hasattr(anim, "fcurves") else [c for l in anim.layers for s in l.strips
                                                             for cb in s.channelbags for c in cb.fcurves]
    for fc in curves:
        for kp in fc.keyframe_points:
            kp.interpolation = "LINEAR"
    sc.frame_set(1)


# ---------------------------------------------------------------- «правда» для тестов

def project(cam, pts_world):
    sc = bpy.context.scene
    W, H = sc.render.resolution_x, sc.render.resolution_y
    out = []
    for p in pts_world:
        v = world_to_camera_view(sc, cam, Vector(p))
        out.append((v.x * W - 0.5, (1 - v.y) * H - 0.5))  # центр левого верхнего пикселя = (0, 0)
    return np.array(out)


def to_world(ob, pts_mm):
    M = ob.matrix_world
    return [tuple(M @ Vector((x * MM, y * MM, 0))) for x, y in pts_mm]


def plane_homography(cam):
    """Гомография «мм на плоскости эталона -> пиксели фото»."""
    src = np.array([[-150, -110], [150, -110], [150, 110], [-150, 110]], float)
    dst = project(cam, [(x * MM, y * MM, Z_TOP) for x, y in src])
    A, b = [], []
    for (x, y), (u, v) in zip(src, dst):
        A += [[x, y, 1, 0, 0, 0, -u * x, -u * y], [0, 0, 0, x, y, 1, -v * x, -v * y]]
        b += [u, v]
    h = np.linalg.solve(np.array(A), np.array(b))
    return np.append(h, 1).reshape(3, 3)


def add_exif_focal(path: Path, focal35: float):
    """Вставляет в JPEG EXIF с фокусным в пересчёте на 35 мм (FocalLengthIn35mmFilm) — как у фото с телефона."""
    import struct
    ifd0 = struct.pack("<H", 1) + struct.pack("<HHII", 0x8769, 4, 1, 8 + 18) + struct.pack("<I", 0)  # ссылка на Exif IFD
    exif_ifd = struct.pack("<H", 1) + struct.pack("<HHIHH", 0xA405, 3, 1, int(round(focal35)), 0) + struct.pack("<I", 0)
    payload = b"Exif\x00\x00" + b"II*\x00" + struct.pack("<I", 8) + ifd0 + exif_ifd
    data = path.read_bytes()
    assert data[:2] == b"\xff\xd8"
    path.write_bytes(data[:2] + b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload + data[2:])


def r3(a):
    return np.round(np.asarray(a, float), 3).tolist()


# ---------------------------------------------------------------- сцены

INK = (24, 24, 26)  # тонер лазерного принтера


class Scene:
    """Собирает сцену и запоминает, что где лежит."""

    def __init__(self, name, title, tags=(), size=(2000, 1500), samples=64, denoise=True, quality=90, ev=0.0, meter_pct=97,
                 exif_focal35=None):
        bpy.ops.wm.read_factory_settings(use_empty=True)
        sc = bpy.context.scene
        sc.render.engine = "CYCLES"
        prefs = bpy.context.preferences.addons["cycles"].preferences
        for dev in ("METAL", "OPTIX", "CUDA", "HIP", "ONEAPI"):
            try:
                prefs.compute_device_type = dev
                prefs.get_devices()
                if any(d.type == dev for d in prefs.devices):
                    for d in prefs.devices:
                        d.use = d.type == dev
                    sc.cycles.device = "GPU"
                    break
            except TypeError:
                continue
        sc.cycles.samples = samples
        sc.cycles.use_adaptive_sampling = denoise
        sc.cycles.use_denoising = denoise
        sc.cycles.seed = sum(map(ord, name))
        sc.cycles.max_bounces = 6
        sc.render.resolution_x, sc.render.resolution_y = size
        sc.render.resolution_percentage = 100
        sc.render.image_settings.file_format = "JPEG"
        sc.render.image_settings.quality = quality
        sc.view_settings.view_transform = "Standard"
        sc.view_settings.look = "None"
        sc.frame_set(1)
        self.name, self.title, self.tags = name, title, list(tags)
        self.ev, self.meter_pct = ev, meter_pct
        self.exif_focal35 = exif_focal35
        self.marker = None
        self.marker_polarity = "dark"
        self.samples: list[dict] = []
        self.cam = None

    def table(self, mat, size=3.0):
        flat("Стол", rect(size * 1000, size * 1000), mat, z=0.0)

    def sheet(self, mat=None, at=(0, 0), rot=0.0, size=PAPER_A4):
        flat("Лист", rect(*size), mat or paper(), at, rot, z=Z_PAPER)

    def add_marker(self, at=(-105, 62), rot=12.0, side=10.0, mat=None, polarity="dark"):
        ob, pts = flat("Эталон", rect(side, side), mat or matte("Тонер", INK, rough=0.55, spec=0.35), at, rot)
        self.marker = (ob, pts)
        self.marker_polarity = polarity
        return ob

    def sample(self, label, pts, mat, at, rot=0.0, seed=(0.0, 0.0), contrast="high"):
        ob, pts = flat(label, pts, mat, at, rot)
        self.samples.append({"ob": ob, "pts": pts, "seed": seed, "label": label, "contrast": contrast})
        return ob

    def meter(self, target=0.75):
        """Автоэкспозиция как у телефона: пробный рендер, яркие участки (бумага) -> ~225 из 255."""
        sc = bpy.context.scene
        st = sc.render.image_settings
        keep = (sc.render.resolution_percentage, sc.cycles.samples, sc.cycles.use_denoising, st.file_format)
        sc.render.resolution_percentage, sc.cycles.samples, sc.cycles.use_denoising = 8, 8, False
        st.file_format = "OPEN_EXR"
        path = PREVIEW / "_meter.exr"
        path.parent.mkdir(parents=True, exist_ok=True)
        sc.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        img = bpy.data.images.load(str(path))
        px = np.empty(len(img.pixels), np.float32)
        img.pixels.foreach_get(px)
        bpy.data.images.remove(img)
        path.unlink()
        lum = px.reshape(-1, 4)[:, :3] @ np.array([0.2126, 0.7152, 0.0722], np.float32)
        level = max(float(np.percentile(lum, self.meter_pct)), 1e-6)
        sc.render.resolution_percentage, sc.cycles.samples, sc.cycles.use_denoising, st.file_format = keep
        return math.log2(target / level)

    def truth(self) -> dict:
        """Что где лежит на будущем фото — запись для manifest.json."""
        sc = bpy.context.scene
        bpy.context.view_layer.update()
        W, H = sc.render.resolution_x, sc.render.resolution_y
        entry = {
            "file": f"{self.name}.jpg",
            "title": self.title,
            "tags": self.tags,
            "size": [W, H],
            "marker_size_mm": None,
            "marker_px": None,
            "marker_polarity": self.marker_polarity,
            "plane_mm_to_px": [[float(f"{v:.10g}") for v in row] for row in plane_homography(self.cam)],
            "camera": {
                "height_m": round(self.cam.location.z, 3),
                "tilt_deg": round(math.degrees(math.acos(max(-1, min(1, -(self.cam.matrix_world.to_3x3() @ Vector((0, 0, -1))).z)))), 1),
                "lens_mm": self.cam.data.lens,
            },
            "samples": [],
            "exif_focal35_mm": self.exif_focal35,
        }
        if self.marker:
            ob, pts = self.marker
            entry["marker_size_mm"] = round(abs(pts[1][0] - pts[0][0]), 6)
            entry["marker_px"] = r3(project(self.cam, to_world(ob, pts)))
        for s in self.samples:
            ob = s["ob"]
            entry["samples"].append({
                "label": s["label"],
                "area_mm2": round(abs(shoelace(s["pts"])), 4),
                "outline_px": r3(project(self.cam, to_world(ob, s["pts"]))),
                "seed_px": r3(project(self.cam, to_world(ob, [s["seed"]]))[0]),
                "contrast": s["contrast"],
            })
        return entry

    def render(self, preview=False) -> dict:
        sc = bpy.context.scene
        entry = self.truth()
        sc.view_settings.exposure = self.meter() + self.ev
        if preview:
            sc.render.resolution_percentage = 25
            sc.cycles.samples = min(sc.cycles.samples, 16)
            out = PREVIEW / entry["file"]
        else:
            out = OUT / entry["file"]
        out.parent.mkdir(parents=True, exist_ok=True)
        sc.render.filepath = str(out)
        bpy.ops.render.render(write_still=True)
        if self.exif_focal35 and not preview:
            add_exif_focal(out, self.exif_focal35)
        return entry


# Каждая функция строит одну сцену. Координаты на столе в мм: x вправо, y «от себя»; лист A4 по центру.

def s01_top_baseline():
    s = Scene("01_top_baseline", "Сверху, мягкий свет, бумага на деревянном столе", ["baseline"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker()
    s.sample("Лист с зубчиками", leaf(90, 45, teeth=9, tooth=0.07), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (15, 5), 20)
    s.sample("Лоскут 30×40", rect(30, 40), mottled("Терракота", (170, 80, 55), (190, 100, 70), 900), (-75, -45), -8)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-20, 5), 0.22)
    return s


def s02_tilt25():
    s = Scene("02_tilt_25", "Наклон камеры 25°, повёрнута вбок", ["perspective"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-70, 45), 31)
    s.sample("Клякса", blob(22, seed=2), mottled("Фиолет", (95, 60, 120), (120, 80, 140)), (45, -25), 0)
    s.sample("Лист", leaf(80, 38, teeth=0), mottled("Зелень", (70, 120, 45), (100, 150, 60)), (-15, -10), 65)
    world("courtyard.exr", 0.8, 40)
    lamp("AREA", (-0.2, 0.2, 0.8), energy=40, size=0.5)
    s.cam = camera((0, 0), 0.25, tilt=25, azim=-60, roll=4)
    return s


def s03_tilt45():
    s = Scene("03_tilt_45", "Наклон 45°, эталон повёрнут на 40°", ["perspective", "strong_tilt"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-30, 35), 40)
    s.sample("Звезда", star(26, 11, 6), mottled("Оранж", (215, 120, 30), (230, 140, 50)), (40, 0), 10, contrast="high")
    s.sample("Эллипс", ellipse(30, 18), mottled("Синий", (40, 80, 150), (55, 95, 170)), (-45, -40), 30)
    world("interior.exr", 0.6, 120)
    lamp("AREA", (0.1, 0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((0, 0), 0.26, tilt=45, azim=200)
    return s


def s04_tilt60():
    s = Scene("04_tilt_60", "Почти по касательной: наклон 60°", ["perspective", "strong_tilt", "extreme"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-25, 10), -15)
    s.sample("Подкова", c_shape(25, 14), mottled("Красный", (170, 35, 40), (190, 50, 55)), (35, -15), 90,
             seed=(-19.5, 0.0))
    s.sample("Лоскут 40×25", rect(40, 25), mottled("Хаки", (120, 120, 70), (135, 135, 85)), (-50, -45), 15)
    world("courtyard.exr", 0.9)
    lamp("AREA", (0, 0.3, 0.8), energy=50, size=0.6)
    s.cam = camera((0, -5), 0.25, tilt=60, azim=90)
    return s


def s05_hard_shadow():
    s = Scene("05_hard_shadow", "Резкая тень от кружки ложится на эталон", ["shadow"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-95, 55), 8)
    cylinder("Кружка", 40, 95, (-185, 130), matte("Керамика", (235, 235, 230), rough=0.15))
    s.sample("Лист", leaf(85, 40, teeth=7, tooth=0.05), mottled("Зелень", (60, 115, 42), (90, 140, 55)), (25, -10), -15)
    s.sample("Клякса", blob(18, seed=5), mottled("Охра", (190, 140, 50), (205, 155, 70)), (-60, -50))
    world("interior.exr", 0.25)
    sun_from(150, 28, 4.0, angle_deg=0.6)
    s.cam = camera((-25, 0), 0.24, tilt=10, azim=-100)
    return s


def s06_side_gradient():
    s = Scene("06_side_gradient", "Свет сбоку: одна сторона кадра в 6 раз темнее", ["lighting"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((95, 50), -20)
    s.sample("Лист", leaf(95, 42, teeth=11, tooth=0.06), mottled("Зелень", (65, 118, 44), (95, 148, 58)), (-20, -5), 170)
    s.sample("Эллипс", ellipse(20, 12), mottled("Бордо", (110, 30, 45), (130, 45, 60)), (60, -55), -30)
    world("night.exr", 0.15)
    lamp("SPOT", (-0.45, -0.05, 0.22), (0.05, 0, 0), energy=40, size=0.02, spot_deg=80)
    s.cam = camera((0, 0), 0.24, tilt=12, azim=-80)
    return s


def s07_glare():
    s = Scene("07_glare", "Глянцевый эталон с бликом от лампы", ["glare", "robustness"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-40, 30), 18, mat=matte("Глянцевый тонер", INK, rough=0.02, spec=1.0))
    s.sample("Лист", leaf(80, 40, teeth=6, tooth=0.05), mottled("Зелень", (60, 115, 42), (90, 140, 55)), (45, -25), 30)
    world("interior.exr", 0.4)
    s.cam = camera((0, 0), 0.24, tilt=28, azim=-90)
    # лампа в зеркальном положении относительно камеры: блик съедает угол эталона
    cam = s.cam.location
    m = Vector((-36.5 * MM, 33.5 * MM, Z_TOP))
    mirror = Vector((2 * m.x - cam.x, 2 * m.y - cam.y, cam.z))
    lamp("AREA", tuple(m + (mirror - m) * 2.2), tuple(m), energy=2.5, size=0.012)
    lamp("AREA", (0.2, -0.3, 0.9), energy=25, size=0.5)
    return s


def s08_flash():
    s = Scene("08_flash", "Вспышка телефона в темноте: пятно света и виньетка", ["lighting", "flash"], meter_pct=99.5)
    s.table(wood("Дерево", dark=True))
    s.sheet(paper("Глянцевая бумага", rough=0.3))
    s.add_marker((-80, 45), 25)
    s.sample("Лист", leaf(90, 45, teeth=8, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (20, -5), -25)
    s.sample("Клякса", blob(15, seed=11), mottled("Синий", (40, 70, 140), (55, 90, 160)), (-50, -45))
    world("night.exr", 0.05)
    s.cam = camera((-10, 0), 0.21, tilt=5, azim=-90)
    lamp("POINT", tuple(s.cam.location + Vector((0.012, 0.004, 0))), energy=1.2, size=0.002)
    return s


def s09_low_light():
    s = Scene("09_low_light", "Вечер, лампа накаливания: шум и сильное сжатие JPEG", ["noise", "jpeg"],
              samples=6, denoise=False, quality=68, ev=-0.8)
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-95, 50), -6)
    s.sample("Лист", leaf(85, 40, teeth=9, tooth=0.06), mottled("Зелень", (60, 115, 42), (90, 140, 55)), (15, 0), 40)
    s.sample("Лоскут 25×25", rect(25, 25), mottled("Серый", (110, 110, 115), (125, 125, 130), 900), (-70, -50), 20)
    world("night.exr", 0.1)
    lamp("POINT", (-0.25, 0.3, 0.5), energy=6, size=0.03, color=(1.0, 0.62, 0.32))
    s.cam = camera((-15, 0), 0.23, tilt=8, azim=-90)
    return s


def s10_dof():
    s = Scene("10_dof", "Малая глубина резкости: фокус на образце, эталон размыт", ["blur", "perspective"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-60, -55), 22)
    s.sample("Лист", leaf(90, 44, teeth=10, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (25, 40), 10)
    world("courtyard.exr", 0.8)
    lamp("AREA", (0, -0.1, 0.9), energy=50, size=0.6)
    s.cam = camera((0, 0), 0.38, tilt=38, azim=-90, lens=50, sensor=36, fstop=1.8, focus_mm=(25, 40))
    return s


def s11_motion():
    s = Scene("11_motion_blur", "Смаз от дрожания рук", ["blur"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-90, 50), 14)
    s.sample("Лист", leaf(85, 42, teeth=8, tooth=0.06), mottled("Зелень", (60, 115, 42), (90, 140, 55)), (20, 0), -30)
    s.sample("Звезда", star(18, 9, 5), mottled("Оранж", (215, 120, 30), (230, 140, 50)), (-55, -50))
    world("interior.exr", 0.6)
    lamp("AREA", (0, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-15, 0), 0.22, tilt=6, azim=-90)
    shake(s.cam)
    return s


def s12_cutting_mat():
    s = Scene("12_cutting_mat", "Зелёный коврик для резки с сеткой 1 см вместо бумаги", ["texture", "distractor"])
    s.table(wood("Дерево"))
    flat("Коврик", rect(450, 300), grid("Коврик", (40, 95, 70), (215, 225, 215), 10, 0.5, rough=0.5), (0, 0), 3, z=Z_PAPER)
    s.add_marker((-80, 40), 27)
    s.sample("Лист", leaf(90, 45, teeth=9, tooth=0.07), mottled("Желтизна", (200, 180, 60), (220, 200, 80)), (30, -10), 15)
    s.sample("Лоскут 30×40", rect(30, 40), mottled("Терракота", (170, 80, 55), (190, 100, 70), 900), (-60, -45), -12)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-10, 0), 0.23, tilt=10, azim=-80)
    return s


def s13_graph_paper():
    s = Scene("13_graph_paper", "Миллиметровка: тысячи квадратиков вокруг эталона", ["texture", "distractor"])
    s.table(wood("Дерево"))
    s.sheet(grid("Миллиметровка", (244, 240, 230), (225, 140, 80), 10, 0.25, 1, 0.08))
    s.add_marker((-75, 45), 0)  # ровно по сетке — самый коварный случай
    s.sample("Лист", leaf(90, 45, teeth=9, tooth=0.07), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (30, -10), 25)
    s.sample("Клякса", blob(17, seed=8), mottled("Синий", (40, 70, 140), (55, 90, 160)), (-60, -50))
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-10, 0), 0.22, tilt=7, azim=-90)
    return s


def s14_dark_distractors():
    s = Scene("14_dark_distractors", "Рядом чёрный телефон, монета, ручка и тёмная наклейка", ["distractor"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-25, 60), 9)
    box("Телефон", (72, 150, 8), (-150, -20), matte("Чёрный пластик", (18, 18, 20), rough=0.25), 8)
    cylinder("Монета", 11.5, 1.6, (-70, 75), matte("Никель", (170, 170, 165), rough=0.3, metallic=1.0))
    cylinder("Ручка", 4.5, 140, (40, 80), matte("Чёрная ручка", (20, 20, 25), rough=0.3), lying_deg=-8)
    flat("Наклейка", rect(16, 9), matte("Тёмная наклейка", (35, 30, 30)), (75, 30), 4)
    s.sample("Лист", leaf(80, 40, teeth=8, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (40, -35), 15)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-35, 10), 0.27, tilt=10, azim=-95)
    return s


def s15_two_squares():
    s = Scene("15_two_squares", "Два чёрных квадрата: 1 см (эталон) и 2 см", ["distractor", "ambiguous"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-90, 50), 10)
    flat("Квадрат 2 см", rect(20, 20), matte("Тонер2", INK, rough=0.55, spec=0.35), (85, 55), -12)
    s.sample("Лист", leaf(85, 42, teeth=8, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (0, -25), 5)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((0, 10), 0.25, tilt=6, azim=-90)
    return s


def s16_white_on_dark():
    s = Scene("16_white_on_dark", "Белый эталон на тёмной ткани", ["polarity", "texture"])
    s.table(fabric("Ткань", (18, 22, 40), (40, 46, 72)))
    s.add_marker((-70, 40), 15, mat=matte("Белая бумага", (240, 240, 236), rough=0.7), polarity="light")
    s.sample("Лист", leaf(85, 42, teeth=8, tooth=0.06), mottled("Желтизна", (210, 185, 70), (225, 200, 90)), (30, -10), -20)
    s.sample("Клякса", blob(16, seed=3), mottled("Розовый", (220, 140, 150), (235, 160, 170)), (-55, -45))
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-10, 0), 0.22, tilt=8, azim=-90)
    return s


def s17_small_far():
    s = Scene("17_small_far", "Снято издалека: эталон ~25 пикселей", ["small_marker"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-100, 60), 20)
    s.sample("Лист", leaf(100, 50, teeth=9, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (20, -5), 10)
    s.sample("Лоскут 50×30", rect(50, 30), mottled("Терракота", (170, 80, 55), (190, 100, 70), 900), (-80, -55), 5)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 1.1), energy=80, size=0.8)
    s.cam = camera((-10, 0), 0.6, tilt=4, azim=-90)
    return s


def s18_highres():
    s = Scene("18_highres_8mp", "8 Мп, пять образцов: от точки 5 мм до узкой полоски", ["highres", "multi"],
              size=(3264, 2448), quality=86)
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-20, 15), 33)
    s.sample("Лист", leaf(90, 44, teeth=10, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (-80, 30), 35)
    s.sample("Точка ⌀5", ellipse(2.5, 2.5, 120), mottled("Красный", (170, 35, 40), (190, 50, 55)), (5, 30))
    s.sample("Полоска 70×3", rect(70, 3), mottled("Синий", (40, 70, 140), (55, 90, 160)), (60, 55), 28)
    s.sample("Подкова", c_shape(20, 11), mottled("Фиолет", (95, 60, 120), (120, 80, 140)), (60, -40), -60, seed=(-15.5, 0.0))
    s.sample("Звезда", star(20, 8, 7), mottled("Оранж", (215, 120, 30), (230, 140, 50)), (-55, -55), 5)
    world("courtyard.exr", 0.8, 200)
    lamp("AREA", (0.1, -0.2, 0.9), energy=55, size=0.6)
    s.cam = camera((0, 0), 0.27, tilt=14, azim=-110, roll=-3)
    return s


def s19_occluded():
    s = Scene("19_occluded", "Ручка перекрывает угол эталона", ["occlusion", "robustness"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-80, 45), 5)
    cylinder("Ручка", 4.5, 140, (-56, 34), matte("Синяя ручка", (30, 60, 150), rough=0.3), lying_deg=-45)
    s.sample("Лист", leaf(85, 42, teeth=8, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (40, -30), 10)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-20, 5), 0.22, tilt=6, azim=-90)
    return s


def s20_no_marker():
    s = Scene("20_no_marker", "Эталона нет совсем", ["negative"])
    s.table(wood("Дерево"))
    s.sheet()
    s.sample("Лист", leaf(90, 45, teeth=9, tooth=0.07), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (15, 5), 20)
    flat("Квадратная наклейка", rect(12, 12), matte("Жёлтая наклейка", (235, 200, 60)), (-90, 50), 10)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-20, 5), 0.22)
    return s


def s21_low_contrast():
    s = Scene("21_low_contrast", "Светлые образцы на белой бумаге", ["low_contrast"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-100, 55), 3)
    s.sample("Бежевый лоскут", blob(24, seed=21), mottled("Беж", (226, 214, 192), (232, 222, 202), 900), (10, 0), 0,
             contrast="low")
    s.sample("Сухой лист", leaf(80, 40, teeth=6, tooth=0.05), mottled("Сухой", (205, 190, 150), (215, 200, 165)),
             (-55, -45), -20, contrast="low")
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-25, 0), 0.22, tilt=5, azim=-90)
    return s


def _series(name, title, cam_kw, size=(2000, 1500)):
    s = Scene(name, title, ["series"], size=size)
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-85, 40), 12)
    s.sample("Лист", leaf(95, 46, teeth=10, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (15, -10), 20)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera(**cam_kw)
    return s


def s22a():
    return _series("22_series_a", "Серия: один лист, близко сверху", dict(target_mm=(-30, 0), dist=0.2))


def s22b():
    return _series("22_series_b", "Серия: тот же лист, наклон 30° и поворот", dict(target_mm=(-20, 0), dist=0.3, tilt=30, azim=-40, roll=25))


def s22c():
    return _series("22_series_c", "Серия: тот же лист, издалека, вертикальный кадр",
                   dict(target_mm=(-30, 10), dist=0.38, azim=-180), size=(1500, 2000))


def s23_card_dark_table():
    s = Scene("23_card_dark_table", "Эталон на белой карточке, образцы на тёмном столе", ["texture", "card"])
    s.table(wood("Тёмное дерево", dark=True))
    flat("Карточка", rect(32, 32), paper("Карточка"), (-70, 45), 20, z=Z_PAPER)
    s.add_marker((-70, 45), 20)
    s.sample("Лист", leaf(90, 45, teeth=9, tooth=0.07), mottled("Зелень", (95, 160, 60), (120, 185, 75)), (25, -10), -10)
    s.sample("Лоскут 30×30", rect(30, 30), mottled("Светлый", (225, 215, 195), (235, 225, 205), 900), (-60, -45), 25)
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-15, 0), 0.22, tilt=9, azim=-85)
    return s




# ---------------------------------------------------------------- контрольные сцены
# Добавлены после настройки алгоритмов и проверены «вслепую»: другие объективы, EXIF, эталон в центре,
# поднос не формата A4, лист темнее стола. Нужны, чтобы убедиться, что точность — не подгонка под сцены выше

def s24():
    s = Scene("24_lens24_noexif", "Объектив 24 мм без EXIF (сайт думает, что 26 мм), наклон 15°", ["holdout", "perspective"])
    s.table(wood("Дерево"))
    s.sheet(rot=8)
    s.add_marker((-70, 45), 21)
    s.sample("Лист", leaf(85, 42, teeth=8, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (55, -40), 35)
    s.sample("Клякса", blob(15, seed=31), mottled("Охра", (190, 140, 50), (205, 155, 70)), (-20, -55))
    world("forest.exr", 0.7, 30)
    lamp("AREA", (0.1, -0.2, 0.9), energy=50, size=0.6)
    s.cam = camera((-5, -5), 0.19, tilt=15, azim=-120, lens=24)
    return s


def s25():
    s = Scene("25_lens28_exif", "Объектив 28 мм, фокусное в EXIF, наклон 9°", ["holdout", "perspective", "exif"], exif_focal35=28)
    s.table(wood("Дерево"))
    s.sheet(rot=-5)
    s.add_marker((80, 55), -14)
    s.sample("Звезда", star(22, 10, 5), mottled("Красный", (170, 35, 40), (190, 50, 55)), (-60, -45), 12)
    s.sample("Эллипс", ellipse(24, 14), mottled("Синий", (40, 80, 150), (55, 95, 170)), (-80, 30), -25)
    world("city.exr", 0.6, 200)
    lamp("AREA", (-0.1, 0.1, 0.9), energy=55, size=0.6)
    s.cam = camera((0, 0), 0.24, tilt=9, azim=-60, lens=28)
    return s


def s26():
    s = Scene("26_tele52_exif", "Телеобъектив 52 мм издалека, фокусное в EXIF, наклон 12°", ["holdout", "perspective", "exif"],
              exif_focal35=52)
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((-75, 50), 33)
    s.sample("Лист", leaf(90, 44, teeth=9, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (40, -20), -10)
    s.sample("Подкова", c_shape(18, 10), mottled("Фиолет", (95, 60, 120), (120, 80, 140)), (-60, -55), 40, seed=(-14.0, 0.0))
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 1.2), energy=80, size=0.7)
    s.cam = camera((-10, 0), 0.42, tilt=12, azim=-100, lens=52)
    return s


def s27():
    s = Scene("27_tele52_noexif", "Телеобъектив 52 мм без EXIF (сайт думает, что 26 мм), наклон 10°", ["holdout", "perspective"])
    s.table(wood("Дерево"))
    s.sheet(rot=12)
    s.add_marker((-55, 35), 5)
    s.sample("Лист", leaf(80, 40, teeth=7, tooth=0.05), mottled("Зелень", (65, 118, 44), (95, 148, 58)), (45, -30), 60)
    world("courtyard.exr", 0.8, 90)
    lamp("AREA", (0.1, -0.1, 1.1), energy=70, size=0.7)
    s.cam = camera((-5, 0), 0.36, tilt=10, azim=-75, lens=52)
    return s


def s28():
    s = Scene("28_center_marker", "Эталон в центре кадра, образцы по углам, наклон 6°", ["holdout", "ambiguous"])
    s.table(wood("Дерево"))
    s.sheet()
    s.add_marker((0, 0), 30)
    s.sample("Лист", leaf(70, 35, teeth=7, tooth=0.05), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (-90, 55), 15)
    s.sample("Клякса", blob(16, seed=41), mottled("Синий", (40, 70, 140), (55, 90, 160)), (95, -60))
    world("interior.exr", 0.6)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((0, 0), 0.25, tilt=6, azim=-140)
    return s


def s29():
    s = Scene("29_dark_table_tilt18", "Тёмный стол без бумаги, эталон на белой карточке, наклон 18°", ["holdout", "perspective"])
    s.table(wood("Тёмное дерево", dark=True))
    flat("Карточка", rect(30, 30), paper("Карточка"), (-60, 40), -8, z=Z_PAPER)
    s.add_marker((-60, 40), -8)
    s.sample("Лоскут 40×30", rect(40, 30), mottled("Светлый", (225, 215, 195), (235, 225, 205), 900), (50, -30), 20)
    s.sample("Лист", leaf(80, 40, teeth=8, tooth=0.06), mottled("Зелень", (95, 160, 60), (120, 185, 75)), (-30, -50), -35)
    world("sunrise.exr", 0.7, 60)
    lamp("AREA", (0.1, -0.1, 0.9), energy=55, size=0.6)
    s.cam = camera((-5, -5), 0.25, tilt=18, azim=-110)
    return s


def s30():
    s = Scene("30_white_tray", "Белый поднос 320×230 мм (не A4) целиком в кадре, наклон 20°", ["holdout", "perspective", "sheet"])
    s.table(wood("Дерево"))
    flat("Поднос", rect(320, 230), paper("Поднос", srgb=(236, 238, 240), rough=0.45), (0, 0), 0, z=Z_PAPER)
    s.add_marker((-100, 70), 17)
    s.sample("Лист", leaf(90, 44, teeth=9, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (60, -40), 25)
    s.sample("Звезда", star(20, 9, 6), mottled("Оранж", (215, 120, 30), (230, 140, 50)), (-40, -60))
    world("interior.exr", 0.6, 300)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((0, 0), 0.36, tilt=20, azim=-70)
    return s


def s31():
    s = Scene("31_blue_paper_white_table", "Голубой лист A4 на белом столе (лист темнее стола), наклон 14°", ["holdout", "perspective", "sheet"])
    s.table(matte("Белый стол", (238, 238, 236), rough=0.5))
    s.sheet(paper("Голубая бумага", srgb=(150, 190, 225)), rot=-7)
    s.add_marker((-90, 50), 9)
    s.sample("Лист", leaf(85, 42, teeth=8, tooth=0.06), mottled("Зелень", (58, 110, 40), (92, 145, 55)), (40, -25), 15)
    s.sample("Клякса", blob(17, seed=51), mottled("Красный", (170, 35, 40), (190, 50, 55)), (-55, -55))
    world("city.exr", 0.5)
    lamp("AREA", (0.05, -0.1, 0.9), energy=60, size=0.6)
    s.cam = camera((-10, 0), 0.27, tilt=14, azim=-95)
    return s


SCENES = [s01_top_baseline, s02_tilt25, s03_tilt45, s04_tilt60, s05_hard_shadow, s06_side_gradient, s07_glare,
          s08_flash, s09_low_light, s10_dof, s11_motion, s12_cutting_mat, s13_graph_paper, s14_dark_distractors,
          s15_two_squares, s16_white_on_dark, s17_small_far, s18_highres, s19_occluded, s20_no_marker,
          s21_low_contrast, s22a, s22b, s22c, s23_card_dark_table, s24, s25, s26, s27, s28, s29, s30, s31]


def save_manifest(path, manifest):
    manifest["about"] = ("Синтетические фото из Blender (backend/tests/blender/make_scenes.py). Координаты — пиксели фото, "
                         "центр левого верхнего пикселя = (0, 0). area_mm2 — точная площадь образца.")
    manifest["scenes"] = dict(sorted(manifest["scenes"].items()))
    text = json.dumps(manifest, ensure_ascii=False, indent=1)
    text = re.sub(r"\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]", r"[\1, \2]", text)  # точка [x, y] — в одну строку
    path.write_text(text, "utf-8")


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    preview = "--preview" in argv
    truth_only = "--truth-only" in argv  # только пересчитать manifest.json, картинки не трогать
    wanted = [a for a in argv if not a.startswith("--")]
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text("utf-8")) if manifest_path.exists() else {"scenes": {}}
    for build in SCENES:
        if wanted and not any(w in build.__name__ for w in wanted):
            continue
        scene = build()
        entry = scene.truth() if truth_only else scene.render(preview)
        print(f"[сцена] {scene.name}: готово", flush=True)
        if not preview:
            manifest["scenes"][scene.name] = entry
            save_manifest(manifest_path, manifest)  # после каждой сцены: прерванный рендер не теряет готовое


if __name__ == "__main__":
    main()
