# Port Ardent: city pipeline

Builds the game city (in fiction: **Port Ardent**) from a real OpenStreetMap street layout
(about 2.2 × 2.2 km of central Ghent, Belgium) plus a seeded post-war damage pass, then exports
the assets the three.js client loads from `apps/web/public/city/`.

> Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).
> https://www.openstreetmap.org/copyright
> The shipped meshes are a Produced Work derived from that data. Port Ardent is fictional.
> The game never names or shows the real city.

All textures are generated procedurally at build time (`textures.py`), so there are no
third-party texture assets and no licence to track for them.

## Run

```bash
tools/city/build.sh                 # fetch (only if no cache) → prep → Blender → compress → stats + previews
tools/city/build.sh --no-previews   # same, without the Cycles preview renders (~25 s total)
tools/city/build.sh --refetch       # re-download the OSM extract first
```

Needs `uv`, Blender 5.x (`BLENDER=/path/to/blender` to override `/opt/homebrew/bin/blender`),
Node 24 with `npx` (it runs `@gltf-transform/cli@4.5.1`).
`data/osm_raw.json` is the cached Overpass response. With it present the build runs fully offline,
apart from `uv` and `npx` fetching their packages the first time.

## Pipeline

| Step | File | What it does |
|---|---|---|
| 1 | `fetch_osm.py` | One Overpass query: buildings + `building:part` (±900 m), highways, water, bridges, parks and landuse (±1250 m). Cached to `data/osm_raw.json`. |
| 2 | `prep.py` (uv + shapely) | Projects lat/lon to local metres around 51.0543 N, 3.7225 E. Assembles multipolygons, swaps building outlines for their `building:part`s (so the landmark towers get their real heights), and assigns heights and roofs. Runs the **seeded damage pass** and lays out water, roads, bridges, craters, cars, rubble, scaffolds, trees, landmarks and spawns. Triangulates the flat areas (constrained Delaunay). Writes `data/prepared.json`. |
| 3 | `build.py` (Blender, headless) | Pure bpy/bmesh meshing: extruded footprints, gabled/hipped/pyramidal roofs, jagged collapsed shells with wall thickness, boolean bomb holes (Manifold solver), road/ground ribbons at y=0, recessed water with quay walls, bridge decks with parapets, props, and the outskirts terrain. Bakes the procedural textures, merges geometry by material per map quadrant, then exports `build/city_raw.glb` and `collision.glb`, writes the JSON files and renders `previews/*.png` (Cycles). |
| 4 | `build.sh` | `gltf-transform optimize` (weld, WebP textures, no join/simplify) → `meshopt` (16-bit positions and UVs). Prints the stats. |

Everything random is seeded (`geo.SEED = 1945`), so the same cache always gives the same city.

### Post-war pass (core numbers, seed 1945)

- About 30 % of core buildings have collapsed upper floors: the height is cut, the top is jagged, the walls have thickness and the interior is rubble-filled. About 40 % of those are *gutted*: walls still stand at full height, roof and floors are gone, and the top is fire-blackened.
- About 10 % are fully ruined (stub walls only). The outer ring (beyond 600 m) is mostly ruins, which reads as the city thinning out into razed districts.
- About 15 % of all buildings get boolean bomb holes in their facades (spherical cutters with charred cavities). Every landmark takes several.
- Flat roofs get blast holes. Some pitched roofs lose their tiles and keep bare rafters. Collapsed buildings have charred joists sticking out.
- 95 craters (one large one in the market square), about 5,000 rubble heaps with loose chunks, 64 burned car hulks, 60 anti-tank hedgehogs (a barricade line on the Friday Market), about 130 scaffolds, and about 1,000 dead or snapped trees. Three bridges are broken (St Michael's plus two others), with debris in the water.
- Landmarks are built from OSM `building:part` data and stay recognisable. The cathedral tower is 89 m with corner pinnacles. The belfry's spire is truncated and carries a bent lattice radio mast. St Nicholas has its 76 m crossing tower. Gravensteen has crenellations.
- Outskirts: flat razed ground with the real road and canal network out to ±1100 m. Beyond that, procedural rolling terrain out to ±1600 m, rising at the edge so the horizon is closed. It has field patchwork, shell craters, ruined farmsteads and dead tree lines.

## Output contract (`apps/web/public/city/`)

Coordinates are glTF Y-up, in metres. Origin is the centre of the core at street level, and the ground is at y = 0.
glTF (x, y, z) = Blender (x, z, −y). +x is east and −z is north. The core spans x, z ∈ [−500, 500].
Water sits at y = −1.6.

| File | Contents |
|---|---|
| `city.glb` | Visual mesh, 92 meshes (one per material per map quadrant). EXT_meshopt_compression + KHR_mesh_quantization, WebP textures (EXT_texture_webp), KHR_texture_transform (UVs are normalised per material). COLOR_0 vertex colours multiply the base colour (GLTFLoader enables `vertexColors` automatically). No lights, cameras or sky. Needs `loader.setMeshoptDecoder(MeshoptDecoder)`. |
| `collision.glb` | One uncompressed indexed triangle mesh (positions only, no materials). It holds a simplified footprint prism per building at its damaged height, pitched roofs, flat ground with recessed water and quay walls, bridge decks, tall rubble heaps (inside 600 m), car hulks, scaffolds, the belfry mast and the outskirts terrain. |
| `landmarks.json` | `[{id, name, x, y, z, radius}]`, 14 entries. (x, z) is the centre and y is the top of the structure. |
| `spawns.json` | `[{x, y, z}]`, 12 open-air points 25–40 m up. Each is checked against the collision mesh at build time (≥ 12 m clearance). |
| `meta.json` | `name`, `bounds` (min/max of the visual mesh), `triangles`, `source`, `attribution`, plus `core`, `collisionTriangles`, `seed` and `waterLevel`. |

Budgets: city.glb ≤ 20 MB and ≤ 1.5 M triangles. collision.glb ≤ 150 k triangles. `build.sh` prints the actual numbers.

## Files

```
fetch_osm.py   Overpass fetch → data/osm_raw.json (cache, keep it)
geo.py         centre, extents, projection, seed (shared, no deps)
prep.py        shapely layout + damage decisions → data/prepared.json (derived)
textures.py    procedural tiling textures (numpy)
build.py       Blender entry point: meshing, export, JSON, previews
build.sh       the whole pipeline
previews/      aerial_oblique.png, drone_quays.png, street_level.png, cathedral.png
build/         intermediate city_raw.glb (derived)
```
