"""Shared constants for the Port Ardent city pipeline (no third-party deps).

Local frame (Blender, Z-up): +X east, +Y north, metres, origin at CENTER.
glTF (Y-up) is (x, z, -y) of that.
"""
import math

CENTER_LAT = 51.0543
CENTER_LON = 3.7225

CORE_HALF = 500.0      # playable core: x, y in [-500, 500]
BUILD_HALF = 850.0     # OSM buildings fetched/used out to here
FLAT_HALF = 1100.0     # OSM roads / water / landuse; flat ground out to here
TERRAIN_HALF = 1600.0  # procedural outskirts terrain out to here

SEED = 1945


def m_per_deg(lat_deg=CENTER_LAT):
    p = math.radians(lat_deg)
    lat = 111132.92 - 559.82 * math.cos(2 * p) + 1.175 * math.cos(4 * p)
    lon = 111412.84 * math.cos(p) - 93.5 * math.cos(3 * p) + 0.118 * math.cos(5 * p)
    return lat, lon


M_LAT, M_LON = m_per_deg()


def to_local(lat, lon):
    return ((lon - CENTER_LON) * M_LON, (lat - CENTER_LAT) * M_LAT)


def bbox(half_m):
    """(south, west, north, east) in degrees for a square of +-half_m metres."""
    dlat = half_m / M_LAT
    dlon = half_m / M_LON
    return (CENTER_LAT - dlat, CENTER_LON - dlon, CENTER_LAT + dlat, CENTER_LON + dlon)
