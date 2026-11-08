#!/usr/bin/env bash
# Port Ardent city pipeline: OSM fetch (cached) -> prep (shapely) -> Blender build -> gltf-transform.
#
#   tools/city/build.sh                 full build + preview renders
#   tools/city/build.sh --no-previews   skip the Cycles preview renders (~40 s faster)
#   tools/city/build.sh --refetch       re-download the OSM extract first
#
# Needs: uv, Blender 5.x (BLENDER env var or /opt/homebrew/bin/blender), Node 24 + npx.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BLENDER="${BLENDER:-/opt/homebrew/bin/blender}"
GLTF="npx -y @gltf-transform/cli@4.5.1"
OUT="$ROOT/apps/web/public/city"
RAW="$HERE/build/city_raw.glb"
TMP="$HERE/build/city_opt.glb"

BLENDER_ARGS=()
REFETCH=0
for a in "$@"; do
  case "$a" in
    --refetch) REFETCH=1 ;;
    *) BLENDER_ARGS+=("$a") ;;
  esac
done

cd "$ROOT"
mkdir -p "$OUT" "$HERE/build"

echo "== 1/4 OSM extract"
if [[ $REFETCH == 1 ]]; then
  uv run "$HERE/fetch_osm.py" --force
else
  uv run "$HERE/fetch_osm.py"
fi

echo "== 2/4 prep (layout + seeded damage pass)"
uv run "$HERE/prep.py"

echo "== 3/4 Blender build"
"$BLENDER" -b --factory-startup -P "$HERE/build.py" -- ${BLENDER_ARGS[@]+"${BLENDER_ARGS[@]}"} 2>&1 \
  | grep -E '^\[build|Error|Traceback|error' || true
[[ -f "$RAW" ]] || { echo "Blender build failed: $RAW missing" >&2; exit 1; }

echo "== 4/4 compress"
# Keep one mesh per material+quadrant (no join), no simplification; textures -> WebP.
$GLTF optimize "$RAW" "$TMP" \
  --compress false --join false --instance false --palette false --simplify false \
  --flatten true --weld true --texture-compress webp --texture-size 512
# Meshopt with 16-bit positions/UVs: the tiles span ~1.6 km and the UVs are in world metres,
# so the 14/12-bit defaults would visibly wobble.
$GLTF meshopt "$TMP" "$OUT/city.glb" \
  --level high --quantize-position 16 --quantize-texcoord 16 --quantize-normal 10 --quantize-color 8
rm -f "$TMP"

echo
echo "== stats"
node - "$OUT" <<'JS'
const fs = require("fs"), path = require("path");
const dir = process.argv[2];
for (const f of ["city.glb", "collision.glb"]) {
  const buf = fs.readFileSync(path.join(dir, f));
  const jsonLen = buf.readUInt32LE(12);
  const gltf = JSON.parse(buf.slice(20, 20 + jsonLen).toString());
  let tris = 0;
  for (const m of gltf.meshes) for (const p of m.primitives) {
    const acc = gltf.accessors[p.indices];
    tris += acc.count / 3;
  }
  console.log(`${f.padEnd(14)} ${(buf.length / 1e6).toFixed(2).padStart(6)} MB  meshes=${gltf.meshes.length}  triangles=${tris}  ext=${(gltf.extensionsUsed || []).join(",") || "-"}`);
}
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json")));
const lm = JSON.parse(fs.readFileSync(path.join(dir, "landmarks.json")));
const sp = JSON.parse(fs.readFileSync(path.join(dir, "spawns.json")));
console.log(`meta.json      triangles=${meta.triangles} bounds=${JSON.stringify(meta.bounds)}`);
console.log(`landmarks.json ${lm.length} landmarks; spawns.json ${sp.length} spawns`);
JS
