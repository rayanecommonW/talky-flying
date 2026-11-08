"""Tiny procedural tiling textures (numpy only), baked at build time. All CC0 by construction.

Every function returns an (H, W, 3) float32 array in display (sRGB) space, values 0..1,
row 0 = bottom of the image (Blender's pixel order). Most are near-white so per-building
vertex colours carry the hue; windows/soot stay dark.
"""
import numpy as np

S = 512


def _rng(seed):
    return np.random.default_rng(seed)


def _up(grid, size):
    """Bilinear, wrap-around upsample of a (n, n) grid to (size, size): tileable."""
    n = grid.shape[0]
    t = np.arange(size) * n / size
    i0 = np.floor(t).astype(int) % n
    i1 = (i0 + 1) % n
    f = t - np.floor(t)
    f = f * f * (3 - 2 * f)
    rows = grid[i0] * (1 - f)[:, None] + grid[i1] * f[:, None]
    return rows[:, i0] * (1 - f)[None, :] + rows[:, i1] * f[None, :]


def fbm(seed, size=S, base=4, octaves=5, gain=0.5):
    r = _rng(seed)
    out = np.zeros((size, size), np.float32)
    amp, tot, n = 1.0, 0.0, base
    for _ in range(octaves):
        out += amp * _up(r.random((n, n)).astype(np.float32), size)
        tot += amp
        amp *= gain
        n = min(n * 2, size)
    return out / tot


def _rgb(gray, tint=(1, 1, 1)):
    return np.stack([gray * tint[0], gray * tint[1], gray * tint[2]], -1)


def _clip(a):
    return np.clip(a, 0, 1).astype(np.float32)


def brick_field(seed, size=S, course=4, brick=11, mortar=0.72, var=0.16):
    r = _rng(seed)
    y = np.arange(size)[:, None]
    x = np.arange(size)[None, :]
    row = y // course
    off = (row % 2) * (brick // 2)
    col = (x + off) // brick
    rows_n = size // course + 1
    cols_n = size // brick + 2
    tone = r.random((rows_n, cols_n)).astype(np.float32)
    t = tone[row % rows_n, col % cols_n]
    g = 0.86 + (t - 0.5) * 2 * var
    is_mortar = ((y % course) == 0) | (((x + off) % brick) == 0)
    g = np.where(is_mortar, mortar, g)
    return g.astype(np.float32)


def _window_grid(img, seed, bays=4, floors=4, kind="brick"):
    """Paint a window per bay per floor with post-war variants (in place)."""
    r = _rng(seed)
    H, W, _ = img.shape
    bw, fh = W // bays, H // floors
    ww, wh = int(bw * 0.40), int(fh * 0.56)
    sill = int(fh * 0.28)
    soot = np.zeros((H, W), np.float32)
    for f in range(floors):
        for b in range(bays):
            x0 = b * bw + (bw - ww) // 2
            y0 = f * fh + sill
            x1, y1 = x0 + ww, y0 + wh
            v = r.random()
            # lintel + sill
            img[y1:y1 + 4, x0 - 3:x1 + 3] = 0.92
            img[y0 - 3:y0, x0 - 4:x1 + 4] = 0.88
            if kind == "plaster" and v < 0.55:  # shutters
                img[y0:y1, x0 - 14:x0 - 1] = 0.40
                img[y0:y1, x1 + 1:x1 + 14] = 0.40
                img[y0:y1:5, x0 - 14:x0 - 1] = 0.30
                img[y0:y1:5, x1 + 1:x1 + 14] = 0.30
            if v < 0.34:  # intact dark glass with frame + mullions
                img[y0:y1, x0:x1] = (0.10, 0.11, 0.12)
                img[y0:y1, x0 + ww // 2 - 1:x0 + ww // 2 + 1] = 0.45
                img[y0 + wh * 2 // 3 - 1:y0 + wh * 2 // 3 + 1, x0:x1] = 0.45
                img[y0:y1, x0:x0 + 2] = 0.45
                img[y0:y1, x1 - 2:x1] = 0.45
                gl = r.random((y1 - y0, x1 - x0)) < 0.05
                img[y0:y1, x0:x1][gl] = 0.22
            elif v < 0.66:  # blown out: black hole with jagged shards
                img[y0:y1, x0:x1] = 0.025
                for _ in range(6):
                    sx = r.integers(x0, x1)
                    sy = r.integers(y0, y1)
                    ln = r.integers(3, 12)
                    img[sy:sy + 2, max(x0, sx - ln):sx] = 0.16
                soot[y1:min(H, y1 + int(fh * 0.55)), x0 - 4:x1 + 4] += np.linspace(0.75, 0.0, max(1, min(H, y1 + int(fh * 0.55)) - y1))[:, None]
            elif v < 0.86:  # boarded up
                img[y0:y1, x0:x1] = 0.06
                for k in range(y0 + 2, y1 - 2, 8):
                    tone = 0.40 + r.random() * 0.15
                    img[k:k + 6, x0 - 2:x1 + 2] = (tone * 1.05, tone * 0.92, tone * 0.78)
            else:  # bricked up / sandbagged
                img[y0:y1, x0:x1] *= 0.62
                img[y0:y1:4, x0:x1] *= 0.8
    k = np.clip(soot, 0, 0.85)
    img *= (1 - k)[..., None]


def facade_brick(seed=11):
    g = brick_field(seed)
    n = fbm(seed + 1, base=6)
    stain = fbm(seed + 2, base=3)
    g = g * (0.80 + 0.35 * n) * (0.85 + 0.25 * stain)
    img = _rgb(g, (1.0, 0.93, 0.88))
    # string course every floor
    for f in range(4):
        img[f * 128 + 126:f * 128 + 128, :] = 0.95
    _window_grid(img, seed + 3, kind="brick")
    # vertical rain streaks
    streak = _up(_rng(seed + 4).random((1, 64)).repeat(64, 0).astype(np.float32), S)
    img *= (0.85 + 0.15 * streak)[..., None]
    return _clip(img)


def facade_plaster(seed=21):
    n = fbm(seed, base=4, octaves=6)
    g = 0.84 + (n - 0.5) * 0.35
    img = _rgb(g, (1.0, 0.98, 0.94))
    # spalled plaster revealing brick
    holes = fbm(seed + 1, base=5) > 0.66
    br = brick_field(seed + 2) * 0.62
    img[holes] = np.stack([br, br * 0.8, br * 0.7], -1)[holes]
    # cracks
    r = _rng(seed + 3)
    for _ in range(40):
        x, y = r.integers(0, S, 2)
        for _ in range(r.integers(20, 80)):
            img[y % S, x % S] *= 0.55
            x += r.integers(-1, 2)
            y += r.integers(0, 2)
    for f in range(4):
        img[f * 128 + 124:f * 128 + 128, :] *= 0.86
    _window_grid(img, seed + 4, kind="plaster")
    return _clip(img)


def facade_stone(seed=31):
    """Ashlar + tall lancet windows (landmarks). 512 px = 12 m x 12.8 m."""
    y = np.arange(S)[:, None]
    x = np.arange(S)[None, :]
    course = 13
    row = y // course
    off = (row % 2) * 13
    blk = 27
    r = _rng(seed)
    tone = r.random((S // course + 2, S // blk + 3)).astype(np.float32)
    t = tone[row, (x + off) // blk]
    g = 0.80 + (t - 0.5) * 0.18
    g = np.where(((y % course) == 0) | (((x + off) % blk) == 0), 0.62, g)
    n = fbm(seed + 1, base=5)
    g = g * (0.8 + 0.3 * n)
    img = _rgb(g, (1.0, 0.98, 0.94))
    # two lancet windows per tile, one storey of 12.8 m
    for cx in (128, 384):
        w, y0, y1 = 30, 90, 390
        xs = np.arange(cx - w, cx + w)
        for yy in range(y0, y1 + 60):
            if yy < y1:
                half = w
            else:  # pointed arch
                k = (yy - y1) / 60.0
                half = int(w * np.sqrt(max(0.0, 1 - k * k)) * (1 - 0.35 * k))
            if half <= 0:
                continue
            img[yy, cx - half:cx + half] = 0.035
        img[y0:y1 + 40, cx - 2:cx + 2] = 0.30
        for yy in range(y0 + 50, y1, 60):
            img[yy:yy + 3, cx - w:cx + w] = 0.30
        # soot plume
        h = 120
        sl = np.linspace(0.6, 0, h)[:, None]
        img[y1 + 60:y1 + 60 + h, cx - w - 6:cx + w + 6] *= (1 - sl)[..., None][: max(0, min(h, S - (y1 + 60)))]
    return _clip(img)


def wall_party(seed=41):
    g = brick_field(seed) * (0.75 + 0.35 * fbm(seed + 1, base=5))
    img = _rgb(g, (1.0, 0.93, 0.88))
    # ghost of a demolished neighbour's floors/roofline
    for f in range(4):
        img[f * 128 + 60:f * 128 + 64, :] *= 0.7
    return _clip(img)


def wall_inner(seed=51):
    n = fbm(seed, base=4, octaves=6)
    img = _rgb(0.55 + 0.3 * n, (1.0, 0.95, 0.88))
    # faded wallpaper bands per floor
    y = np.arange(S)[:, None]
    x = np.arange(S)[None, :]
    pat = ((x // 8 + y // 16) % 2) * 0.08
    band = ((y % 128) > 20) & ((y % 128) < 110)
    paper = fbm(seed + 1, base=3) > 0.45
    img *= (1 - np.where(band & paper, pat, 0))[..., None]
    # soot from fires, heavier at the top
    soot = fbm(seed + 2, base=4) * (y / S) * 1.4
    img *= (1 - np.clip(soot, 0, 0.8))[..., None]
    # floor lines (joist pockets)
    for f in range(4):
        img[f * 128:f * 128 + 6, :] *= 0.35
    return _clip(img)


def roof_tiles(seed=61):
    """512 px = 6 m x 6 m of slate/clay rows along v."""
    r = _rng(seed)
    y = np.arange(S)[:, None]
    x = np.arange(S)[None, :]
    rowh = 14
    row = y // rowh
    off = (row % 2) * 9
    col = (x + off) // 18
    tone = r.random((S // rowh + 2, S // 18 + 3)).astype(np.float32)
    t = tone[row, col]
    g = 0.78 + (t - 0.5) * 0.3
    g = g * (1 - 0.35 * ((y % rowh) / rowh) ** 3)  # shadow under each row
    g = np.where(((x + off) % 18) == 0, g * 0.75, g)
    # missing tiles
    miss = (r.random((S // rowh + 2, S // 18 + 3)) < 0.04)[row, col]
    g = np.where(miss, 0.12, g)
    g *= 0.8 + 0.3 * fbm(seed + 1, base=4)
    return _clip(_rgb(g))


def roof_flat(seed=71):
    n = fbm(seed, base=8, octaves=6)
    g = 0.55 + 0.35 * n
    r = _rng(seed + 1)
    speck = r.random((S, S)) < 0.06
    g = np.where(speck, g * 0.7, g)
    puddle = fbm(seed + 2, base=8) > 0.66
    g = np.where(puddle, g * 0.8, g)
    # tar seams
    g = np.where((np.arange(S)[None, :] % 128) < 2, g * 0.7, g)
    return _clip(_rgb(g, (1.0, 0.98, 0.95)))


def rubble(seed=81):
    """Broken brick, plaster and concrete chunks."""
    r = _rng(seed)
    img = _rgb(0.45 + 0.25 * fbm(seed, base=8, octaves=6), (1.0, 0.95, 0.9))
    cols = [(0.62, 0.38, 0.30), (0.70, 0.68, 0.64), (0.40, 0.39, 0.38), (0.55, 0.45, 0.36), (0.18, 0.17, 0.16)]
    for _ in range(1600):
        x, y = r.integers(0, S, 2)
        w, h = r.integers(3, 16, 2)
        c = cols[r.integers(0, len(cols))]
        sh = 0.75 + 0.4 * r.random()
        ys = np.arange(y, y + h) % S
        xs = np.arange(x, x + w) % S
        img[np.ix_(ys, xs)] = np.array(c, np.float32) * sh
        img[(y + h) % S, xs] *= 0.4  # contact shadow
    return _clip(img)


def asphalt(seed=91):
    """512 px = 8 m. Dark, wet, cracked, patched."""
    n = fbm(seed, base=16, octaves=5)
    g = 0.42 + 0.22 * n
    r = _rng(seed + 1)
    g = np.where(r.random((S, S)) < 0.10, g * 1.25, g)
    wet = fbm(seed + 2, base=3)
    g = np.where(wet > 0.6, g * 0.6, g)
    for _ in range(30):  # cracks
        x, y = r.integers(0, S, 2)
        dx, dy = r.choice([-1, 0, 1]), r.choice([-1, 0, 1])
        for _ in range(r.integers(30, 160)):
            g[y % S, x % S] *= 0.45
            x += dx if r.random() < 0.7 else r.integers(-1, 2)
            y += dy if r.random() < 0.7 else r.integers(-1, 2)
    patch = fbm(seed + 3, base=4) > 0.7
    g = np.where(patch, g * 0.82, g)
    return _clip(_rgb(g, (0.97, 0.98, 1.0)))


def cobble(seed=101):
    """Setts, 512 px = 8 m (each sett ~0.16 m)."""
    y = np.arange(S)[:, None]
    x = np.arange(S)[None, :]
    c = 10
    row = y // c
    off = (row % 2) * 5
    r = _rng(seed)
    tone = r.random((S // c + 2, S // c + 3)).astype(np.float32)
    t = tone[row, (x + off) // c]
    lx = ((x + off) % c) / c - 0.5
    ly = (y % c) / c - 0.5
    bump = 1 - np.clip((lx * lx + ly * ly) * 2.2, 0, 1) ** 2
    g = (0.45 + 0.35 * t) * (0.55 + 0.45 * bump)
    g *= 0.8 + 0.3 * fbm(seed + 1, base=4)
    miss = (r.random((S // c + 2, S // c + 3)) < 0.03)[row, (x + off) // c]
    g = np.where(miss, 0.15, g)
    return _clip(_rgb(g, (1.0, 0.98, 0.96)))


def pave(seed=111):
    """Pavement slabs (0.6 m), 512 px = 6 m, cracked and dirty."""
    y = np.arange(S)[:, None]
    x = np.arange(S)[None, :]
    c = 51
    r = _rng(seed)
    tone = r.random((S // c + 2, S // c + 2)).astype(np.float32)
    t = tone[y // c, x // c]
    g = 0.62 + 0.15 * (t - 0.5)
    g = np.where(((x % c) < 2) | ((y % c) < 2), g * 0.6, g)
    g *= 0.75 + 0.4 * fbm(seed + 1, base=6)
    dirt = fbm(seed + 2, base=3) > 0.55
    g = np.where(dirt, g * 0.75, g)
    return _clip(_rgb(g, (1.0, 0.98, 0.95)))


def mud(seed=121):
    n = fbm(seed, base=6, octaves=6)
    g = 0.5 + 0.4 * n
    r = _rng(seed + 1)
    g = np.where(r.random((S, S)) < 0.08, g * 0.75, g)
    ruts = (np.sin(np.arange(S)[None, :] / S * 2 * np.pi * 24 + fbm(seed + 2, base=4) * 6) > 0.92)
    g = np.where(ruts, g * 0.7, g)
    return _clip(_rgb(g, (1.0, 0.92, 0.80)))


def grass(seed=131):
    n = fbm(seed, base=10, octaves=6)
    r = _rng(seed + 1)
    blades = r.random((S, S)).astype(np.float32)
    g = 0.45 + 0.3 * n + 0.18 * (blades - 0.5)
    bare = fbm(seed + 2, base=4) > 0.6
    img = _rgb(g, (0.92, 1.0, 0.70))
    img[bare] = _rgb(g, (1.0, 0.88, 0.72))[bare] * 0.9
    return _clip(img)


def quay(seed=141):
    """Large stone blocks with dark algae towards the waterline (v=0 at the bottom)."""
    y = np.arange(S)[:, None]
    x = np.arange(S)[None, :]
    course = 32
    row = y // course
    off = (row % 2) * 40
    r = _rng(seed)
    tone = r.random((S // course + 2, S // 80 + 3)).astype(np.float32)
    t = tone[row, (x + off) // 80]
    g = 0.68 + 0.18 * (t - 0.5)
    g = np.where(((y % course) < 2) | (((x + off) % 80) < 2), g * 0.6, g)
    g *= 0.8 + 0.3 * fbm(seed + 1, base=6)
    img = _rgb(g, (1.0, 0.98, 0.94))
    algae = np.clip(1 - y / (S * 0.55), 0, 1) ** 1.5
    img = img * (1 - algae[..., None] * 0.7) + algae[..., None] * np.array([0.05, 0.07, 0.04]) * 0.7
    return _clip(img)


def metal(seed=151):
    """Burnt paint and rust."""
    n = fbm(seed, base=6, octaves=6)
    rust = fbm(seed + 1, base=5)
    img = _rgb(0.20 + 0.25 * n, (1, 1, 1))
    rr = rust > 0.5
    img[rr] = (np.stack([0.45 * n, 0.24 * n, 0.12 * n], -1) + 0.08)[rr]
    paint = fbm(seed + 2, base=4) > 0.72
    img[paint] = np.array([0.42, 0.42, 0.40]) * (0.8 + 0.3 * n[paint])[:, None]
    return _clip(img)


def wood(seed=161):
    y = np.arange(S)[:, None]
    x = np.arange(S)[None, :]
    grain = np.sin(y * 0.6 + fbm(seed, base=8) * 20) * 0.5 + 0.5
    g = 0.45 + 0.2 * grain
    g = np.where((y % 64) < 2, g * 0.5, g)
    g *= 0.8 + 0.3 * fbm(seed + 1, base=4)
    return _clip(_rgb(g, (1.0, 0.85, 0.65)))


def scorch(seed=171):
    n = fbm(seed, base=6, octaves=6)
    img = _rgb(0.18 + 0.25 * n, (1.0, 0.92, 0.82))
    r = _rng(seed + 1)
    img[r.random((S, S)) < 0.05] *= 0.4
    return _clip(img)


def bark(seed=181):
    x = np.arange(S)[None, :]
    y = np.arange(S)[:, None]
    ridges = np.sin(x * 0.35 + fbm(seed, base=6) * 12) * 0.5 + 0.5
    g = 0.25 + 0.25 * ridges * (0.7 + 0.3 * fbm(seed + 1, base=12))
    return _clip(_rgb(g + 0 * y, (1.0, 0.9, 0.8)))


def char(seed=191):
    n = fbm(seed, base=8, octaves=6)
    return _clip(_rgb(0.08 + 0.12 * n, (1.0, 0.95, 0.9)))


ALL = {
    "facade_brick": facade_brick, "facade_plaster": facade_plaster, "facade_stone": facade_stone,
    "wall_party": wall_party, "wall_inner": wall_inner, "roof_tiles": roof_tiles, "roof_flat": roof_flat,
    "rubble": rubble, "asphalt": asphalt, "cobble": cobble, "pave": pave, "mud": mud, "grass": grass,
    "quay": quay, "metal": metal, "wood": wood, "scorch": scorch, "bark": bark, "char": char,
}
