#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# ///
"""Fetch the OSM extract for Port Ardent (central Ghent) from Overpass and cache it.

    uv run tools/city/fetch_osm.py [--force]

Writes tools/city/data/osm_raw.json. Skips the download if the cache exists.
Data (c) OpenStreetMap contributors, ODbL.
"""
import json
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import geo  # noqa: E402

OUT = Path(__file__).resolve().parent / "data" / "osm_raw.json"
ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
UA = "DeadAir-CityBuilder/0.1 (offline game asset build; one-off fetch)"


def bb(half):
    s, w, n, e = geo.bbox(half)
    return f"{s:.6f},{w:.6f},{n:.6f},{e:.6f}"


def query():
    b = bb(geo.BUILD_HALF + 50)
    f = bb(geo.FLAT_HALF + 150)
    return f"""
[out:json][timeout:240][maxsize:536870912];
(
  way["building"]({b});
  relation["building"]["type"="multipolygon"]({b});
  way["building:part"]({b});
  way["man_made"~"tower|bridge"]({b});
  way["highway"]({f});
  way["railway"~"rail|tram|light_rail"]({f});
  way["natural"="water"]({f});
  relation["natural"="water"]({f});
  way["waterway"~"river|canal|riverbank|dock"]({f});
  relation["waterway"="riverbank"]({f});
  way["leisure"~"park|garden|pitch|playground"]({f});
  way["landuse"~"grass|meadow|forest|cemetery|recreation_ground|railway|industrial|allotments|farmland"]({f});
  relation["landuse"]({f});
  relation["leisure"="park"]({f});
  way["natural"~"wood|scrub|grassland"]({f});
  way["place"="square"]({f});
  way["area:highway"]({f});
  way["highway"="pedestrian"]["area"="yes"]({f});
);
out body geom qt;
"""


def fetch():
    data = urllib.parse.urlencode({"data": query()}).encode()
    last = None
    for attempt in range(3):
        for url in ENDPOINTS:
            try:
                print(f"[fetch] POST {url} (attempt {attempt + 1})", flush=True)
                req = urllib.request.Request(
                    url, data=data, headers={"User-Agent": UA, "Accept": "application/json"}
                )
                with urllib.request.urlopen(req, timeout=300) as r:
                    body = r.read()
                js = json.loads(body)
                if not js.get("elements"):
                    raise RuntimeError(f"empty response: {js.get('remark')}")
                return js
            except Exception as e:  # try next endpoint
                last = e
                print(f"[fetch]   failed: {e}", flush=True)
        time.sleep(10 * (attempt + 1))
    raise SystemExit(f"Overpass fetch failed: {last}")


def main():
    if OUT.exists() and "--force" not in sys.argv:
        print(f"[fetch] cache present: {OUT} ({OUT.stat().st_size / 1e6:.1f} MB), skipping")
        return
    js = fetch()
    js["_meta"] = {
        "center": [geo.CENTER_LAT, geo.CENTER_LON],
        "build_half_m": geo.BUILD_HALF,
        "flat_half_m": geo.FLAT_HALF,
        "fetched": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "attribution": "(c) OpenStreetMap contributors, ODbL",
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(js, separators=(",", ":")))
    kinds = {}
    for el in js["elements"]:
        kinds[el["type"]] = kinds.get(el["type"], 0) + 1
    print(f"[fetch] wrote {OUT} ({OUT.stat().st_size / 1e6:.1f} MB) {kinds}")


if __name__ == "__main__":
    main()
