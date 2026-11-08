"""Port Ardent city build (Blender, headless). Single entry point.

    blender -b --factory-startup -P tools/city/build.py -- [--no-previews] [--previews-only]

Reads tools/city/data/prepared.json (from prep.py), meshes everything with bpy,
and writes:
    tools/city/build/city_raw.glb        visual mesh (uncompressed; build.sh compresses it)
    apps/web/public/city/collision.glb   collision-only mesh
    apps/web/public/city/{landmarks,spawns,meta}.json
    tools/city/previews/*.png            preview renders
Blender is Z-up; the glTF exporter converts to Y-up: glTF (x, y, z) = Blender (x, z, -y).
"""
import json
import math
import random
import sys
import time
from pathlib import Path

import bpy
import bmesh
import numpy as np
from mathutils import Vector, noise
from mathutils.bvhtree import BVHTree

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
sys.path.insert(0, str(HERE))
import geo  # noqa: E402
import textures  # noqa: E402

PREP = HERE / "data" / "prepared.json"
BUILD_DIR = HERE / "build"
PUB = ROOT / "apps" / "web" / "public" / "city"
PREVIEWS = HERE / "previews"

ARGV = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
T0 = time.time()
rng = random.Random(geo.SEED + 1)
noise.seed_set(geo.SEED)

WATER_Z = -1.6
QUAY_BOTTOM = -3.2
FLOOR_H = 12.8  # facade texture covers 4 floors (12.8 m) ...
BAY_W = 12.0    # ... and 4 bays (12 m)


def log(*a):
    print(f"[build {time.time() - T0:6.1f}s]", *a, flush=True)


def srgb2lin(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def lin(rgb, k=1.0):
    return (srgb2lin(min(1.0, rgb[0] * k)), srgb2lin(min(1.0, rgb[1] * k)), srgb2lin(min(1.0, rgb[2] * k)), 1.0)


def h01(*v):
    """Deterministic hash -> [0,1)."""
    n = 0
    for x in v:
        n = (n * 1000003) ^ (int(round(x * 1000)) & 0xFFFFFFFF)
    n = (n ^ (n >> 15)) * 2246822519 & 0xFFFFFFFF
    n = (n ^ (n >> 13)) * 3266489917 & 0xFFFFFFFF
    return ((n ^ (n >> 16)) & 0xFFFFFF) / float(0x1000000)


# ============================================================================ accumulators

class Acc:
    """Geometry bucket for one material (and tile)."""

    __slots__ = ("co", "faces", "uv", "col", "smooth")

    def __init__(self):
        self.co, self.faces, self.uv, self.col, self.smooth = [], [], [], [], []

    def poly(self, pts, uvs, cols, smooth=False):
        b = len(self.co)
        self.co.extend(pts)
        self.faces.append(tuple(range(b, b + len(pts))))
        self.uv.extend(uvs)
        self.col.extend(cols if isinstance(cols, list) else [cols] * len(pts))
        self.smooth.append(smooth)

    def indexed(self, verts, faces, uv_fn, col_fn, smooth=False):
        """Shared-vertex mesh. uv_fn(vi) / col_fn(vi) give per-vertex values."""
        b = len(self.co)
        self.co.extend(verts)
        for f in faces:
            self.faces.append(tuple(b + i for i in f))
            for i in f:
                self.uv.append(uv_fn(i))
                self.col.append(col_fn(i))
            self.smooth.append(smooth)

    def ntris(self):
        return sum(len(f) - 2 for f in self.faces)


class Buckets:
    def __init__(self, tiled=True):
        self.d = {}
        self.tiled = tiled

    def get(self, mat, x=0.0, y=0.0):
        tile = (1 if x >= 0 else 0) + (2 if y >= 0 else 0) if self.tiled else 0
        k = (mat, tile)
        a = self.d.get(k)
        if a is None:
            a = self.d[k] = Acc()
        return a


VIS = Buckets()


class Col:
    """Collision soup (indexed, no attributes)."""

    def __init__(self):
        self.co, self.faces = [], []

    def poly(self, pts):
        b = len(self.co)
        self.co.extend(pts)
        self.faces.append(tuple(range(b, b + len(pts))))

    def indexed(self, verts, faces):
        b = len(self.co)
        self.co.extend(verts)
        self.faces.extend(tuple(b + i for i in f) for f in faces)

    def ntris(self):
        return sum(len(f) - 2 for f in self.faces)


COL = Col()

# ============================================================================ materials

MAT_DEF = {
    # name: (texture, roughness, metallic, uses vertex colour)
    "facade_brick": ("facade_brick", 0.85, 0.0),
    "facade_plaster": ("facade_plaster", 0.85, 0.0),
    "facade_stone": ("facade_stone", 0.8, 0.0),
    "wall_party": ("wall_party", 0.9, 0.0),
    "wall_inner": ("wall_inner", 0.95, 0.0),
    "roof_tiles": ("roof_tiles", 0.6, 0.0),
    "roof_flat": ("roof_flat", 0.75, 0.0),
    "rubble": ("rubble", 0.95, 0.0),
    "char": ("char", 0.95, 0.0),
    "asphalt": ("asphalt", 0.32, 0.0),
    "cobble": ("cobble", 0.45, 0.0),
    "pave": ("pave", 0.7, 0.0),
    "mud": ("mud", 0.8, 0.0),
    "grass": ("grass", 0.95, 0.0),
    "water": (None, 0.06, 0.0),
    "quay": ("quay", 0.75, 0.0),
    "bridge": ("quay", 0.8, 0.0),
    "crater": ("scorch", 0.95, 0.0),
    "metal": ("metal", 0.7, 0.4),
    "steel": ("metal", 0.55, 0.6),
    "wood": ("wood", 0.85, 0.0),
    "bark": ("bark", 0.95, 0.0),
    "field": ("mud", 0.9, 0.0),
}
TEX_SCALE = {}  # metres per texture repeat (documented in uv code)
IMAGES = {}


def make_images():
    for name, fn in textures.ALL.items():
        a = fn()
        h, w, _ = a.shape
        rgba = np.concatenate([a, np.ones((h, w, 1), np.float32)], -1)
        img = bpy.data.images.new(name, w, h, alpha=False)
        img.colorspace_settings.name = "sRGB"
        # pixels are stored linear-as-given for generated float buffers; we gave display values
        img.pixels.foreach_set(rgba.ravel())
        img.file_format = "PNG"
        img.pack()
        IMAGES[name] = img


MATS = {}


def make_materials():
    for name, (tex, rough, metal) in MAT_DEF.items():
        m = bpy.data.materials.new(name)
        try:
            m.use_nodes = True
        except Exception:
            pass
        m.use_backface_culling = True
        nt = m.node_tree
        bsdf = next(n for n in nt.nodes if n.type == "BSDF_PRINCIPLED")
        bsdf.inputs["Roughness"].default_value = rough
        bsdf.inputs["Metallic"].default_value = metal
        vc = nt.nodes.new("ShaderNodeVertexColor")
        vc.layer_name = "Color"
        vc.location = (-600, 200)
        if name == "water":
            bsdf.inputs["Base Color"].default_value = (0.020, 0.024, 0.022, 1)
            bsdf.inputs["Roughness"].default_value = rough
            nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
        else:
            it = nt.nodes.new("ShaderNodeTexImage")
            it.image = IMAGES[tex]
            it.location = (-600, 450)
            mix = nt.nodes.new("ShaderNodeMix")
            mix.data_type = "RGBA"
            mix.blend_type = "MULTIPLY"
            mix.inputs[0].default_value = 1.0
            mix.location = (-300, 300)
            nt.links.new(it.outputs["Color"], mix.inputs[6])
            nt.links.new(vc.outputs["Color"], mix.inputs[7])
            nt.links.new(mix.outputs[2], bsdf.inputs["Base Color"])
        MATS[name] = m


# ============================================================================ primitives

def box_faces(cx, cy, cz, hx, hy, hz, ang=0.0, tilt=(0.0, 0.0)):
    """8 corners of an oriented box + 6 quads (outward). tilt = (roll about local x, pitch about local y)."""
    ca, sa = math.cos(ang), math.sin(ang)
    cr, sr = math.cos(tilt[0]), math.sin(tilt[0])
    cp, sp = math.cos(tilt[1]), math.sin(tilt[1])
    pts = []
    for sx, sy, sz in ((-1, -1, -1), (1, -1, -1), (1, 1, -1), (-1, 1, -1),
                       (-1, -1, 1), (1, 1 * -1, 1), (1, 1, 1), (-1, 1, 1)):
        x, y, z = sx * hx, sy * hy, sz * hz
        y, z = y * cr - z * sr, y * sr + z * cr
        x, z = x * cp + z * sp, -x * sp + z * cp
        pts.append((cx + x * ca - y * sa, cy + x * sa + y * ca, cz + z))
    faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
    return pts, faces


def add_box(acc, cx, cy, cz, hx, hy, hz, ang=0.0, col=(1, 1, 1, 1), tilt=(0.0, 0.0), uvs=0.5, col_out=None, skip=()):
    pts, faces = box_faces(cx, cy, cz, hx, hy, hz, ang, tilt)
    for fi, f in enumerate(faces):
        if fi in skip:
            continue
        p = [pts[i] for i in f]
        # simple box mapping by face extents
        e1 = Vector(p[1]) - Vector(p[0])
        e2 = Vector(p[3]) - Vector(p[0])
        l1, l2 = e1.length * uvs, e2.length * uvs
        acc.poly(p, [(0, 0), (l1, 0), (l1, l2), (0, l2)], col)
    if col_out is not None:
        col_out.indexed(pts, faces)


def add_beam(acc, a, b, r, col, sides=4, uvs=1.0, caps=False):
    """Smooth-shaded prism from point a to b (3D) with radius r (shared vertices)."""
    a, b = Vector(a), Vector(b)
    d = b - a
    L = d.length
    if L < 1e-4:
        return
    d.normalize()
    up = Vector((0, 0, 1)) if abs(d.z) < 0.95 else Vector((1, 0, 0))
    u = d.cross(up).normalized()
    v = d.cross(u).normalized()
    verts = []
    for k in range(sides):
        t = 2 * math.pi * (k + 0.5) / sides
        o = u * (math.cos(t) * r) + v * (math.sin(t) * r)
        verts.append(tuple(a + o))
    for k in range(sides):
        t = 2 * math.pi * (k + 0.5) / sides
        o = u * (math.cos(t) * r) + v * (math.sin(t) * r)
        verts.append(tuple(b + o))
    faces = [(k, (k + 1) % sides, sides + (k + 1) % sides, sides + k) for k in range(sides)]
    if caps:
        faces.append(tuple(reversed(range(sides))))
        faces.append(tuple(range(sides, 2 * sides)))
    acc.indexed(verts, faces, lambda i: ((i % sides) / sides, (i // sides) * L * uvs),
                (lambda i: col), smooth=True)


def facing(pts, want):
    """Return pts ordered so the polygon normal points along `want` (Vector)."""
    a, b, c = Vector(pts[0]), Vector(pts[1]), Vector(pts[2])
    n = (b - a).cross(c - a)
    if n.dot(want) < 0:
        return list(reversed(pts))
    return pts


# ============================================================================ buildings

FACADE = {"brick": "facade_brick", "plaster": "facade_plaster", "stone": "facade_stone"}


GAIN = 1.3  # albedo lift: the OSM-derived tints read too dark under overcast light


def wall_cols(tint, z0, z1, top_k):
    bottom = lin(tint, 0.7 * GAIN)
    top = lin(tint, top_k * GAIN)
    return [bottom, bottom, top, top]


def emit_walls(acc_for_edge, ring, z0_fn, z1_fn, tint, top_k, reverse=False, u0=0.0, skip=None, col_fn=None):
    """Vertical quads along ring edges. acc_for_edge(k) -> Acc or None to skip."""
    n = len(ring)
    u = u0
    for k in range(n):
        a = ring[k]
        b = ring[(k + 1) % n]
        L = math.hypot(b[0] - a[0], b[1] - a[1])
        if L < 1e-4:
            continue
        acc = acc_for_edge(k)
        ua, ub = u / BAY_W, (u + L) / BAY_W
        u += L
        if acc is None:
            continue
        za0, za1 = z0_fn(a), z1_fn(a)
        zb0, zb1 = z0_fn(b), z1_fn(b)
        if za1 <= za0 + 0.01 and zb1 <= zb0 + 0.01:
            continue
        pts = [(a[0], a[1], za0), (b[0], b[1], zb0), (b[0], b[1], zb1), (a[0], a[1], za1)]
        uvs = [(ua, za0 / FLOOR_H), (ub, zb0 / FLOOR_H), (ub, zb1 / FLOOR_H), (ua, za1 / FLOOR_H)]
        if col_fn:
            cols = [col_fn(a, za0), col_fn(b, zb0), col_fn(b, zb1), col_fn(a, za1)]
        else:
            cols = wall_cols(tint, za0, za1, top_k)
        if reverse:
            pts.reverse()
            uvs.reverse()
            cols.reverse()
        acc.poly(pts, uvs, cols)


def emit_cap(acc, tri, z_fn, col, uv_scale=6.0, up=True, smooth=True):
    v = tri["v"]
    verts = [(x, y, z_fn((x, y))) for x, y in v]
    faces = [tuple(t) if up else tuple(reversed(t)) for t in tri["t"]]
    acc.indexed(verts, faces, lambda i: (verts[i][0] / uv_scale, verts[i][1] / uv_scale),
                (lambda i: col) if not callable(col) else col, smooth=smooth)


def roof_geometry(b, z0):
    """Pitched roof faces for an intact building: list of (pts, kind) with kind 'roof'|'gable'."""
    shape, rh = b["roof"], b["roof_h"]
    out = []
    if shape in ("gabled", "hipped") and b["obb"]:
        ob = b["obb"]
        cx, cy = ob["c"]
        ax = Vector((ob["ax"][0], ob["ax"][1], 0))
        pr = Vector((-ax.y, ax.x, 0))
        L, W = ob["L"] / 2 + 0.25, ob["W"] / 2 + 0.35
        c = Vector((cx, cy, z0))
        inset = 0.0 if shape == "gabled" else min(W, L * 0.45)
        r0 = c - ax * (L - inset) + Vector((0, 0, rh))
        r1 = c + ax * (L - inset) + Vector((0, 0, rh))
        p00 = c - ax * L - pr * W
        p10 = c + ax * L - pr * W
        p11 = c + ax * L + pr * W
        p01 = c - ax * L + pr * W
        out.append(([p00, p10, r1, r0], "roof"))
        out.append(([p11, p01, r0, r1], "roof"))
        if shape == "gabled":
            out.append(([p10, p11, r1], "gable"))
            out.append(([p01, p00, r0], "gable"))
        else:
            out.append(([p10, p11, r1], "roof"))
            out.append(([p01, p00, r0], "roof"))
    return out


def roof_uv(p, b):
    ob = b["obb"]
    ax = Vector((ob["ax"][0], ob["ax"][1], 0)) if ob else Vector((1, 0, 0))
    pr = Vector((-ax.y, ax.x, 0))
    q = Vector(p)
    return (q.dot(ax) / 6.0, (abs(q.dot(pr)) + q.z) / 6.0)


def emit_intact(b):
    cx, cy = b["centroid"]
    tint = b["tint"]
    fac = FACADE[b["mat"]]
    eave = b["eave"]
    rings = b["rings"]
    roof_t = b["roof_tint"]
    top_k = 0.95
    if b.get("holes"):
        emit_holed_prism(b)
    else:
        for ri, ring in enumerate(rings):
            edges = b["edges"] if ri == 0 else [0] * len(ring)

            def acc_for(k, edges=edges):
                if edges[k] == 2:
                    return None
                return VIS.get("wall_party" if edges[k] == 1 else fac, cx, cy)

            emit_walls(acc_for, ring, lambda p: -0.3, lambda p: eave, tint, top_k)
        if b["roof"] in ("flat",) or (b["roof"] in ("gabled", "hipped") and not b["obb"]):
            if b.get("roof_holes"):
                emit_roof_holes(b)
            else:
                emit_cap(VIS.get("roof_flat", cx, cy), b["cap"], lambda p: eave, flat_roof_col(b))
    emit_roof(b, eave)
    emit_collision_building(b)


def emit_roof_holes(b):
    """Flat roof with shell holes: dark shafts down to a debris-covered floor below."""
    cx, cy = b["centroid"]
    eave = b["eave"]
    emit_cap(VIS.get("roof_flat", cx, cy), b["roof_cap"], lambda p: eave, flat_roof_col(b))
    depth = min(3.4, eave - 0.5)
    iacc = VIS.get("wall_inner", cx, cy)
    for ring in b["roof_holes"]:
        emit_walls(lambda k: iacc, ring, lambda p: eave - depth, lambda p: eave, (0.6, 0.56, 0.5), 0.8, reverse=True,
                   col_fn=lambda p, z: lin((0.55, 0.5, 0.45), 0.35 + 0.4 * (z - eave + depth) / depth))
        n = len(ring)
        fl = [(x, y, eave - depth + 0.2 * h01(x, y)) for x, y in ring]
        VIS.get("rubble", cx, cy).poly(fl, [(p[0] / 3, p[1] / 3) for p in fl], lin((0.45, 0.42, 0.38), 0.6))
        # torn roofing flaps around the rim
        for k in range(0, n, 3):
            a, c = ring[k], ring[(k + 1) % n]
            mx, my = (a[0] + c[0]) / 2, (a[1] + c[1]) / 2
            dx, dy = mx - sum(q[0] for q in ring) / n, my - sum(q[1] for q in ring) / n
            L = math.hypot(dx, dy) or 1
            add_box(VIS.get("roof_flat", cx, cy), mx + dx / L * 0.6, my + dy / L * 0.6, eave + 0.15, 0.7, 0.5, 0.06,
                    math.atan2(dy, dx), flat_roof_col(b), tilt=(0.3 * (h01(k, mx) - 0.5), 0.4), uvs=0.3)


def flat_roof_col(b):
    g = 0.30 + 0.16 * h01(b["id"], 77)
    return lin((g, g * 0.98, g * 0.95))


def emit_broken_beams(b, H):
    """Charred joists sticking out of a collapsed building's broken top."""
    ring = b["shell"]["outer"][0]
    cx, cy = b["centroid"]
    acc = VIS.get("wood", cx, cy)
    n = len(ring)
    for j in range(1 + int(h01(b["id"], 31) * 3)):
        k = int(h01(b["id"], j, 32) * n)
        a = ring[k]
        z = max(b["cut"]["floor"] + 0.5, H(a) - 0.6 - 1.5 * h01(b["id"], j, 33))
        dx, dy = cx - a[0], cy - a[1]
        L = math.hypot(dx, dy) or 1.0
        ln = 2.0 + 3.0 * h01(b["id"], j, 34)
        out = 0.8 + 1.6 * h01(b["id"], j, 35)
        p0 = (a[0] - dx / L * out, a[1] - dy / L * out, z + 0.6 * (h01(b["id"], j, 36) - 0.3))
        p1 = (a[0] + dx / L * ln, a[1] + dy / L * ln, z - 1.2 * h01(b["id"], j, 37))
        add_beam(acc, p0, p1, 0.12, lin((0.22, 0.19, 0.16)), sides=4, uvs=0.3)


def emit_rafters(b, eave):
    """Roof skeleton: tiles blown off one or both slopes, rafters left standing."""
    ob = b["obb"]
    cx, cy = ob["c"]
    ax = Vector((ob["ax"][0], ob["ax"][1], 0))
    pr = Vector((-ax.y, ax.x, 0))
    L, W = ob["L"] / 2 + 0.25, ob["W"] / 2 + 0.35
    c = Vector((cx, cy, eave))
    rh = b["roof_h"]
    acc = VIS.get("wood", cx, cy)
    col = lin((0.30, 0.26, 0.22))
    sides = {0: (-1,), 1: (1,), 2: (-1, 1)}[b["rafters"]]
    add_beam(acc, c - ax * L + Vector((0, 0, rh)), c + ax * L + Vector((0, 0, rh)), 0.12, col, uvs=0.3)
    m = max(2, int(2 * L / 0.9))
    for i in range(m + 1):
        t = -L + 2 * L * i / m
        if h01(b["id"], i, 41) < 0.2:
            continue  # snapped
        for s in sides:
            top = c + ax * t + Vector((0, 0, rh))
            bot = c + ax * t + pr * (s * W)
            if h01(b["id"], i, s, 42) < 0.25:
                bot = top.lerp(bot, 0.4 + 0.4 * h01(b["id"], i, 43))
            add_beam(acc, bot, top, 0.07, col, uvs=0.3)
    # rubble-strewn attic floor under the skeleton
    emit_cap(VIS.get("rubble", cx, cy), b["cap"], lambda p: eave + 0.05, lin((0.55, 0.5, 0.45)), uv_scale=3.0)


def emit_roof(b, eave):
    cx, cy = b["centroid"]
    roof_t = b["roof_tint"]
    shape = b["roof"]
    if shape in ("gabled", "hipped") and b["obb"]:
        racc = VIS.get("roof_tiles", cx, cy)
        facc = VIS.get(FACADE[b["mat"]], cx, cy)
        gone = {0: {0}, 1: {1}, 2: {0, 1}}.get(b.get("rafters"), set())
        if gone:
            emit_rafters(b, eave)
        for fi, (pts, kind) in enumerate(roof_geometry(b, eave)):
            if kind == "roof" and fi in gone:
                continue
            if kind == "roof":
                pts = facing(pts, Vector((0, 0, 1)))
                cols = [lin(roof_t, 0.8 + 0.4 * h01(p.x, p.y, 3)) for p in pts]
                racc.poly([tuple(p) for p in pts], [roof_uv(p, b) for p in pts], cols)
            else:
                cen = Vector((b["obb"]["c"][0], b["obb"]["c"][1], eave))
                mid = (pts[0] + pts[1]) * 0.5
                pts = facing(pts, (mid - cen).normalized())
                ob = b["obb"]
                pr = Vector((-ob["ax"][1], ob["ax"][0], 0))
                uvs = [(Vector(p).dot(pr) / BAY_W, p.z / FLOOR_H) for p in pts]
                cols = [lin(b["tint"], 0.95 if p.z > eave + 0.1 else 0.9) for p in pts]
                facc.poly([tuple(p) for p in pts], uvs, cols)
    elif shape == "pyramidal":
        ring = b["rings"][0]
        n = len(ring)
        ax_, ay_ = sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n
        apex = Vector((ax_, ay_, eave + b["roof_h"]))
        tr = b.get("truncate", 0.0)
        mat = "roof_tiles" if b["mat"] != "stone" or b["roof_h"] < 12 else "facade_stone"
        if b["lm"] and b["roof_h"] >= 12:
            mat = "roof_tiles"
        racc = VIS.get(mat, cx, cy)
        top_ring = []
        for k in range(n):
            a = Vector((ring[k][0], ring[k][1], eave))
            c = Vector((ring[(k + 1) % n][0], ring[(k + 1) % n][1], eave))
            if tr > 0:
                f = 1 - tr
                ta = a.lerp(apex, f)
                tc = c.lerp(apex, f)
                ta.z += (h01(k, 1) - 0.5) * 2.0
                pts = [a, c, tc, ta]
                top_ring.append(ta)
            else:
                pts = [a, c, apex]
            pts = facing(pts, (a + c) * 0.5 - Vector((ax_, ay_, eave)) + Vector((0, 0, 0.5)))
            cols = [lin(b["roof_tint"], 0.75 if p.z > eave + 0.1 else 0.9) for p in pts]
            racc.poly([tuple(p) for p in pts], [((p.x + p.y) / 6.0, p.z / 6.0) for p in pts], cols)
        if tr > 0 and len(top_ring) >= 3:
            acc = VIS.get("rubble", cx, cy)
            pts = facing(top_ring, Vector((0, 0, 1)))
            acc.poly([tuple(p) for p in pts], [(p.x / 4, p.y / 4) for p in pts], lin((0.5, 0.48, 0.45)))
    if b.get("crenel"):
        acc = VIS.get(FACADE[b["mat"]], cx, cy)
        for ring in b["rings"][:1]:
            n = len(ring)
            for k in range(n):
                a, c = Vector((*ring[k], 0)), Vector((*ring[(k + 1) % n], 0))
                L = (c - a).length
                if L < 2:
                    continue
                d = (c - a) / L
                nrm = Vector((d.y, -d.x, 0))
                m = int(L / 1.8)
                for j in range(m):
                    if h01(k, j, 7) < 0.18:
                        continue  # knocked off
                    p = a + d * ((j + 0.5) * L / m) - nrm * 0.3
                    add_box(acc, p.x, p.y, eave + 0.55, 0.42, 0.3, 0.55, math.atan2(d.y, d.x),
                            lin(b["tint"], 0.8), uvs=1 / 12.0)
    if b.get("antenna"):
        ring = b["rings"][0]
        n = len(ring)
        ax_, ay_ = sum(p[0] for p in ring) / n, sum(p[1] for p in ring) / n
        base = eave + b["roof_h"] * (1 - b.get("truncate", 0))
        emit_antenna(ax_, ay_, base)


def emit_antenna(x, y, z0):
    """Bent lattice radio mast on top of the belfry stump."""
    acc = VIS.get("steel", x, y)
    col = lin((0.35, 0.33, 0.31))
    H = 22.0
    segs = 8
    pts = []
    for i in range(segs + 1):
        t = i / segs
        bend = max(0.0, t - 0.55) ** 2 * 9.0
        w = 1.1 * (1 - t) + 0.25
        pts.append((Vector((x + bend, y + bend * 0.4, z0 + H * t)), w))
    legs = [(-1, -1), (1, -1), (1, 1), (-1, 1)]
    for i in range(segs):
        (c0, w0), (c1, w1) = pts[i], pts[i + 1]
        for lx, ly in legs:
            add_beam(acc, c0 + Vector((lx * w0, ly * w0, 0)), c1 + Vector((lx * w1, ly * w1, 0)), 0.07, col)
        for j in range(4):
            lx, ly = legs[j]
            mx, my = legs[(j + 1) % 4]
            add_beam(acc, c0 + Vector((lx * w0, ly * w0, 0)), c1 + Vector((mx * w1, my * w1, 0)), 0.04, col)
    # dangling dish
    top = pts[-1][0]
    add_box(acc, top.x + 0.6, top.y, top.z - 2.5, 0.05, 0.9, 0.9, 0.3, col, tilt=(0.5, 0.2), uvs=1.0)
    COL.indexed(*box_faces(x, y, z0 + H / 2, 1.3, 1.3, H / 2))


def collapse_height(b, p, outer=True):
    cut = b["cut"]
    x, y = p
    c = cut["c"]
    d = cut["dir"]
    base = cut["h"] + cut["slope"] * ((x - c[0]) * d[0] + (y - c[1]) * d[1])
    n = noise.noise(Vector((x * 0.21, y * 0.21, cut["seed"] % 997 * 0.13)))
    j = h01(x, y, cut["seed"]) - 0.5
    h = base + cut["amp"] * (0.75 * n + 0.9 * j)
    lo = cut["floor"] + 0.6 if b["dmg"] == "collapsed" else 0.35
    return max(lo, min(b["eave"], h))


def edge_flag_lookup(b):
    """For densified rings: map a segment midpoint to the original edge flag."""
    ring = b["rings"][0]
    flags = b["edges"]
    segs = []
    for k in range(len(ring)):
        if flags[k]:
            a, c = ring[k], ring[(k + 1) % len(ring)]
            segs.append((a, c, flags[k]))

    def look(a, c):
        if not segs:
            return 0
        mx, my = (a[0] + c[0]) / 2, (a[1] + c[1]) / 2
        for p, q, f in segs:
            dx, dy = q[0] - p[0], q[1] - p[1]
            L2 = dx * dx + dy * dy
            if L2 < 1e-6:
                continue
            t = ((mx - p[0]) * dx + (my - p[1]) * dy) / L2
            if -0.01 <= t <= 1.01:
                px, py = p[0] + t * dx, p[1] + t * dy
                if (px - mx) ** 2 + (py - my) ** 2 < 0.01:
                    return f
        return 0

    return look


def emit_damaged(b):
    cx, cy = b["centroid"]
    tint = b["tint"]
    fac = FACADE[b["mat"]]
    sh = b["shell"]
    cut = b["cut"]
    burned = b.get("gutted") or h01(cut["seed"], 5) < 0.3
    tk = 0.55 if burned else 1.0
    look = edge_flag_lookup(b)
    hz = {}

    def H(p):
        k = (round(p[0], 3), round(p[1], 3))
        v = hz.get(k)
        if v is None:
            v = hz[k] = collapse_height(b, p)
        return v

    def col_fn(p, z):
        # grime at the base, soot along the broken top
        k = (0.7 + 0.3 * min(1.0, max(0.0, z) / 3.0)) * GAIN
        if z >= H(p) - 0.01:
            k *= 0.55
        return lin(tint, k * tk)

    for ri, ring in enumerate(sh["outer"]):
        flags = []
        n = len(ring)
        for k in range(n):
            flags.append(look(ring[k], ring[(k + 1) % n]) if ri == 0 else 0)

        def acc_for(k, flags=flags):
            if flags[k] == 2:
                return None
            return VIS.get("wall_party" if flags[k] == 1 else fac, cx, cy)

        emit_walls(acc_for, ring, lambda p: -0.3, H, tint, 0.5, col_fn=col_fn)
    fl = cut["floor"]
    inner_acc = VIS.get("wall_inner", cx, cy)
    for poly in sh["inner"]:
        for ring in poly:
            emit_walls(lambda k: inner_acc, ring, lambda p: fl, H, tint, 0.5, reverse=True,
                       col_fn=lambda p, z: lin((0.70, 0.66, 0.60), (0.6 + 0.4 * min(1, (z - fl) / 3)) * tk))
    top_col = lin((0.66, 0.61, 0.55), 1.0 * tk)
    emit_cap(VIS.get("rubble", cx, cy), sh["strip"], H, top_col, uv_scale=3.0)
    if sh["floor"]:
        emit_cap(VIS.get("rubble", cx, cy), sh["floor"], lambda p: fl + 0.25 * h01(p[0], p[1], 2),
                 lin((0.62, 0.58, 0.53), 0.95 * tk), uv_scale=4.0)
    if b["dmg"] == "collapsed" and b["core"]:
        emit_broken_beams(b, H)
    emit_collision_building(b)


def emit_holed_prism(b):
    """Intact walls + flat top as a closed solid, minus bomb-hole spheres (Blender boolean)."""
    cx, cy = b["centroid"]
    eave = b["eave"]
    tint = b["tint"]
    fac = FACADE[b["mat"]]
    roof_flat = b["roof"] == "flat" or not b["obb"]
    bm = bmesh.new()
    uv_l = bm.loops.layers.uv.new("UVMap")
    col_l = bm.loops.layers.float_color.new("Color")
    rings = b["rings"]
    bot, top = [], []
    for ring in rings:
        bot.append([bm.verts.new((x, y, -0.3)) for x, y in ring])
        top.append([bm.verts.new((x, y, eave)) for x, y in ring])
    bm.verts.ensure_lookup_table()
    # walls
    for ri, ring in enumerate(rings):
        n = len(ring)
        u = 0.0
        for k in range(n):
            a, c = ring[k], ring[(k + 1) % n]
            L = math.hypot(c[0] - a[0], c[1] - a[1])
            try:
                f = bm.faces.new((bot[ri][k], bot[ri][(k + 1) % n], top[ri][(k + 1) % n], top[ri][k]))
            except ValueError:
                u += L
                continue
            party = ri == 0 and b["edges"][k] >= 1
            f.material_index = 3 if party else 0
            uvs = [(u / BAY_W, -0.3 / FLOOR_H), ((u + L) / BAY_W, -0.3 / FLOOR_H),
                   ((u + L) / BAY_W, eave / FLOOR_H), (u / BAY_W, eave / FLOOR_H)]
            cols = wall_cols(tint, 0, eave, 0.95)
            for lp, uv, cc in zip(f.loops, uvs, cols):
                lp[uv_l].uv = uv
                lp[col_l] = cc
            u += L
    # caps from the CDT (indices map onto ring vertices by coordinate)
    lookup = {}
    for ri, ring in enumerate(rings):
        for k, (x, y) in enumerate(ring):
            lookup[(round(x, 3), round(y, 3))] = (ri, k)
    cap = b["cap"]
    ok = True
    rcol = flat_roof_col(b)
    for t in cap["t"]:
        ids = []
        for i in t:
            x, y = cap["v"][i]
            rk = lookup.get((round(x, 3), round(y, 3)))
            if rk is None:
                ok = False
                break
            ids.append(rk)
        if not ok:
            break
        try:
            f = bm.faces.new([top[ri][k] for ri, k in ids])
            f.material_index = 1
            for lp in f.loops:
                lp[uv_l].uv = (lp.vert.co.x / 6, lp.vert.co.y / 6)
                lp[col_l] = rcol
            g = bm.faces.new([bot[ri][k] for ri, k in reversed(ids)])
            g.material_index = 1
            for lp in g.loops:
                lp[uv_l].uv = (0, 0)
                lp[col_l] = rcol
        except ValueError:
            pass
    if not ok:  # fall back to the plain path
        bm.free()
        b2 = dict(b)
        b2.pop("holes")
        emit_intact_walls_only(b2)
        return
    me = bpy.data.meshes.new("tmp_b")
    bm.to_mesh(me)
    bm.free()
    obj = bpy.data.objects.new("tmp_b", me)
    for mn in (fac, "roof_flat", "char", "wall_party"):
        obj.data.materials.append(MATS[mn])
    SCN_TMP.objects.link(obj)
    cutters = []
    for hx, hy, hz_, r, seed in b["holes"]:
        cbm = bmesh.new()
        bmesh.ops.create_icosphere(cbm, subdivisions=1, radius=r)
        cuv = cbm.loops.layers.uv.new("UVMap")
        ccol = cbm.loops.layers.float_color.new("Color")
        for v in cbm.verts:
            k = 1 + 0.32 * noise.noise(v.co * (1.3 / r) + Vector((seed % 101, 0, 0)))
            v.co *= k
            v.co.z *= 0.8
        for f in cbm.faces:
            f.material_index = 2
            for lp in f.loops:
                lp[cuv].uv = (lp.vert.co.x / 2 + lp.vert.co.z / 2, lp.vert.co.y / 2)
                lp[ccol] = lin((0.30, 0.28, 0.26))
        cme = bpy.data.meshes.new("tmp_c")
        cbm.to_mesh(cme)
        cbm.free()
        co = bpy.data.objects.new("tmp_c", cme)
        co.location = (hx, hy, hz_)
        for mn in (fac, "roof_flat", "char", "wall_party"):
            co.data.materials.append(MATS[mn])
        SCN_TMP.objects.link(co)
        co.hide_render = True
        cutters.append(co)
        mod = obj.modifiers.new("hole", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.object = co
        mod.solver = BOOL_SOLVER
        try:
            mod.material_mode = "INDEX"
        except Exception:
            pass
    dg = bpy.context.evaluated_depsgraph_get()
    eo = obj.evaluated_get(dg)
    me2 = eo.to_mesh()
    names = [fac, "roof_flat", "char", "wall_party"]
    if len(me2.polygons) == 0:
        eo.to_mesh_clear()
        cleanup_tmp(obj, cutters)
        b2 = dict(b)
        b2.pop("holes")
        emit_intact_walls_only(b2)
        return
    uvd = me2.uv_layers.get("UVMap")
    cold = me2.color_attributes.get("Color")
    verts = me2.vertices
    for poly in me2.polygons:
        mi = poly.material_index
        mat = names[mi] if mi < len(names) else fac
        # drop the hidden bottom cap
        if mat == "roof_flat" and poly.normal.z < -0.9 and poly.center.z < 0:
            continue
        if mat == "roof_flat" and not roof_flat:
            continue  # pitched roof covers it
        pts = [tuple(verts[vi].co) for vi in poly.vertices]
        uvs = [tuple(uvd.data[li].uv) for li in poly.loop_indices] if uvd else [(0, 0)] * len(pts)
        cols = [tuple(cold.data[li].color) for li in poly.loop_indices] if cold else [(1, 1, 1, 1)] * len(pts)
        if mat == "char":
            cols = [lin((0.32, 0.29, 0.26), 0.6 + 0.4 * h01(*p)) for p in pts]
        VIS.get(mat, cx, cy).poly(pts, uvs, cols)
    eo.to_mesh_clear()
    cleanup_tmp(obj, cutters)
    STATS["booleans"] += 1


def emit_intact_walls_only(b):
    cx, cy = b["centroid"]
    fac = FACADE[b["mat"]]
    for ri, ring in enumerate(b["rings"]):
        edges = b["edges"] if ri == 0 else [0] * len(ring)
        emit_walls(lambda k, edges=edges: None if edges[k] == 2 else VIS.get("wall_party" if edges[k] == 1 else fac, cx, cy),
                   ring, lambda p: -0.3, lambda p: b["eave"], b["tint"], 0.95)
    if b["roof"] == "flat" or not b["obb"]:
        emit_cap(VIS.get("roof_flat", cx, cy), b["cap"], lambda p: b["eave"], flat_roof_col(b))


def cleanup_tmp(obj, cutters):
    for o in [obj] + cutters:
        me = o.data
        bpy.data.objects.remove(o, do_unlink=True)
        bpy.data.meshes.remove(me)


def emit_collision_building(b):
    col = b.get("col")
    if not col:
        return
    pitched = False
    if b["dmg"] == "intact":
        top = b["eave"]
        if b["roof"] in ("gabled", "hipped") and b["obb"]:
            for pts, kind in roof_geometry(b, top):
                COL.poly([tuple(p) for p in pts])
            pitched = True  # the roof closes the solid; no cap needed
        elif b["roof"] == "pyramidal":
            top = b["eave"] + b["roof_h"] * (1 - b.get("truncate", 0.0)) * 0.5
    else:
        top = b["max_top"]
    hidden = col.get("hidden", [])
    for ri, ring in enumerate(col["rings"]):
        n = len(ring)
        for k in range(n):
            if ri == 0 and k < len(hidden) and hidden[k]:
                continue
            a, c = ring[k], ring[(k + 1) % n]
            COL.poly([(a[0], a[1], -0.5), (c[0], c[1], -0.5), (c[0], c[1], top), (a[0], a[1], top)])
    if not pitched:
        cap = col["cap"]
        COL.indexed([(x, y, top) for x, y in cap["v"]], [tuple(t) for t in cap["t"]])


# ============================================================================ ground, water, bridges

def emit_ground(G):
    spec = {
        "asphalt": ("asphalt", 8.0, (0.36, 0.36, 0.37), 0.0),
        "cobble": ("cobble", 8.0, (0.50, 0.48, 0.45), 0.0),
        "pave": ("pave", 6.0, (0.55, 0.54, 0.52), 0.0),
        "mud": ("mud", 10.0, (0.40, 0.35, 0.29), 0.0),
        "grass": ("grass", 10.0, (0.42, 0.42, 0.33), 0.0),
        "water": ("water", 20.0, (0.05, 0.06, 0.055), WATER_Z),
    }
    for key, (mat, s, base, z) in spec.items():
        t = G[key]
        v = t["v"]
        verts = [(x, y, z) for x, y in v]

        def colf(i, base=base, key=key):
            x, y = v[i]
            n = noise.noise(Vector((x * 0.013, y * 0.013, 4.0)))
            n2 = noise.noise(Vector((x * 0.05, y * 0.05, 9.0)))
            k = 0.82 + 0.22 * n + 0.08 * n2
            if key == "mud":
                k *= 0.9 + 0.25 * noise.noise(Vector((x * 0.004, y * 0.004, 2.0)))
            return lin(base, k)

        # split by tile so each piece lands in its quadrant mesh
        faces_by_tile = {}
        for tr in t["t"]:
            cx = (v[tr[0]][0] + v[tr[1]][0] + v[tr[2]][0]) / 3
            cy = (v[tr[0]][1] + v[tr[1]][1] + v[tr[2]][1]) / 3
            faces_by_tile.setdefault((cx >= 0, cy >= 0), []).append(tuple(tr))
        for (tx, ty), faces in faces_by_tile.items():
            acc = VIS.get(mat, 1 if tx else -1, 1 if ty else -1)
            acc.indexed(verts, faces, lambda i: (verts[i][0] / s, verts[i][1] / s), colf)


def emit_quays(rings):
    for ring in rings:
        n = len(ring)
        if n < 3:
            continue
        x0, y0 = ring[0]
        acc = VIS.get("quay", x0, y0)
        emit_walls(lambda k: acc, ring, lambda p: QUAY_BOTTOM, lambda p: 0.0, (0.55, 0.53, 0.50), 0.9,
                   reverse=True, col_fn=lambda p, z: lin((0.55, 0.53, 0.50), 0.75 + 0.25 * h01(p[0], p[1])))


def emit_decks(decks):
    for d in decks:
        ring = d["rings"][0]
        x0, y0 = ring[0]
        acc = VIS.get("bridge", x0, y0)
        tint = (0.52, 0.50, 0.47)
        emit_cap(acc, d["cap"], lambda p: 0.0, lin(tint, 0.85), uv_scale=4.0)
        emit_cap(acc, d["cap"], lambda p: -1.0, lin(tint, 0.5), uv_scale=4.0, up=False)
        for ring in d["rings"]:
            emit_walls(lambda k: acc, ring, lambda p: -1.0, lambda p: 0.0, tint, 0.8)
        # parapets on the edges that hang over water
        ring = d["rings"][0]
        n = len(ring)
        for k in range(n):
            if not d["parapet"][k]:
                continue
            a, c = Vector((*ring[k], 0)), Vector((*ring[(k + 1) % n], 0))
            L = (c - a).length
            if L < 0.6:
                continue
            dvec = (c - a) / L
            nrm = Vector((dvec.y, -dvec.x, 0))
            m = (a + c) * 0.5 - nrm * 0.2
            add_box(acc, m.x, m.y, 0.5, L / 2, 0.2, 0.5, math.atan2(dvec.y, dvec.x), lin(tint, 0.8), uvs=0.25)
        # collision: deck slab
        COL.indexed([(x, y, 0.0) for x, y in d["cap"]["v"]], [tuple(t) for t in d["cap"]["t"]])
        COL.indexed([(x, y, -1.0) for x, y in d["cap"]["v"]], [tuple(reversed(t)) for t in d["cap"]["t"]])
        for rr in d["rings"]:
            for k in range(len(rr)):
                a, c = rr[k], rr[(k + 1) % len(rr)]
                COL.poly([(a[0], a[1], -1.0), (c[0], c[1], -1.0), (c[0], c[1], 0.0), (a[0], a[1], 0.0)])


def emit_broken_bridge_debris(broken):
    for bk in broken:
        x, y = bk["c"]
        r = bk["r"]
        acc = VIS.get("bridge", x, y)
        racc = VIS.get("rubble", x, y)
        for i in range(9):
            a = rng.uniform(0, 2 * math.pi)
            d = rng.uniform(0, r * 0.8)
            hx, hy, hz = rng.uniform(0.6, 2.2), rng.uniform(0.5, 1.6), rng.uniform(0.3, 0.8)
            add_box(acc if i % 2 else racc, x + math.cos(a) * d, y + math.sin(a) * d, WATER_Z + rng.uniform(-0.3, 0.4),
                    hx, hy, hz, rng.uniform(0, 3.14), lin((0.5, 0.48, 0.45), rng.uniform(0.5, 0.9)),
                    tilt=(rng.uniform(-0.5, 0.5), rng.uniform(-0.5, 0.5)), uvs=0.25)


# ============================================================================ war damage props

def emit_craters(craters):
    for x, y, r in craters:
        acc = VIS.get("crater", x, y)
        n = 16
        depth = 0.32 * r
        rings = [(1.35, -0.05), (1.0, 0.18 + 0.05 * r), (0.72, -0.35 * depth), (0.38, -0.82 * depth)]
        verts = []
        for ri, (rf, z) in enumerate(rings):
            for k in range(n):
                a = 2 * math.pi * k / n
                rr = r * rf * (1 + (0.12 * (h01(x, y, k, ri) - 0.5) if ri != 1 else 0))
                zz = z + (0.25 * (h01(x, k, ri) - 0.5) if ri >= 2 else 0) + (0.35 * r / 5 * (h01(x, k, 61) - 0.3) if ri == 1 else 0)
                verts.append((x + rr * math.cos(a), y + rr * math.sin(a), zz))
        verts.append((x, y, -depth))
        faces = []
        for ri in range(len(rings) - 1):
            for k in range(n):
                k2 = (k + 1) % n
                faces.append((ri * n + k, ri * n + k2, (ri + 1) * n + k2, (ri + 1) * n + k))
        c = len(verts) - 1
        last = (len(rings) - 1) * n
        for k in range(n):
            faces.append((last + k, last + (k + 1) % n, c))

        def colf(i):
            ri = min(i // n, len(rings))
            k = [1.0, 1.05, 0.62, 0.42, 0.32][ri] * (0.85 + 0.3 * h01(x, y, i))
            return lin((0.52, 0.47, 0.41), k)

        acc.indexed(verts, faces, lambda i: (verts[i][0] / 4, verts[i][1] / 4), colf, smooth=True)
        racc = VIS.get("rubble", x, y)
        for j in range(int(r * 1.2)):
            a = h01(x, y, j, 51) * 6.283
            d = r * (1.05 + 0.6 * h01(x, y, j, 52))
            s = 0.15 + 0.35 * h01(x, y, j, 53)
            add_box(racc, x + math.cos(a) * d, y + math.sin(a) * d, s * 0.5, s * 1.4, s, s * 0.7, a,
                    lin((0.6, 0.56, 0.5), 0.8), tilt=(h01(x, j, 54) - 0.5, h01(y, j, 55) - 0.5), uvs=0.5, skip=(0,))


def mound_mesh(x, y, r, h, seed, segs=8, rings=((0.5, 0.72), (1.0, -0.08))):
    verts = [(x, y, h * (0.9 + 0.2 * h01(seed, 1)))]
    for ri, (rf, zf) in enumerate(rings):
        last = ri == len(rings) - 1
        for k in range(segs):
            a = 2 * math.pi * (k + 0.5 * ri) / segs
            rr = r * rf * (0.7 + 0.6 * h01(seed, k, ri))
            z = -0.15 if last else h * zf * (0.65 + 0.7 * h01(seed, k, ri, 3))
            verts.append((x + rr * math.cos(a), y + rr * math.sin(a), z))
    faces = []
    for k in range(segs):
        faces.append((0, 1 + k, 1 + (k + 1) % segs))
    for ri in range(len(rings) - 1):
        o0, o1 = 1 + ri * segs, 1 + (ri + 1) * segs
        for k in range(segs):
            k2 = (k + 1) % segs
            faces.append((o0 + k, o1 + k, o1 + k2))
            faces.append((o0 + k, o1 + k2, o0 + k2))
    return verts, faces


def emit_mounds(mounds):
    for x, y, r, h, seed, core in mounds:
        acc = VIS.get("rubble", x, y)
        if core:
            verts, faces = mound_mesh(x, y, r, h, seed, segs=9, rings=((0.35, 0.85), (0.7, 0.5), (1.0, 0)))
        else:
            verts, faces = mound_mesh(x, y, r, h, seed, segs=7)
        tint = (0.66, 0.60, 0.54) if h01(seed, 9) < 0.6 else (0.62, 0.50, 0.43)
        acc.indexed(verts, faces, lambda i: (verts[i][0] / 3, verts[i][1] / 3),
                    lambda i: lin(tint, 0.75 + 0.3 * h01(seed, i)), smooth=True)
        if h > 1.6 and max(abs(x), abs(y)) < 600:  # collision: 4-sided pyramid
            cv = [(x, y, h * 0.85)] + [(x + r * 0.8 * math.cos(a), y + r * 0.8 * math.sin(a), -0.1)
                                       for a in (0.0, 1.5708, 3.1416, 4.7124)]
            COL.indexed(cv, [(0, 1, 2), (0, 2, 3), (0, 3, 4), (0, 4, 1)])
        if core:  # loose chunks: beams, slabs, bricks
            for j in range(2):
                a = h01(seed, j, 11) * 6.283
                d = r * (0.3 + 0.9 * h01(seed, j, 12))
                px, py = x + math.cos(a) * d, y + math.sin(a) * d
                if h01(seed, j, 13) < 0.3:
                    wacc = VIS.get("wood", px, py)
                    add_beam(wacc, (px, py, 0.1), (px + math.cos(a + 1) * 3.2, py + math.sin(a + 1) * 3.2, 0.2 + h * 0.8 * h01(seed, j)),
                             0.13, lin((0.35, 0.3, 0.26)), sides=4, uvs=0.3)
                else:
                    add_box(acc, px, py, 0.2, 0.3 + 0.7 * h01(seed, j, 14), 0.25 + 0.5 * h01(seed, j, 15), 0.18 + 0.2 * h01(seed, j, 16),
                            a, lin(tint, 0.8), tilt=(h01(seed, j, 17) - 0.5, h01(seed, j, 18) - 0.5), uvs=0.5, skip=(0,))


def emit_car(x, y, ang, flipped, seed):
    acc = VIS.get("metal", x, y)
    body_col = lin((0.30, 0.25, 0.21) if h01(seed, 1) < 0.6 else (0.22, 0.21, 0.20), 0.8 + 0.4 * h01(seed, 2))
    ca, sa = math.cos(ang), math.sin(ang)

    def L(lx, ly, lz):
        if flipped:
            ly, lz = -ly, 1.55 - lz
        return (x + lx * ca - ly * sa, y + lx * sa + ly * ca, lz)

    tilt = (0.05 * (h01(seed, 3) - 0.5), 0.06 * (h01(seed, 4) - 0.5))
    zoff = 0.0 if not flipped else 0.0
    # body (sits low: tyres burned away)
    bx, by, bz = L(0, 0, 0.62 + zoff)
    add_box(acc, bx, by, bz, 2.2, 0.88, 0.36, ang, body_col, tilt=tilt, uvs=0.4)
    cx_, cy_, cz_ = L(-0.25, 0, 1.18)
    add_box(acc, cx_, cy_, cz_, 1.1, 0.78, 0.26, ang, lin((0.12, 0.11, 0.10)), tilt=tilt, uvs=0.4)
    # wheels / rims
    for wx in (-1.35, 1.35):
        for wy in (-0.86, 0.86):
            p = L(wx, wy, 0.33)
            q = L(wx, wy + (0.18 if wy > 0 else -0.18), 0.33)
            add_beam(acc, p, q, 0.33, lin((0.10, 0.09, 0.09)), sides=6, uvs=0.5, caps=True)
    COL.indexed(*box_faces(bx, by, 0.75, 2.25, 0.95, 0.75, ang))


def emit_hedgehog(x, y, ang):
    acc = VIS.get("steel", x, y)
    col = lin((0.28, 0.25, 0.22))
    for k in range(3):
        a = ang + k * math.pi / 3
        tilt = 0.75 if k != 1 else -0.75
        d = Vector((math.cos(a) * math.cos(tilt), math.sin(a) * math.cos(tilt), math.sin(tilt)))
        c = Vector((x, y, 0.7))
        add_beam(acc, c - d * 1.1, c + d * 1.1, 0.09, col, sides=4, uvs=0.5)


def emit_scaffold(ax, ay, bx, by, h, seed):
    a, b = Vector((ax, ay, 0)), Vector((bx, by, 0))
    L = (b - a).length
    d = (b - a) / L
    nrm = Vector((d.y, -d.x, 0))
    sacc = VIS.get("steel", ax, ay)
    wacc = VIS.get("wood", ax, ay)
    pcol = lin((0.42, 0.38, 0.33))
    wcol = lin((0.50, 0.44, 0.36))
    nb = max(2, int(L / 2.0))
    levels = max(2, int(h / 2.0))
    # collapse part of it on one side
    broken_from = nb + 1 if h01(seed, 1) < 0.6 else int(nb * (0.3 + 0.5 * h01(seed, 2)))
    for i in range(nb + 1):
        p = a + d * (L * i / nb)
        top = h if i < broken_from else h * (0.2 + 0.4 * h01(seed, i))
        for off in (0.25, 1.35):
            q = p + nrm * off
            add_beam(sacc, (q.x, q.y, 0), (q.x, q.y, top), 0.035, pcol, sides=4, uvs=0.2)
    for lv in range(1, levels + 1):
        z = lv * 2.0
        if z > h:
            break
        end = nb if (broken_from > nb) else min(nb, broken_from - 1)
        if end <= 0:
            continue
        for off in (0.25, 1.35):
            p0 = a + nrm * off
            p1 = a + d * (L * end / nb) + nrm * off
            add_beam(sacc, (p0.x, p0.y, z), (p1.x, p1.y, z), 0.03, pcol, sides=4, uvs=0.2)
        for i in range(end):
            if h01(seed, lv, i) < 0.15:
                continue  # missing planks
            m = a + d * (L * (i + 0.5) / nb) + nrm * 0.8
            add_box(wacc, m.x, m.y, z + 0.03, L / nb / 2 - 0.02, 0.6, 0.03, math.atan2(d.y, d.x), wcol, uvs=0.5, skip=(3, 5))
        # diagonal brace
        p0 = a + nrm * 1.35
        p1 = a + d * min(L, 2.0 * end / max(1, end) * 2) + nrm * 1.35
        add_beam(sacc, (p0.x, p0.y, z - 2.0), (p1.x, p1.y, z), 0.025, pcol, sides=4, uvs=0.2)
    m = (a + b) * 0.5 + nrm * 0.8
    COL.indexed(*box_faces(m.x, m.y, h / 2, L / 2, 0.75, h / 2, math.atan2(d.y, d.x)))


def emit_tree(x, y, h, seed, z0=0.0):
    acc = VIS.get("bark", x, y)
    col = lin((0.28, 0.25, 0.22), 0.7 + 0.5 * h01(seed, 1))
    snapped = h01(seed, 2) < 0.25
    hh = h * (0.35 if snapped else 1.0)
    lean = Vector(((h01(seed, 3) - 0.5) * 0.15 * hh, (h01(seed, 4) - 0.5) * 0.15 * hh, 0))
    base = Vector((x, y, z0 - 0.2))
    top = base + Vector((0, 0, hh)) + lean
    add_beam(acc, base, top, 0.18 + 0.02 * h, col, sides=5, uvs=0.25, caps=snapped)
    if not snapped:
        for k in range(3):
            t = 0.45 + 0.17 * k
            p = base.lerp(top, t)
            a = h01(seed, k, 5) * 6.283
            ln = h * (0.25 + 0.15 * h01(seed, k, 6))
            q = p + Vector((math.cos(a) * ln, math.sin(a) * ln, ln * 0.7))
            add_beam(acc, p, q, 0.07, col, sides=4, uvs=0.25)


# ============================================================================ outskirts terrain

def terrain_height(x, y):
    d = max(abs(x), abs(y))
    f = geo.FLAT_HALF
    t = min(1.0, max(0.0, (d - f) / (geo.TERRAIN_HALF - f)))
    t = t * t * (3 - 2 * t)
    hills = 0.5 + 0.5 * noise.noise(Vector((x * 0.0022, y * 0.0022, 1.7)))
    small = noise.noise(Vector((x * 0.012, y * 0.012, 5.1)))
    h = t * (4 + 34 * hills * t) + t * 1.6 * small
    return h


FIELD_COLS = [(0.42, 0.38, 0.27), (0.36, 0.30, 0.23), (0.47, 0.44, 0.33), (0.30, 0.28, 0.22),
              (0.20, 0.19, 0.17), (0.40, 0.40, 0.30)]


def field_col(x, y):
    # rotated field grid patches
    a = 0.35
    u = x * math.cos(a) - y * math.sin(a)
    v = x * math.sin(a) + y * math.cos(a)
    fu, fv = math.floor(u / 140), math.floor(v / 90)
    c = FIELD_COLS[int(h01(fu, fv) * len(FIELD_COLS))]
    k = 0.85 + 0.25 * noise.noise(Vector((x * 0.02, y * 0.02, 3.3)))
    return lin(c, k)


def emit_terrain():
    step = 20.0
    H = geo.TERRAIN_HALF
    F = geo.FLAT_HALF
    n = int(round(2 * H / step))
    craters = [(rng.uniform(-H, H), rng.uniform(-H, H), rng.uniform(8, 22)) for _ in range(70)]
    craters = [c for c in craters if max(abs(c[0]), abs(c[1])) > F + 40]

    def hgt(x, y):
        h = terrain_height(x, y)
        for cx, cy, r in craters:
            d = math.hypot(x - cx, y - cy)
            if d < r * 1.4:
                t = d / r
                h += -r * 0.25 * max(0.0, 1 - t * t) + (0.8 if 0.8 < t < 1.3 else 0)
        return h

    idx = {}
    verts = []
    for j in range(n + 1):
        for i in range(n + 1):
            x, y = -H + i * step, -H + j * step
            idx[(i, j)] = len(verts)
            verts.append((x, y, hgt(x, y)))
    faces_by_tile = {}
    for j in range(n):
        for i in range(n):
            x0, y0 = -H + i * step, -H + j * step
            if max(abs(x0 + step / 2), abs(y0 + step / 2)) < F:
                continue
            f = (idx[(i, j)], idx[(i + 1, j)], idx[(i + 1, j + 1)], idx[(i, j + 1)])
            faces_by_tile.setdefault((x0 + step / 2 >= 0, y0 + step / 2 >= 0), []).append(f)
    for (tx, ty), faces in faces_by_tile.items():
        acc = VIS.get("field", 1 if tx else -1, 1 if ty else -1)
        acc.indexed(verts, faces, lambda i: (verts[i][0] / 10, verts[i][1] / 10),
                    lambda i: field_col(verts[i][0], verts[i][1]), smooth=True)
    # collision: coarser grid (every 2nd vertex) for the outskirts ring, flat core added separately
    cs = 2
    cfaces = []
    for j in range(0, n, cs):
        for i in range(0, n, cs):
            x0, y0 = -H + i * step, -H + j * step
            if max(abs(x0 + step), abs(y0 + step)) < F:
                continue
            cfaces.append((idx[(i, j)], idx[(i + cs, j)], idx[(i + cs, j + cs)], idx[(i, j + cs)]))
    used = sorted({v for f in cfaces for v in f})
    remap = {v: k for k, v in enumerate(used)}
    COL.indexed([verts[v] for v in used], [tuple(remap[v] for v in f) for f in cfaces])

    # ruined farmsteads, tree lines and pylons out in the fields
    for _ in range(55):
        x, y = rng.uniform(-H + 60, H - 60), rng.uniform(-H + 60, H - 60)
        if max(abs(x), abs(y)) < F + 40:
            continue
        z = hgt(x, y)
        w, d = rng.uniform(6, 14), rng.uniform(5, 9)
        ang = rng.uniform(0, 3.14)
        ca, sa = math.cos(ang), math.sin(ang)
        ring = [(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in ((-w, -d), (w, -d), (w, d), (-w, d))]
        dense = []
        for k in range(4):
            a, c = ring[k], ring[(k + 1) % 4]
            m = max(1, int(math.hypot(c[0] - a[0], c[1] - a[1]) / 3))
            for s in range(m):
                dense.append((a[0] + (c[0] - a[0]) * s / m, a[1] + (c[1] - a[1]) * s / m))
        acc = VIS.get("facade_brick", x, y)
        tint = rng.choice([(0.42, 0.30, 0.25), (0.55, 0.52, 0.47)])
        hmax = rng.uniform(1.5, 6.0)
        emit_walls(lambda k: acc, dense, lambda p: z - 0.8,
                   lambda p: z + max(0.4, hmax * (0.4 + 0.6 * h01(p[0], p[1]))), tint, 0.5)
        emit_walls(lambda k: acc, dense, lambda p: z - 0.8,
                   lambda p: z + max(0.4, hmax * (0.4 + 0.6 * h01(p[0], p[1]))), tint, 0.5, reverse=True)
        verts_m, faces_m = mound_mesh(x, y, max(w, d) * 0.6, 1.2, int(x * 7))
        verts_m = [(vx, vy, vz + z) for vx, vy, vz in verts_m]
        VIS.get("rubble", x, y).indexed(verts_m, faces_m, lambda i: (verts_m[i][0] / 3, verts_m[i][1] / 3),
                                        lambda i: lin((0.5, 0.46, 0.42), 0.7))
    for _ in range(14):  # tree lines along field edges
        x, y = rng.uniform(-H + 40, H - 40), rng.uniform(-H + 40, H - 40)
        if max(abs(x), abs(y)) < F + 30:
            continue
        a = rng.uniform(0, 3.14)
        for k in range(rng.randint(8, 20)):
            px, py = x + math.cos(a) * k * 9, y + math.sin(a) * k * 9
            if max(abs(px), abs(py)) > H - 10 or max(abs(px), abs(py)) < F + 10:
                continue
            emit_tree(px, py, rng.uniform(6, 13), rng.randrange(1 << 20), z0=hgt(px, py))
    return hgt


# ============================================================================ scene assembly

def clear_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def normalise_uvs():
    """Rescale each material's world-space UVs into [0,1] and move the scale/offset into a
    Mapping node (exported as KHR_texture_transform) so meshopt can quantise UVs to 16 bit."""
    by_mat = {}
    for (mat, tile), acc in VIS.d.items():
        by_mat.setdefault(mat, []).append(acc)
    for mat, accs in by_mat.items():
        us = [uv[0] for acc in accs for uv in acc.uv]
        vs = [uv[1] for acc in accs for uv in acc.uv]
        if not us:
            continue
        # integer offsets keep the texture phase; ranges padded to whole tiles
        u0, v0 = math.floor(min(us)), math.floor(min(vs))
        su, sv = max(1.0, math.ceil(max(us)) - u0), max(1.0, math.ceil(max(vs)) - v0)
        for acc in accs:
            acc.uv = [((u - u0) / su, (v - v0) / sv) for u, v in acc.uv]
        m = MATS[mat]
        nt = m.node_tree
        img = next((n for n in nt.nodes if n.type == "TEX_IMAGE"), None)
        if img is None:
            continue
        tc = nt.nodes.new("ShaderNodeTexCoord")
        mp = nt.nodes.new("ShaderNodeMapping")
        mp.vector_type = "POINT"
        mp.inputs["Location"].default_value = (u0, v0, 0)
        mp.inputs["Scale"].default_value = (su, sv, 1)
        nt.links.new(tc.outputs["UV"], mp.inputs["Vector"])
        nt.links.new(mp.outputs["Vector"], img.inputs["Vector"])


def build_objects():
    normalise_uvs()
    city = bpy.data.collections.new("City")
    bpy.context.scene.collection.children.link(city)
    objs = []
    tri_total = 0
    for (mat, tile), acc in sorted(VIS.d.items()):
        if not acc.faces:
            continue
        name = f"{mat}_{tile}"
        me = bpy.data.meshes.new(name)
        me.from_pydata(acc.co, [], acc.faces)
        uvl = me.uv_layers.new(name="UVMap")
        uv_flat = [c for uv in acc.uv for c in uv]
        uvl.data.foreach_set("uv", uv_flat)
        ca = me.color_attributes.new("Color", "FLOAT_COLOR", "CORNER")
        col_flat = [c for col in acc.col for c in col]
        ca.data.foreach_set("color", col_flat)
        me.color_attributes.active_color = ca
        me.polygons.foreach_set("use_smooth", acc.smooth)
        me.validate(clean_customdata=False)
        me.materials.append(MATS[mat])
        ob = bpy.data.objects.new(name, me)
        city.objects.link(ob)
        objs.append(ob)
        me.calc_loop_triangles()
        tri_total += len(me.loop_triangles)
    per = {}
    for (mat, tile), acc in VIS.d.items():
        per[mat] = per.get(mat, 0) + acc.ntris()
    log("tris per material: " + ", ".join(f"{k}={v}" for k, v in sorted(per.items(), key=lambda kv: -kv[1])))
    log(f"visual: {len(objs)} meshes, {tri_total} triangles")

    colc = bpy.data.collections.new("Collision")
    bpy.context.scene.collection.children.link(colc)
    me = bpy.data.meshes.new("collision")
    me.from_pydata(COL.co, [], COL.faces)
    me.validate()
    # weld duplicate vertices so the trimesh is compact
    bm = bmesh.new()
    bm.from_mesh(me)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=0.01)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bm.to_mesh(me)
    bm.free()
    cob = bpy.data.objects.new("collision", me)
    colc.objects.link(cob)
    me.calc_loop_triangles()
    col_tris = len(me.loop_triangles)
    log(f"collision: {col_tris} triangles, {len(me.vertices)} verts")
    return city, colc, objs, cob, tri_total, col_tris


def export(collection, path, **kw):
    for c in bpy.context.view_layer.layer_collection.children:
        c.exclude = c.name != collection.name
    bpy.ops.export_scene.gltf(
        filepath=str(path), export_format="GLB", use_visible=True, export_yup=True,
        export_apply=False, export_cameras=False, export_lights=False, export_extras=False,
        export_animations=False, **kw)
    for c in bpy.context.view_layer.layer_collection.children:
        c.exclude = False


def gl(x, y, z):
    """Blender (Z-up) -> glTF (Y-up)."""
    return (round(x, 2), round(z, 2), round(-y, 2))


# ============================================================================ previews

def setup_preview_scene():
    scn = bpy.context.scene
    # EEVEE renders black without a GPU context in -b mode on macOS; Cycles on Metal works.
    scn.render.engine = "CYCLES"
    try:
        prefs = bpy.context.preferences.addons["cycles"].preferences
        prefs.compute_device_type = "METAL"
        prefs.get_devices()
        for d in prefs.devices:
            d.use = True
        scn.cycles.device = "GPU"
    except Exception as e:
        log(f"cycles GPU unavailable ({e}), using CPU")
    scn.cycles.samples = int(PREVIEW_SAMPLES)
    scn.cycles.use_denoising = True
    scn.cycles.max_bounces = 4
    scn.render.resolution_x = 1600
    scn.render.resolution_y = 900
    scn.render.image_settings.file_format = "PNG"
    try:
        scn.view_settings.view_transform = "AgX"
        scn.view_settings.look = "AgX - Medium High Contrast"
    except Exception:
        pass
    w = bpy.data.worlds.new("overcast")
    scn.world = w
    try:
        w.use_nodes = True
    except Exception:
        pass
    nt = w.node_tree
    bg = nt.nodes.get("Background") or nt.nodes.new("ShaderNodeBackground")
    sky = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.elements[0].position = 0.0
    ramp.color_ramp.elements[0].color = (0.30, 0.31, 0.32, 1)
    ramp.color_ramp.elements[1].position = 0.5
    ramp.color_ramp.elements[1].color = (0.52, 0.54, 0.56, 1)
    nt.links.new(sky.outputs["Generated"], sep.inputs[0])
    nt.links.new(sep.outputs["Z"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.1
    # distance haze (preview only; the client does its own fog). A world volume would
    # swallow the sky and sun in Cycles, so use a bounded box of thin scattering medium.
    hm = bpy.data.materials.new("haze")
    try:
        hm.use_nodes = True
    except Exception:
        pass
    hn = hm.node_tree
    for nd in list(hn.nodes):
        if nd.type == "BSDF_PRINCIPLED":
            hn.nodes.remove(nd)
    vol = hn.nodes.new("ShaderNodeVolumePrincipled")
    vol.inputs["Density"].default_value = HAZE
    vol.inputs["Color"].default_value = (0.70, 0.72, 0.74, 1)
    hn.links.new(vol.outputs[0], hn.nodes["Material Output"].inputs["Volume"])
    bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0, 150))
    hb = bpy.context.active_object
    hb.name = "haze_box"
    hb.scale = (3400, 3400, 330)
    hb.data.materials.append(hm)
    sun = bpy.data.lights.new("sun", "SUN")
    sun.energy = 3.2
    sun.angle = math.radians(12)
    sun.color = (0.92, 0.94, 1.0)
    so = bpy.data.objects.new("sun", sun)
    so.rotation_euler = (math.radians(50), math.radians(10), math.radians(-35))
    scn.collection.objects.link(so)
    return so


def render_view(name, loc, target, lens=24, haze=None):
    scn = bpy.context.scene
    hm = bpy.data.materials.get("haze")
    if hm:
        vol = next(n for n in hm.node_tree.nodes if n.type == "PRINCIPLED_VOLUME")
        vol.inputs["Density"].default_value = HAZE if haze is None else haze
    cam = bpy.data.cameras.new(name)
    cam.lens = lens
    cam.clip_start = 0.5
    cam.clip_end = 6000
    co = bpy.data.objects.new(name, cam)
    scn.collection.objects.link(co)
    co.location = loc
    d = Vector(target) - Vector(loc)
    co.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    scn.camera = co
    PREVIEWS.mkdir(parents=True, exist_ok=True)
    scn.render.filepath = str(PREVIEWS / f"{name}.png")
    t = time.time()
    bpy.ops.render.render(write_still=True)
    log(f"rendered {name}.png in {time.time() - t:.1f}s")


# ============================================================================ main

STATS = {"booleans": 0}
SCN_TMP = None
BOOL_SOLVER = "EXACT"
PREVIEW_SAMPLES = 32
HAZE = 0.0006


def main():
    global SCN_TMP, BOOL_SOLVER
    data = json.loads(PREP.read_text())
    log(f"prepared: {len(data['buildings'])} buildings")
    clear_scene()
    SCN_TMP = bpy.context.scene.collection
    solvers = [e.identifier for e in bpy.types.BooleanModifier.bl_rna.properties["solver"].enum_items]
    BOOL_SOLVER = "MANIFOLD" if "MANIFOLD" in solvers else "EXACT"
    if "--exact" in ARGV:
        BOOL_SOLVER = "EXACT"
    log(f"boolean solver {BOOL_SOLVER} (available {solvers})")
    make_images()
    make_materials()
    log("textures + materials ready")

    for b in data["buildings"]:
        if b["dmg"] == "intact":
            emit_intact(b)
        else:
            emit_damaged(b)
    log(f"buildings done ({STATS['booleans']} boolean bomb-hole buildings)")

    emit_ground(data["ground"])
    emit_quays(data["quays"])
    emit_decks(data["decks"])
    emit_broken_bridge_debris(data["broken_bridges"])
    log("ground/water/bridges done")
    emit_craters(data["craters"])
    emit_mounds(data["mounds"])
    for c in data["cars"]:
        emit_car(*c)
    for h in data["hedgehogs"]:
        emit_hedgehog(*h)
    for s in data["scaffolds"]:
        emit_scaffold(*s)
    for t in data["trees"]:
        emit_tree(*t)
    log("props done")
    emit_terrain()
    log("terrain done")

    # collision ground: flat land (core), recessed water, quay walls
    cg = data["collision_ground"]
    COL.indexed([(x, y, 0.0) for x, y in cg["land"]["v"]], [tuple(t) for t in cg["land"]["t"]])
    COL.indexed([(x, y, WATER_Z) for x, y in cg["water"]["v"]], [tuple(t) for t in cg["water"]["t"]])
    for ring in data["quays"]:
        for k in range(0, len(ring)):
            a, c = ring[k], ring[(k + 1) % len(ring)]
            COL.poly([(c[0], c[1], WATER_Z - 0.5), (a[0], a[1], WATER_Z - 0.5), (a[0], a[1], 0.0), (c[0], c[1], 0.0)])

    city, colc, objs, cob, tri_total, col_tris = build_objects()

    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    PUB.mkdir(parents=True, exist_ok=True)
    raw = BUILD_DIR / "city_raw.glb"
    export(city, raw, export_materials="EXPORT", export_image_format="AUTO", export_texcoords=True,
           export_normals=True, export_vertex_color="ACTIVE")
    log(f"exported {raw} ({raw.stat().st_size / 1e6:.1f} MB)")
    colp = PUB / "collision.glb"
    export(colc, colp, export_materials="NONE", export_texcoords=False, export_normals=False,
           export_vertex_color="NONE")
    log(f"exported {colp} ({colp.stat().st_size / 1e6:.1f} MB)")

    # ---- JSON contract files
    # validate spawns against the collision mesh
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(cob, dg)
    spawns = []
    for x, y, z in data["spawns"]:
        p = Vector((x, y, z))
        for _ in range(20):
            hit = bvh.find_nearest(p)
            if hit[0] is None or hit[3] > 8.0:
                break
            p.z = min(40.0, p.z + 2.0)
            if p.z >= 40.0:
                break
        hit = bvh.find_nearest(p)
        clear = hit[3] if hit[0] is not None else 999
        down = bvh.ray_cast(p, Vector((0, 0, -1)))
        spawns.append({"x": round(p.x, 2), "y": round(p.z, 2), "z": round(-p.y, 2)})
        log(f"spawn ({p.x:7.1f},{p.y:7.1f}) h={p.z:4.1f} clearance={clear:5.1f} ground={down[3] and round(p.z - down[3], 1)}")
    (PUB / "spawns.json").write_text(json.dumps(spawns, indent=1))

    lms = []
    for L in data["landmarks"]:
        x, y, z = gl(L["bx"], L["by"], L["top"])
        lms.append({"id": L["id"], "name": L["name"], "x": x, "y": y, "z": z, "radius": round(L["radius"], 1)})
    (PUB / "landmarks.json").write_text(json.dumps(lms, indent=1))

    mn = [1e9, 1e9, 1e9]
    mx = [-1e9, -1e9, -1e9]
    for ob in objs:
        arr = np.empty(len(ob.data.vertices) * 3, np.float32)
        ob.data.vertices.foreach_get("co", arr)
        arr = arr.reshape(-1, 3)
        lo, hi = arr.min(0), arr.max(0)
        for i in range(3):
            mn[i] = min(mn[i], float(lo[i]))
            mx[i] = max(mx[i], float(hi[i]))
    gmin = [mn[0], mn[2], -mx[1]]
    gmax = [mx[0], mx[2], -mn[1]]
    meta = {
        "name": "Port Ardent",
        "bounds": {"min": [round(v, 2) for v in gmin], "max": [round(v, 2) for v in gmax]},
        "core": {"min": [-geo.CORE_HALF, 0, -geo.CORE_HALF], "max": [geo.CORE_HALF, 0, geo.CORE_HALF]},
        "triangles": tri_total,
        "collisionTriangles": col_tris,
        "source": "OSM Ghent",
        "attribution": "© OpenStreetMap contributors, ODbL",
        "seed": geo.SEED,
        "waterLevel": WATER_Z,
    }
    (PUB / "meta.json").write_text(json.dumps(meta, indent=1, ensure_ascii=False))
    log(f"meta: {meta}")

    if "--no-previews" not in ARGV:
        cob.hide_render = True
        for c in bpy.context.view_layer.layer_collection.children:
            if c.name == "Collision":
                c.exclude = True
        setup_preview_scene()
        # aerial oblique from the south-west over the old town
        render_view("aerial_oblique", (-330, -620, 260), (60, 20, 0), lens=28, haze=0.00025)
        # drone height over the Graslei / Korenlei quays looking at St Nicholas + belfry
        render_view("drone_quays", (-175, 120, 28), (60, -45, 18), lens=22)
        # street level at the Korenmarkt looking east to St Nicholas' and the belfry
        render_view("street_level", (-60, 60, 1.8), (120, -55, 25), lens=20)
        # low over the cathedral square
        render_view("cathedral", (180, -10, 45), (285, -140, 35), lens=24)
    log("done")


main()
