#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["shapely>=2.1", "numpy"]
# ///
"""OSM cache -> planar layout for the Blender build (no Blender needed).

    uv run tools/city/prep.py

Reads tools/city/data/osm_raw.json, writes tools/city/data/prepared.json.
Everything is in the local Blender frame (Z-up, +X east, +Y north, metres).
All the seeded "post-war" layout decisions live here: which buildings collapse,
where craters, cars, rubble, scaffolds and spawns go. build.py only meshes it.
"""
import json
import math
import random
import sys
import time
from pathlib import Path

import numpy as np
import shapely
from shapely import STRtree
from shapely.geometry import LineString, MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import polygonize, unary_union

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import geo  # noqa: E402

RAW = HERE / "data" / "osm_raw.json"
OUT = HERE / "data" / "prepared.json"

rng = random.Random(geo.SEED)
T0 = time.time()


def log(*a):
    print(f"[prep {time.time() - T0:6.1f}s]", *a, flush=True)


# ----------------------------------------------------------------------------- helpers

def coords_of(geom_list):
    return [geo.to_local(p["lat"], p["lon"]) for p in geom_list if p]


def polys_of(g):
    """Flatten any geometry into a list of valid Polygons."""
    if g is None or g.is_empty:
        return []
    if not g.is_valid:
        g = shapely.make_valid(g)
    if isinstance(g, Polygon):
        return [g]
    if hasattr(g, "geoms"):
        out = []
        for s in g.geoms:
            out.extend(polys_of(s))
        return out
    return []


def ring_poly(coords):
    if len(coords) < 4:
        return None
    try:
        p = Polygon(coords)
    except Exception:
        return None
    ps = polys_of(p)
    if not ps:
        return None
    return max(ps, key=lambda q: q.area)


def relation_polys(el):
    outers, inners = [], []
    for m in el.get("members", []):
        if m.get("type") != "way" or not m.get("geometry"):
            continue
        cs = coords_of(m["geometry"])
        if len(cs) < 2:
            continue
        (inners if m.get("role") == "inner" else outers).append(LineString(cs))
    if not outers:
        return []
    out = unary_union(list(polygonize(unary_union(outers))))
    if inners:
        out = out.difference(unary_union(list(polygonize(unary_union(inners)))))
    return polys_of(out)


def r3(v):
    return round(float(v), 3)


def ring_list(ring):
    cs = list(ring.coords)[:-1]
    return [[r3(x), r3(y)] for x, y in cs]


def poly_rings(p):
    p = orient(p, 1.0)
    return [ring_list(p.exterior)] + [ring_list(i) for i in p.interiors]


def tri(geom):
    """Constrained Delaunay triangulation -> {"v": [[x,y]...], "t": [[i,j,k]...]} (CCW)."""
    idx, verts, tris = {}, [], []
    for p in polys_of(geom):
        if p.area < 1e-3:
            continue
        try:
            ts = shapely.constrained_delaunay_triangles(p)
        except Exception:
            continue
        for t in ts.geoms:
            cs = list(t.exterior.coords)[:3]
            (x1, y1), (x2, y2), (x3, y3) = cs
            area2 = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1)
            if abs(area2) < 1e-6:
                continue
            if area2 < 0:
                cs = [cs[0], cs[2], cs[1]]
            ids = []
            for c in cs:
                k = (r3(c[0]), r3(c[1]))
                if k not in idx:
                    idx[k] = len(verts)
                    verts.append([k[0], k[1]])
                ids.append(idx[k])
            tris.append(ids)
    return {"v": verts, "t": tris}


def jitter_disc(cx, cy, r, n=16, amp=0.18):
    pts = []
    for i in range(n):
        a = 2 * math.pi * i / n
        rr = r * (1 + rng.uniform(-amp, amp))
        pts.append((cx + rr * math.cos(a), cy + rr * math.sin(a)))
    return Polygon(pts)


def disc(cx, cy, r, n=16):
    return Polygon([(cx + r * math.cos(2 * math.pi * i / n), cy + r * math.sin(2 * math.pi * i / n)) for i in range(n)])


def chebyshev(x, y):
    return max(abs(x), abs(y))


def obb_info(p):
    """Oriented bounding box: centre, unit long axis, length (long), width (short), fill ratio."""
    r = p.minimum_rotated_rectangle
    if r.geom_type != "Polygon":
        return None
    cs = list(r.exterior.coords)[:4]
    e0 = (cs[1][0] - cs[0][0], cs[1][1] - cs[0][1])
    e1 = (cs[2][0] - cs[1][0], cs[2][1] - cs[1][1])
    l0, l1 = math.hypot(*e0), math.hypot(*e1)
    if l0 < 1e-3 or l1 < 1e-3:
        return None
    if l0 >= l1:
        ax, L, W = (e0[0] / l0, e0[1] / l0), l0, l1
    else:
        ax, L, W = (e1[0] / l1, e1[1] / l1), l1, l0
    c = r.centroid
    return {"c": [r3(c.x), r3(c.y)], "ax": [round(ax[0], 5), round(ax[1], 5)], "L": r3(L), "W": r3(W),
            "fill": round(p.area / max(r.area, 1e-6), 3)}


def fnum(s, default=None):
    if s is None:
        return default
    try:
        return float(str(s).split()[0].replace(",", ".").rstrip("m"))
    except ValueError:
        return default


# ----------------------------------------------------------------------------- load

raw = json.loads(RAW.read_text())
els = raw["elements"]
log(f"loaded {len(els)} elements")

FLAT = box(-geo.FLAT_HALF, -geo.FLAT_HALF, geo.FLAT_HALF, geo.FLAT_HALF)
BUILD = box(-geo.BUILD_HALF, -geo.BUILD_HALF, geo.BUILD_HALF, geo.BUILD_HALF)

bld_raw, part_raw = [], []
water_polys, water_lines = [], []
road_lines, square_polys, bridge_polys, bridge_lines = [], [], [], []
green_polys, dirt_polys = [], []

ROAD_W = {
    "motorway": 12, "trunk": 10, "primary": 9, "secondary": 8, "tertiary": 7,
    "motorway_link": 6, "trunk_link": 6, "primary_link": 6, "secondary_link": 6, "tertiary_link": 6,
    "unclassified": 6, "residential": 6, "living_street": 5, "service": 3.5,
    "pedestrian": 5, "track": 3,
}
ASPHALT = {"motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "trunk_link",
           "primary_link", "secondary_link", "tertiary_link", "unclassified", "residential", "service"}
FOOT_BRIDGE = {"footway", "cycleway", "path", "steps"}

GREEN_LEISURE = {"park", "garden", "pitch", "playground"}
GREEN_LANDUSE = {"grass", "meadow", "forest", "cemetery", "recreation_ground", "allotments", "farmland"}
GREEN_NATURAL = {"wood", "scrub", "grassland"}

for el in els:
    t = el.get("tags", {})
    typ = el["type"]
    if typ == "way":
        if not el.get("geometry"):
            continue
        cs = coords_of(el["geometry"])
        closed = len(cs) >= 4 and el["nodes"][0] == el["nodes"][-1] if el.get("nodes") else False
        polys = [ring_poly(cs)] if closed else []
        polys = [p for p in polys if p is not None]
    else:
        cs = None
        closed = True
        polys = relation_polys(el)

    if "building" in t and t["building"] not in ("no",):
        if t["building"] in ("roof", "construction", "ruins", "collapsed") and "height" not in t:
            continue
        for p in polys:
            bld_raw.append((el["id"], p, t))
        continue
    if "building:part" in t and t["building:part"] not in ("no",):
        for p in polys:
            part_raw.append((el["id"], p, t))
        continue
    if t.get("man_made") == "bridge":
        bridge_polys.extend(polys)
        continue
    if t.get("natural") == "water" or t.get("waterway") in ("riverbank", "dock") and closed:
        water_polys.extend(polys)
        continue
    if t.get("waterway") in ("river", "canal") and typ == "way" and not closed:
        if t.get("tunnel") in (None, "no") and t.get("layer", "0") in ("0", "1"):
            water_lines.append((LineString(cs), 11.0 if t["waterway"] == "river" else 9.0))
        continue
    hw = t.get("highway")
    if hw:
        if t.get("area") == "yes" or (polys and hw == "pedestrian" and t.get("area") == "yes"):
            square_polys.extend(polys)
            continue
        if typ != "way" or len(cs) < 2:
            continue
        if t.get("tunnel") not in (None, "no") or fnum(t.get("layer"), 0) < 0:
            continue
        br = t.get("bridge") not in (None, "no")
        if br and (hw in ROAD_W or hw in FOOT_BRIDGE):
            w = ROAD_W.get(hw, 3.0)
            bridge_lines.append((LineString(cs), w))
            continue
        if hw in ROAD_W:
            road_lines.append((LineString(cs), hw, ROAD_W[hw]))
        continue
    if t.get("place") == "square" or "area:highway" in t:
        square_polys.extend(polys)
        continue
    if (t.get("leisure") in GREEN_LEISURE or t.get("landuse") in GREEN_LANDUSE
            or t.get("natural") in GREEN_NATURAL):
        green_polys.extend(polys)
        continue
    if t.get("landuse") in ("railway", "industrial"):
        dirt_polys.extend(polys)

log(f"buildings {len(bld_raw)} parts {len(part_raw)} water {len(water_polys)}+{len(water_lines)} lines "
    f"roads {len(road_lines)} bridges {len(bridge_polys)}+{len(bridge_lines)} green {len(green_polys)}")

# ----------------------------------------------------------------------------- buildings

def bclass(t):
    b = t.get("building", "yes")
    if b in ("church", "cathedral", "chapel"):
        return "church"
    if b in ("garage", "garages", "shed", "hut", "kiosk", "carport", "roof", "toilets", "bunker"):
        return "small"
    if b in ("industrial", "warehouse", "train_station", "hangar"):
        return "industrial"
    if b in ("commercial", "retail", "office", "public", "civic", "hotel", "university", "school",
             "college", "hospital", "government"):
        return "civic"
    return "house"


# keep building outlines in range
blds = []
for oid, p, t in bld_raw:
    c = p.representative_point()
    if chebyshev(c.x, c.y) > geo.BUILD_HALF or p.area < 6:
        continue
    blds.append({"oid": oid, "poly": p, "tags": t})

parts = []
for oid, p, t in part_raw:
    c = p.representative_point()
    if chebyshev(c.x, c.y) > geo.BUILD_HALF or p.area < 2:
        continue
    parts.append({"oid": oid, "poly": p, "tags": t})

# de-duplicate parts with ~identical footprints (keep the tallest) to avoid coplanar walls
parts.sort(key=lambda d: -fnum(d["tags"].get("height"), 0))
kept = []
ptree_polys = []
for d in parts:
    p = d["poly"]
    dup = False
    for q in ptree_polys:
        if q.intersects(p):
            inter = q.intersection(p).area
            if inter > 0.85 * min(p.area, q.area) and abs(p.area - q.area) < 0.2 * max(p.area, q.area):
                dup = True
                break
    if not dup:
        kept.append(d)
        ptree_polys.append(p)
parts = kept

# substitute outlines that have parts
part_tree = STRtree([d["poly"] for d in parts])
final = []
used_parts = set()
for b in blds:
    p = b["poly"]
    cand = part_tree.query(p)
    inside = [i for i in cand if p.contains(parts[i]["poly"].representative_point())]
    if inside:
        cover = unary_union([parts[i]["poly"] for i in inside]).intersection(p).area
        if cover > 0.3 * p.area:
            for i in inside:
                if i in used_parts:
                    continue
                used_parts.add(i)
                d = parts[i]
                tags = dict(b["tags"])
                tags.update(d["tags"])
                final.append({"oid": d["oid"], "poly": d["poly"], "tags": tags, "is_part": True,
                              "parent": b["oid"]})
            rest = p.difference(unary_union([parts[i]["poly"] for i in inside]).buffer(0.05))
            for q in polys_of(rest):
                if q.area > 25 and q.minimum_clearance > 0.5:
                    final.append({"oid": b["oid"], "poly": q, "tags": b["tags"], "is_part": False,
                                  "parent": b["oid"], "rest": True})
            continue
    final.append({"oid": b["oid"], "poly": p, "tags": b["tags"], "is_part": False, "parent": b["oid"]})
log(f"building solids {len(final)} (parts used {len(used_parts)})")

# clean polygons
for b in final:
    p = b["poly"].simplify(0.05, preserve_topology=True)
    p = max(polys_of(p) or [b["poly"]], key=lambda q: q.area)
    b["poly"] = orient(p, 1.0)
final = [b for b in final if b["poly"].area > 2]

# ----------------------------------------------------------------------------- landmarks

LANDMARK_DEFS = [
    # id, in-game name, osm name match (outline or parent), fallback lat/lon, radius
    ("cathedral", "Cathedral of St. Bavo", ["Sint-Baafskathedraal"], (51.05302, 3.72686), 70),
    ("belfry", "Belfry Ruins", ["Belfort"], (51.05369, 3.72482), 30),
    ("st_nicholas", "St. Nicholas' Shell", ["Sint-Niklaaskerk"], (51.05408, 3.72129), 45),
    ("gravensteen", "Castle Gravensteen", ["Gravensteen"], (51.05724, 3.72063), 55),
    ("st_michael", "St. Michael's Church", ["Sint-Michielskerk"], (51.05380, 3.71880), 40),
    ("town_hall", "Hall of Records", ["Stadhuis Gent"], (51.05429, 3.72513), 45),
    ("meat_hall", "The Meat Hall", ["Groot Vleeshuis"], (51.05587, 3.72161), 35),
    ("st_jacob", "St. Jacob's Church", ["Sint-Jacobskerk"], (51.05659, 3.72764), 35),
    ("devils_keep", "The Devil's Keep", ["Geeraard de Duivelsteen"], (51.05209, 3.72857), 30),
]
LANDMARK_SITES = [
    # open-air landmarks: id, name, lat/lon, radius
    ("drowned_quay", "The Drowned Quay", (51.05472, 3.72065), 70),
    ("market_crater", "Market Square Crater", (51.05473, 3.72203), 35),
    ("broken_bridge", "St. Michael's Broken Bridge", (51.05387, 3.72052), 25),
    ("friday_market", "Friday Market Barricades", (51.05645, 3.72575), 55),
    ("south_quays", "The Scheldt Locks", (51.05050, 3.72910), 60),
]

by_oid = {}
for i, b in enumerate(final):
    by_oid.setdefault(b["oid"], []).append(i)
    by_oid.setdefault(b["parent"], []).append(i)

name_to_oid = {}
for oid, p, t in bld_raw:
    if "name" in t:
        name_to_oid.setdefault(t["name"], oid)

landmark_of = {}
for lid, _, names, _, _ in LANDMARK_DEFS:
    for n in names:
        oid = name_to_oid.get(n)
        if oid is None:
            continue
        for i in set(by_oid.get(oid, [])):
            landmark_of[i] = lid
# Belfry outline is tagged man_made=tower; its parts carry the parent id. Also catch the
# Lakenhalle (cloth hall) next to it and Gravensteen's outbuildings by proximity.
lm_pts = {lid: geo.to_local(*ll) for lid, _, _, ll, _ in LANDMARK_DEFS}
for i, b in enumerate(final):
    if i in landmark_of:
        continue
    c = b["poly"].representative_point()
    if b["tags"].get("name") == "Lakenhalle":
        landmark_of[i] = "belfry"
    gx, gy = lm_pts["gravensteen"]
    if b["tags"].get("building:material") == "stone" and math.hypot(c.x - gx, c.y - gy) < 45:
        landmark_of[i] = "gravensteen"
log(f"landmark solids: {len(landmark_of)}")

# ----------------------------------------------------------------------------- heights + roofs

def vnoise(x, y, s):
    """Cheap smooth-ish value noise in [0,1] (deterministic)."""
    xi, yi = math.floor(x / s), math.floor(y / s)
    fx, fy = x / s - xi, y / s - yi

    def h(a, b):
        n = (a * 374761393 + b * 668265263 + geo.SEED * 1442695041) & 0xFFFFFFFF
        n = (n ^ (n >> 13)) * 1274126177 & 0xFFFFFFFF
        return (n & 0xFFFF) / 65535.0

    def sm(t):
        return t * t * (3 - 2 * t)

    a = h(xi, yi) + (h(xi + 1, yi) - h(xi, yi)) * sm(fx)
    bb = h(xi, yi + 1) + (h(xi + 1, yi + 1) - h(xi, yi + 1)) * sm(fx)
    return a + (bb - a) * sm(fy)


BRICK_TINTS = [(0.42, 0.27, 0.22), (0.36, 0.25, 0.21), (0.47, 0.33, 0.27), (0.33, 0.27, 0.24),
               (0.40, 0.30, 0.26), (0.30, 0.22, 0.19)]
PLASTER_TINTS = [(0.62, 0.60, 0.55), (0.55, 0.53, 0.49), (0.66, 0.62, 0.55), (0.50, 0.50, 0.48),
                 (0.58, 0.55, 0.50), (0.45, 0.44, 0.42), (0.60, 0.56, 0.47)]
STONE_TINTS = [(0.52, 0.50, 0.47), (0.48, 0.46, 0.44), (0.44, 0.43, 0.41)]
ROOF_TINTS = [(0.24, 0.24, 0.26), (0.30, 0.22, 0.19), (0.36, 0.26, 0.21), (0.20, 0.21, 0.23),
              (0.28, 0.27, 0.27)]


def hex_tint(s, fallback):
    try:
        s = s.strip().lstrip("#")
        if len(s) == 6:
            r, g, b = (int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))
            # desaturate + darken towards the post-war palette
            m = (r + g + b) / 3
            k = 0.45
            return (0.68 * (m + (r - m) * k), 0.68 * (m + (g - m) * k), 0.68 * (m + (b - m) * k))
    except Exception:
        pass
    return fallback


for i, b in enumerate(final):
    t = b["tags"]
    p = b["poly"]
    c = p.representative_point()
    dist = chebyshev(c.x, c.y)
    cls = bclass(t)
    lm = landmark_of.get(i)
    ob = obb_info(p)
    b["obb"] = ob
    h_tag = fnum(t.get("height"))
    lv = fnum(t.get("building:levels"))
    shape = t.get("roof:shape")
    roof_h_tag = fnum(t.get("roof:height"))

    if shape is None:
        if ob and len(p.interiors) == 0 and ob["fill"] > 0.82 and p.area < 700 and cls in ("house", "civic"):
            shape = "gabled" if rng.random() < 0.8 else "hipped"
        elif cls == "church" and ob and ob["fill"] > 0.7:
            shape = "gabled"
        else:
            shape = "flat"
    if shape in ("skillion", "many", "round", "gambrel", "mansard", "half-hipped", "saltbox"):
        shape = "gabled" if (ob and ob["fill"] > 0.75 and len(p.interiors) == 0) else "flat"
    if shape in ("dome", "onion", "cone", "pyramid"):
        shape = "pyramidal"
    if shape in ("gabled", "hipped") and (not ob or ob["fill"] < 0.7 or len(p.interiors) > 0):
        shape = "flat"
    if shape not in ("flat", "gabled", "hipped", "pyramidal"):
        shape = "flat"

    W = ob["W"] if ob else math.sqrt(p.area)
    if shape == "flat":
        roof_h = 0.0
    elif roof_h_tag is not None and roof_h_tag > 0:
        roof_h = roof_h_tag
    elif shape == "pyramidal":
        roof_h = min(max(W * 1.2, 3.0), 25.0)
    else:
        roof_h = min(max(W * 0.5 * math.tan(math.radians(50 if shape == "gabled" else 40)), 2.0), 12.0)

    if h_tag is not None and h_tag > 1:
        total = h_tag
    elif lv is not None and lv > 0:
        total = lv * 3.1 + 0.6 + roof_h
    else:
        n = vnoise(c.x, c.y, 60) * 0.6 + rng.random() * 0.4
        if cls == "small":
            levels = 1
        elif cls == "industrial":
            levels = 2 + int(n * 2)
        elif cls == "church":
            levels = 5
        elif cls == "civic":
            levels = 3 + int(n * 3.5)
        else:
            levels = 2 + int(n * 3.6)
            if dist > 600:
                levels = max(1, levels - 1)
        total = levels * 3.1 + 0.6 + roof_h
    if p.area < 20 and not b["is_part"]:
        total = min(total, 4.0)
    roof_h = min(roof_h, total * 0.7)
    if lm is None:
        roof_h = min(roof_h, total * 0.5)
    eave = max(total - roof_h, 2.5)

    # material
    mat_t = (t.get("building:material") or "").lower()
    if lm or mat_t == "stone" or cls == "church":
        mat = "stone"
        tint = hex_tint(t.get("building:colour", ""), rng.choice(STONE_TINTS)) if t.get("building:colour") else rng.choice(STONE_TINTS)
    elif mat_t in ("plaster", "concrete", "glass") or (mat_t != "brick" and rng.random() < 0.42):
        mat = "plaster"
        tint = rng.choice(PLASTER_TINTS)
    else:
        mat = "brick"
        tint = rng.choice(BRICK_TINTS)
    j = rng.uniform(0.88, 1.08)
    tint = tuple(min(1.0, v * j) for v in tint)
    roof_tint = hex_tint(t["roof:colour"], rng.choice(ROOF_TINTS)) if t.get("roof:colour") else rng.choice(ROOF_TINTS)

    b.update({"cls": cls, "lm": lm, "dist": dist, "eave": eave, "roof": shape, "roof_h": roof_h,
              "total": eave + roof_h, "mat": mat, "tint": tint, "roof_tint": roof_tint})

# ----------------------------------------------------------------------------- damage pass

# Bombing clusters make damage spatially coherent: some streets survive, some blocks are gone.
clusters = [(rng.uniform(-850, 850), rng.uniform(-850, 850), rng.uniform(40, 130)) for _ in range(42)]


def bomb_field(x, y):
    v = 0.0
    for cx, cy, r in clusters:
        d2 = (x - cx) ** 2 + (y - cy) ** 2
        v += math.exp(-d2 / (2 * r * r))
    return v


scores = []
for i, b in enumerate(final):
    c = b["poly"].representative_point()
    # big blocks take hits too (otherwise the skyline from the air stays intact)
    scores.append(bomb_field(c.x, c.y) * 0.9 + rng.random() * 0.8 + min(b["poly"].area / 900.0, 0.7))

# Per zone: the playable core gets the spec'd ~30 % collapsed / ~10 % ruined; the outer
# ring (beyond 600 m) is mostly gone, which reads as the city thinning into ruins.
ZONES = [(0, 600, 0.10, 0.30), (600, 1e9, 0.32, 0.38)]
for lo, hi, f_ruin, f_coll in ZONES:
    zone = [i for i in range(len(final)) if lo <= final[i]["dist"] < hi and final[i]["lm"] is None
            and final[i]["cls"] != "small"]
    zone.sort(key=lambda i: -scores[i])
    nz = len(zone)
    for k, i in enumerate(zone):
        if k < int(f_ruin * nz):
            final[i]["dmg"] = "ruined"
        elif k < int((f_ruin + f_coll) * nz):
            final[i]["dmg"] = "collapsed"
for b in final:
    b.setdefault("dmg", "intact")
n = len(final)
# small sheds: mostly gone
for b in final:
    if b["cls"] == "small" and rng.random() < 0.35:
        b["dmg"] = "ruined"

intact_idx = [i for i, b in enumerate(final) if b["dmg"] == "intact" and b["eave"] > 5 and b["poly"].area > 30]
rng.shuffle(intact_idx)
n_holes = int(0.15 * n)
hole_set = set(intact_idx[:n_holes])
for lid in {b["lm"] for b in final if b["lm"]}:  # every landmark takes some hits
    cand = [i for i, b in enumerate(final) if b["lm"] == lid and b["eave"] > 8]
    rng.shuffle(cand)
    hole_set.update(cand[: max(1, len(cand) // 2)])

for b in final:
    if b["dmg"] == "intact" and b["roof"] in ("gabled", "hipped") and b["dist"] < 600 and rng.random() < 0.16:
        b["rafters"] = rng.choice([0, 1, 2])  # 0/1: one slope gone, 2: both

for i, b in enumerate(final):
    if (b["dmg"] != "intact" or b["roof"] != "flat" or i in hole_set or b["lm"] or b["dist"] > 700
            or b["poly"].area < 120 or rng.random() > 0.6):
        continue
    inner = b["poly"].buffer(-2.0)
    if inner.is_empty:
        continue
    minx, miny, maxx, maxy = inner.bounds
    holes = []
    for _ in range(12):
        if len(holes) >= (1 if b["poly"].area < 600 else 3):
            break
        r = rng.uniform(1.8, min(5.5, math.sqrt(b["poly"].area) * 0.25))
        x, y = rng.uniform(minx, maxx), rng.uniform(miny, maxy)
        d = orient(jitter_disc(x, y, r, n=9, amp=0.3), 1.0)
        if inner.contains(d) and all(not d.buffer(0.8).intersects(h) for h in holes):
            holes.append(d)
    if holes:
        b["roof_holes"] = holes

# ----------------------------------------------------------------------------- shared edges

edge_owner = {}


def ekey(a, b):
    ka = (round(a[0], 2), round(a[1], 2))
    kb = (round(b[0], 2), round(b[1], 2))
    return (ka, kb) if ka <= kb else (kb, ka)


for i, b in enumerate(final):
    for ring in [b["poly"].exterior] + list(b["poly"].interiors):
        cs = list(ring.coords)
        for a, c in zip(cs[:-1], cs[1:]):
            edge_owner.setdefault(ekey(a, c), []).append(i)

btree = STRtree([b["poly"] for b in final])


# ----------------------------------------------------------------------------- damage params

for i, b in enumerate(final):
    p = b["poly"]
    core = b["dist"] < 600
    seg = 3.0 if core else 5.0
    if b["dmg"] in ("collapsed", "ruined"):
        if b["dmg"] == "collapsed" and p.area > 120 and b["eave"] > 7 and rng.random() < 0.4:
            # gutted by fire: walls stand to full height, roof and floors are gone
            b["gutted"] = True
            cut = b["eave"] * rng.uniform(0.86, 1.0)
            amp = rng.uniform(0.5, 1.6)
            floor = 0.3
        elif b["dmg"] == "collapsed":
            keep = rng.uniform(0.25, 0.7)
            cut = max(2.5, b["eave"] * keep)
            amp = rng.uniform(1.0, 2.8)
            floor = max(0.3, cut - 4.5)
        else:
            cut = rng.uniform(1.0, 4.5)
            amp = rng.uniform(0.6, 2.0)
            floor = 0.15
        ob = b["obb"]
        slope = 0.0
        if ob and rng.random() < 0.5:
            slope = rng.uniform(-0.25, 0.25)
        b["cut"] = {"h": r3(cut), "amp": r3(amp), "slope": round(slope, 4),
                    "dir": ob["ax"] if ob else [1, 0], "c": [r3(p.centroid.x), r3(p.centroid.y)],
                    "floor": r3(floor), "seed": rng.randrange(1 << 20)}
        half = (ob["L"] / 2) if ob else math.sqrt(p.area) / 2
        b["max_top"] = min(b["eave"], cut + abs(slope) * half + amp)
        b["min_top"] = max(0.3, cut - abs(slope) * half - amp)
        dense = shapely.segmentize(p, seg)
        inner = dense.buffer(-0.45, join_style="mitre", mitre_limit=2.0)
        inner_ps = [orient(q, 1.0) for q in polys_of(inner) if q.area > 3]
        if inner_ps:
            inner_m = shapely.segmentize(MultiPolygon(inner_ps), seg)
            strip = dense.difference(inner_m)
            b["shell"] = {
                "outer": poly_rings(dense),
                "inner": [poly_rings(q) for q in polys_of(inner_m)],
                "strip": tri(strip),
                "floor": tri(inner_m.simplify(0.05)),
            }
        else:
            b["shell"] = {"outer": poly_rings(dense), "inner": [], "strip": tri(dense), "floor": None}
        b["roof"] = "none"
    else:
        b["max_top"] = b["total"]
        b["min_top"] = b["eave"]

# Landmark extras: break some pinnacles and the belfry spire tip
for i, b in enumerate(final):
    if not b["lm"]:
        continue
    if b["roof"] == "pyramidal" and b["total"] > 60 and rng.random() < 0.5:
        b["truncate"] = round(rng.uniform(0.35, 0.6), 3)  # fraction of the spire height removed
    if b["lm"] == "gravensteen":
        b["crenel"] = True
for b in final:
    if b["lm"] == "belfry" and b["roof"] == "pyramidal" and b["total"] > 90:
        b["truncate"] = 0.42
        b["antenna"] = True

# bomb holes (boolean cutters): spheres centred just inside an exterior wall
for i in hole_set:
    b = final[i]
    p = b["poly"]
    cs = list(p.exterior.coords)
    cand = []
    for a, c in zip(cs[:-1], cs[1:]):
        L = math.hypot(c[0] - a[0], c[1] - a[1])
        if L > 3.5 and not [j for j in edge_owner.get(ekey(a, c), []) if j != i]:
            cand.append((a, c, L))
    if not cand:
        continue
    holes = []
    for _ in range(rng.choice([1, 1, 2, 2, 3] if b["lm"] is None else [2, 3, 4])):
        a, c, L = rng.choice(cand)
        tpos = rng.uniform(0.2, 0.8)
        nx, ny = (c[1] - a[1]) / L, -(c[0] - a[0]) / L  # outward (CCW ring)
        r = rng.uniform(1.4, 3.2) if b["lm"] is None else rng.uniform(2.5, 5.0)
        r = min(r, L * 0.45, b["eave"] * 0.4)
        top_bite = rng.random() < 0.3
        z = b["eave"] - rng.uniform(0, r * 0.4) if top_bite else rng.uniform(2.2 + r * 0.5, max(2.3 + r * 0.5, b["eave"] - r * 0.8))
        depth = rng.uniform(0.3, 0.8) * r
        holes.append([r3(a[0] + (c[0] - a[0]) * tpos - nx * depth), r3(a[1] + (c[1] - a[1]) * tpos - ny * depth),
                      r3(z), r3(r), rng.randrange(1 << 20)])
    b["holes"] = holes

# hidden shared walls: a wall on edge a-c is invisible if every neighbour on it stands taller
for i, b in enumerate(final):
    cs = list(b["poly"].exterior.coords)
    hidden = []
    for k, (a, c) in enumerate(zip(cs[:-1], cs[1:])):
        owners = [j for j in edge_owner.get(ekey(a, c), []) if j != i]
        shared = bool(owners)
        hid = shared and min(final[j]["min_top"] for j in owners) >= b["max_top"] - 0.05
        hidden.append(2 if hid else (1 if shared else 0))
    b["edges"] = hidden  # 0 exterior, 1 party wall (visible above neighbour), 2 hidden

counts = {}
for b in final:
    counts[b["dmg"]] = counts.get(b["dmg"], 0) + 1
log(f"damage: {counts}, holes: {sum(1 for b in final if b.get('holes'))}")

# ----------------------------------------------------------------------------- water, roads, bridges

water = unary_union([p for p in water_polys if p.intersects(FLAT)])
bld_union = unary_union([b["poly"] for b in final]).buffer(0.3)
wl = unary_union([ls.buffer(w / 2, cap_style="flat") for ls, w in water_lines])
wl = wl.difference(bld_union)
water = unary_union([water, wl]).intersection(FLAT)
water = unary_union([q for q in polys_of(water) if q.area > 30]).buffer(0.2).buffer(-0.2)
log(f"water area {water.area:.0f} m2")

bridges_all = unary_union([p for p in bridge_polys] + [ls.buffer(w / 2 + 0.5, cap_style="flat") for ls, w in bridge_lines])
decks = [q for q in polys_of(bridges_all.intersection(FLAT)) if q.intersects(water) and q.area > 15]
decks = [q.simplify(0.1) for q in decks]
log(f"bridge decks: {len(decks)}")

# Broken bridges: St. Michael's bridge plus the two longest other crossings.
mx, my = geo.to_local(51.05387, 3.72052)
deck_info = []
for q in decks:
    over = q.intersection(water)
    deck_info.append((q, over.area, over.centroid if not over.is_empty else q.centroid))
deck_info.sort(key=lambda d: -d[1])
broken_ids = set()
for k, (q, a, cpt) in enumerate(deck_info):
    if q.distance(Point(mx, my)) < 8:
        broken_ids.add(k)
for k, (q, a, cpt) in enumerate(deck_info):
    if len(broken_ids) >= 3:
        break
    if k not in broken_ids and a > 120 and chebyshev(cpt.x, cpt.y) < 480:
        broken_ids.add(k)
final_decks, broken = [], []
for k, (q, a, cpt) in enumerate(deck_info):
    if k in broken_ids:
        over = q.intersection(water)
        ob = obb_info(over) if over.geom_type == "Polygon" else None
        span = ob["L"] if ob else 12
        gap = jitter_disc(cpt.x, cpt.y, max(3.5, span * 0.22), n=14, amp=0.3)
        q = q.difference(gap)
        broken.append({"c": [r3(cpt.x), r3(cpt.y)], "r": r3(max(3.5, span * 0.22))})
    for piece in polys_of(q):
        if piece.area > 4:
            final_decks.append(orient(piece, 1.0))
decks_u = unary_union(final_decks) if final_decks else Polygon()

roads_asph, roads_cob = [], []
for ls, hw, w in road_lines:
    if not ls.intersects(FLAT):
        continue
    if chebyshev(*ls.centroid.coords[0]) > geo.BUILD_HALF and hw not in ASPHALT - {"service"}:
        continue
    g = ls.buffer(w / 2, quad_segs=3)
    (roads_asph if hw in ASPHALT else roads_cob).append(g)
asph = unary_union(roads_asph)
cob = unary_union(roads_cob + [p for p in square_polys if p.intersects(FLAT)])
cob = cob.difference(asph)

# ----------------------------------------------------------------------------- craters

road_center_lines = [ls for ls, hw, w in road_lines if hw in ASPHALT or hw in ("living_street", "pedestrian")]
craters = []


def crater_ok(x, y, r):
    pt = Point(x, y)
    if pt.buffer(r * 1.4).intersects(water) or (not decks_u.is_empty and pt.buffer(r * 1.4).intersects(decks_u)):
        return False
    for j in btree.query(pt.buffer(r + 1.0)):
        if final[j]["poly"].distance(pt) < r + 0.8:
            return False
    for cx, cy, cr in craters:
        if math.hypot(cx - x, cy - y) < cr + r + 12:
            return False
    return True


kx, ky = geo.to_local(51.05473, 3.72203)
for rr in (11.0, 9.0, 7.5):  # the Market Square Crater
    if crater_ok(kx, ky, rr):
        craters.append((kx, ky, rr))
        break
tries = 0
while len(craters) < 55 and tries < 6000:
    tries += 1
    ls = rng.choice(road_center_lines)
    pt = ls.interpolate(rng.random(), normalized=True)
    if chebyshev(pt.x, pt.y) > 560:
        continue
    r = rng.uniform(2.2, 5.0)
    if crater_ok(pt.x, pt.y, r):
        craters.append((pt.x, pt.y, r))
tries = 0
while len(craters) < 95 and tries < 6000:  # razed outskirts
    tries += 1
    x, y = rng.uniform(-1080, 1080), rng.uniform(-1080, 1080)
    if chebyshev(x, y) < 560:
        continue
    r = rng.uniform(3.0, 9.0)
    if crater_ok(x, y, r):
        craters.append((x, y, r))
crater_discs = [disc(x, y, r) for x, y, r in craters]
crater_u = unary_union(crater_discs)
log(f"craters {len(craters)}")

# ----------------------------------------------------------------------------- ground layers

asph = asph.intersection(FLAT).difference(water).difference(decks_u).difference(crater_u)
cob = cob.intersection(FLAT).difference(water).difference(decks_u).difference(crater_u)
roads_all = unary_union([asph, cob])
green = unary_union([p for p in green_polys if p.intersects(FLAT)]).intersection(FLAT)
green = green.difference(water).difference(roads_all).difference(decks_u).difference(crater_u)
dirt = unary_union([p for p in dirt_polys if p.intersects(FLAT)]).intersection(FLAT)
dirt = dirt.difference(water).difference(roads_all).difference(decks_u).difference(crater_u).difference(green)
ground = FLAT.difference(unary_union([water, roads_all, decks_u, crater_u, green, dirt]))

# urban paving in the old town, mud further out (noisy boundary)
blob = []
for k in range(72):
    a = 2 * math.pi * k / 72
    rr = 760 + 90 * (vnoise(math.cos(a) * 300, math.sin(a) * 300, 120) - 0.5) * 2
    # squircle so it hugs the square fetch box
    ca, sa = math.cos(a), math.sin(a)
    s = max(abs(ca), abs(sa))
    blob.append((ca / s * rr, sa / s * rr))
urban = Polygon(blob)
pave = ground.intersection(urban)
mud = ground.difference(urban)
mud = unary_union([mud, dirt])
log("ground layers done")

# ----------------------------------------------------------------------------- props

def free_spot(poly_fp, allow_roads=True):
    if poly_fp.intersects(water) or poly_fp.intersects(crater_u):
        return False
    for j in btree.query(poly_fp):
        if final[j]["poly"].intersects(poly_fp):
            return False
    return True


def rect(cx, cy, hx, hy, ang):
    ca, sa = math.cos(ang), math.sin(ang)
    pts = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x, y = sx * hx, sy * hy
        pts.append((cx + x * ca - y * sa, cy + x * sa + y * ca))
    return Polygon(pts)


cars = []
veh_lines = [(ls, w) for ls, hw, w in road_lines if hw in ASPHALT and hw != "service" and chebyshev(*ls.centroid.coords[0]) < 560]
tries = 0
while len(cars) < 64 and tries < 8000:
    tries += 1
    ls, w = rng.choice(veh_lines)
    if ls.length < 8:
        continue
    d = rng.uniform(2, ls.length - 2)
    p0, p1 = ls.interpolate(d - 1), ls.interpolate(d + 1)
    ang = math.atan2(p1.y - p0.y, p1.x - p0.x)
    side = rng.choice([-1, 1])
    off = max(0.0, w / 2 - 1.3) * side
    cx = (p0.x + p1.x) / 2 - math.sin(ang) * off
    cy = (p0.y + p1.y) / 2 + math.cos(ang) * off
    mode = rng.random()
    if mode < 0.25:
        ang += rng.uniform(0.4, 1.4) * rng.choice([-1, 1])
    else:
        ang += rng.uniform(-0.15, 0.15)
    if rng.random() < 0.5:
        ang += math.pi
    fp = rect(cx, cy, 2.3, 1.0, ang)
    if not free_spot(fp) or any(math.hypot(cx - c[0], cy - c[1]) < 6 for c in cars):
        continue
    cars.append([r3(cx), r3(cy), round(ang, 4), 1 if rng.random() < 0.12 else 0, rng.randrange(1 << 20)])
log(f"cars {len(cars)}")

hedgehogs = []
tries = 0
fx, fy = geo.to_local(51.05645, 3.72575)
while len(hedgehogs) < 60 and tries < 6000:
    tries += 1
    if len(hedgehogs) < 16:  # barricade line across the Friday Market
        x, y = fx + rng.uniform(-35, 35), fy + rng.uniform(-30, 30)
    else:
        ls, w = rng.choice(veh_lines)
        pt = ls.interpolate(rng.random(), normalized=True)
        x, y = pt.x + rng.uniform(-2, 2), pt.y + rng.uniform(-2, 2)
    fp = Point(x, y).buffer(1.2)
    if not free_spot(fp) or any(math.hypot(x - h[0], y - h[1]) < 3 for h in hedgehogs):
        continue
    hedgehogs.append([r3(x), r3(y), round(rng.uniform(0, math.pi), 3)])

mounds = []
for i, b in enumerate(final):
    if b["dmg"] not in ("collapsed", "ruined"):
        continue
    p = b["poly"]
    cs = list(p.exterior.coords)
    ext = [(a, c) for a, c in zip(cs[:-1], cs[1:])
           if math.hypot(c[0] - a[0], c[1] - a[1]) > 3 and not [j for j in edge_owner.get(ekey(a, c), []) if j != i]]
    k = 0
    want = (1 + int(rng.random() * 2.2)) if b["dist"] < 600 else int(rng.random() * 1.6)
    rng.shuffle(ext)
    for a, c in ext[:want]:
        L = math.hypot(c[0] - a[0], c[1] - a[1])
        tpos = rng.uniform(0.25, 0.75)
        nx, ny = (c[1] - a[1]) / L, -(c[0] - a[0]) / L
        r = rng.uniform(2.0, 4.0) * (1.3 if b["dmg"] == "collapsed" else 1.0)
        off = rng.uniform(0.3, 0.9) * r
        x = a[0] + (c[0] - a[0]) * tpos + nx * off
        y = a[1] + (c[1] - a[1]) * tpos + ny * off
        if Point(x, y).buffer(r).intersects(water):
            continue
        hgt = min(rng.uniform(0.25, 0.5) * r * 1.4, b["max_top"] * 0.6 + 0.6)
        mounds.append([r3(x), r3(y), r3(r), r3(hgt), rng.randrange(1 << 20), 1 if b["dist"] < 600 else 0])
        k += 1
    if b["dmg"] == "ruined" and p.area > 40:
        c = p.representative_point()
        r = min(math.sqrt(p.area) * 0.35, 7)
        mounds.append([r3(c.x), r3(c.y), r3(r), r3(r * 0.35), rng.randrange(1 << 20), 1 if b["dist"] < 600 else 0])
tries = 0
extra = 0
while extra < 160 and tries < 5000:  # razed districts: spoil heaps
    tries += 1
    x, y = rng.uniform(-1080, 1080), rng.uniform(-1080, 1080)
    if chebyshev(x, y) < geo.BUILD_HALF - 60:
        continue
    r = rng.uniform(3, 9)
    fp = Point(x, y).buffer(r)
    if fp.intersects(water) or fp.intersects(asph):
        continue
    mounds.append([r3(x), r3(y), r3(r), r3(r * rng.uniform(0.2, 0.4)), rng.randrange(1 << 20), 0])
    extra += 1
log(f"rubble mounds {len(mounds)}")

scaffolds = []
cands = [i for i, b in enumerate(final) if b["dmg"] == "intact" and b["dist"] < 520 and b["eave"] > 7 and not b["lm"]]
rng.shuffle(cands)
for i in cands[: int(len(cands) * 0.07)]:
    b = final[i]
    cs = list(b["poly"].exterior.coords)
    best = None
    for k, (a, c) in enumerate(zip(cs[:-1], cs[1:])):
        L = math.hypot(c[0] - a[0], c[1] - a[1])
        if b["edges"][k] == 0 and 5 < L < 26 and (best is None or L > best[2]):
            best = (a, c, L)
    if best:
        a, c, L = best
        hgt = min(b["eave"] + 1.0, 3.0 * max(2, int((b["eave"] - 1) / 2.0)))
        scaffolds.append([r3(a[0]), r3(a[1]), r3(c[0]), r3(c[1]), r3(hgt), rng.randrange(1 << 20)])
# scaffold around one cathedral tower face too
log(f"scaffolds {len(scaffolds)}")

trees = []
for g in polys_of(green):
    if g.area < 150:
        continue
    nt = min(int(g.area / 320), 40)
    minx, miny, maxx, maxy = g.bounds
    tries = 0
    k = 0
    while k < nt and tries < nt * 8:
        tries += 1
        x, y = rng.uniform(minx, maxx), rng.uniform(miny, maxy)
        if not g.contains(Point(x, y).buffer(0.8)):
            continue
        trees.append([r3(x), r3(y), r3(rng.uniform(4, 11)), rng.randrange(1 << 20)])
        k += 1
log(f"dead trees {len(trees)}")

# ----------------------------------------------------------------------------- landmarks + spawns

landmarks = []
for lid, name, _, ll, rad in LANDMARK_DEFS:
    members = [b for b in final if b["lm"] == lid]
    if members:
        u = unary_union([b["poly"] for b in members])
        c = u.centroid
        top = max(b["max_top"] - b["roof_h"] * b.get("truncate", 0.0) for b in members)
        rad = max(rad * 0.5, math.sqrt(u.area / math.pi) * 1.3)
        landmarks.append({"id": lid, "name": name, "bx": c.x, "by": c.y, "top": top, "radius": rad})
    else:
        x, y = geo.to_local(*ll)
        landmarks.append({"id": lid, "name": name, "bx": x, "by": y, "top": 20.0, "radius": rad})
for lid, name, ll, rad in LANDMARK_SITES:
    x, y = geo.to_local(*ll)
    top = 8.0
    if lid == "market_crater" and craters:
        x, y = craters[0][0], craters[0][1]
        top = 2.0
    if lid == "broken_bridge" and broken:
        bx, by = min(((bk["c"][0], bk["c"][1]) for bk in broken), key=lambda c: math.hypot(c[0] - mx, c[1] - my))
        x, y = bx, by
        top = 3.0
    landmarks.append({"id": lid, "name": name, "bx": x, "by": y, "top": top, "radius": rad})
log(f"landmarks {len(landmarks)}")

# spawn candidates: open air over the core, well clear of anything tall
tall_pts = []
grid = []
for gx in range(-420, 421, 12):
    for gy in range(-420, 421, 12):
        grid.append((gx + rng.uniform(-4, 4), gy + rng.uniform(-4, 4)))
spawn_cands = []
for x, y in grid:
    pt = Point(x, y)
    near = btree.query(pt.buffer(30))
    tops = [final[j]["max_top"] for j in near if final[j]["poly"].distance(pt) < 30]
    hmax = max(tops) if tops else 0
    if any(final[j]["poly"].distance(pt) < 4 for j in near):
        continue
    if any(math.hypot(x - L["bx"], y - L["by"]) < 40 and L["top"] > 40 for L in landmarks):
        continue
    z = max(25.0, hmax + 9.0)
    if z > 40:
        continue
    spawn_cands.append((x, y, z))
srng = random.Random(geo.SEED + 7)
spawns = [srng.choice(spawn_cands)]
while len(spawns) < 12:
    best = max(spawn_cands, key=lambda c: min(math.hypot(c[0] - s[0], c[1] - s[1]) for s in spawns))
    spawns.append(best)
spawns = [(x, y, min(40.0, z + srng.uniform(0, 6))) for x, y, z in spawns]
log(f"spawns {len(spawns)} from {len(spawn_cands)} candidates")

# ----------------------------------------------------------------------------- collision footprints

def col_rings(b):
    """Simplified footprint for collision + per-edge 'hidden' flags (wall fully inside a taller neighbour)."""
    p = b["poly"]
    core = b["dist"] < 600
    tol = 0.8 if core else 2.0
    q = p.simplify(tol, preserve_topology=True)
    ps = polys_of(q)
    if not ps:
        return None
    q = max(ps, key=lambda s: s.area)
    ob = b["obb"]
    if ob and ob["fill"] > 0.8 and (not core or len(q.exterior.coords) > 10):
        q = p.minimum_rotated_rectangle
    q = orient(q, 1.0)
    rings = poly_rings(q)
    # map simplified vertices back to original exterior vertices to inherit edge flags
    orig = [(round(x, 3), round(y, 3)) for x, y in list(b["poly"].exterior.coords)[:-1]]
    pos = {c: k for k, c in enumerate(orig)}
    flags = b["edges"]
    hidden = []
    ext = rings[0]
    n = len(orig)
    for k in range(len(ext)):
        a = pos.get((ext[k][0], ext[k][1]))
        c = pos.get((ext[(k + 1) % len(ext)][0], ext[(k + 1) % len(ext)][1]))
        h = 0
        if a is not None and c is not None:
            chain = []
            i = a
            while i != c and len(chain) <= n:
                chain.append(flags[i])
                i = (i + 1) % n
            h = 1 if chain and all(f == 2 for f in chain) else 0
        hidden.append(h)
    return {"rings": rings, "cap": tri(q), "hidden": hidden}


# ----------------------------------------------------------------------------- write

out_b = []
for i, b in enumerate(final):
    p = b["poly"]
    d = {
        "id": i, "oid": b["oid"], "dmg": b["dmg"], "mat": b["mat"], "lm": b["lm"],
        "tint": [round(v, 3) for v in b["tint"]], "roof_tint": [round(v, 3) for v in b["roof_tint"]],
        "eave": r3(b["eave"]), "roof": b["roof"], "roof_h": r3(b["roof_h"]),
        "max_top": r3(b["max_top"]), "min_top": r3(b["min_top"]),
        "rings": poly_rings(p), "edges": b["edges"], "obb": b["obb"],
        "core": b["dist"] < 600,
    }
    c = p.centroid
    d["centroid"] = [r3(c.x), r3(c.y)]
    if b["dmg"] in ("intact",):
        d["cap"] = tri(p)
        if b.get("roof_holes"):
            d["roof_cap"] = tri(p.difference(unary_union(b["roof_holes"])))
            d["roof_holes"] = [ring_list(h.exterior) for h in b["roof_holes"]]
    if "cut" in b:
        d["cut"] = b["cut"]
        d["shell"] = b["shell"]
    for k in ("holes", "truncate", "antenna", "crenel", "rafters", "gutted"):
        if k in b:
            d[k] = b[k]
    d["col"] = col_rings(b)
    out_b.append(d)


def quay_rings(g):
    rings = []
    for p in polys_of(g):
        p = orient(p, 1.0)
        rings.append(ring_list(p.exterior))
        rings.extend(ring_list(r) for r in p.interiors)
    return rings


water_s = water.simplify(0.3)
deck_out = []
for q in final_decks:
    edges = []
    cs = list(q.exterior.coords)
    inner_w = water.buffer(-0.5)
    for a, c in zip(cs[:-1], cs[1:]):
        mid = Point((a[0] + c[0]) / 2, (a[1] + c[1]) / 2)
        edges.append(1 if inner_w.contains(mid) else 0)
    deck_out.append({"rings": poly_rings(q), "cap": tri(q), "parapet": edges})

out = {
    "meta": {"seed": geo.SEED, "center": [geo.CENTER_LAT, geo.CENTER_LON], "core_half": geo.CORE_HALF,
             "build_half": geo.BUILD_HALF, "flat_half": geo.FLAT_HALF, "terrain_half": geo.TERRAIN_HALF},
    "buildings": out_b,
    "ground": {"asphalt": tri(asph), "cobble": tri(cob), "pave": tri(pave), "mud": tri(mud),
               "grass": tri(green), "water": tri(water_s)},
    "quays": quay_rings(water_s),
    "decks": deck_out,
    "broken_bridges": broken,
    "craters": [[r3(x), r3(y), r3(r)] for x, y, r in craters],
    "cars": cars, "hedgehogs": hedgehogs, "mounds": mounds, "scaffolds": scaffolds, "trees": trees,
    "landmarks": [{k: (r3(v) if isinstance(v, float) else v) for k, v in L.items()} for L in landmarks],
    "spawns": [[r3(x), r3(y), r3(z)] for x, y, z in spawns],
    "collision_ground": {"land": tri(FLAT.difference(water_s).simplify(0.5)), "water": tri(water_s.simplify(0.5))},
}
OUT.write_text(json.dumps(out, separators=(",", ":")))
log(f"wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB)")
