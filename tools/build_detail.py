#!/usr/bin/env python3
"""
Build detailed OpenStreetMap data for selected map tiles.

Everywhere in the world the game uses OpenFreeMap vector tiles. For tiles listed
here it uses richer data straight from OpenStreetMap (mapped sidewalks, crosswalks,
trees, benches, opening hours, building types), downloaded once from the Overpass
API and written as static JSON:

    data/detail/<z>/<x>/<y>.json   one file per tile
    data/detail/index.json         list of available tiles

Usage:  python3 tools/build_detail.py            # build missing tiles
        python3 tools/build_detail.py --force    # rebuild all
Only the Python standard library is used. Raw Overpass responses are cached in
.cache/overpass/ so re-processing doesn't re-download.
"""
import argparse
import hashlib
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / ".cache" / "overpass"
OUT_DIR = ROOT / "data" / "detail"

# Bump when the output format or processing changes.
PROCESS_VERSION = 4
EXTENT = 4096
ZOOM = 14

# Tiles that get detailed data: (zoom, x, y). 14/2651/6288 covers downtown Davis, CA.
DETAIL_TILES = [
    (14, 2651, 6288),
]

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# ---------------- projection ----------------


def tile_bounds(z, x, y):
    n = 2 ** z
    lon = lambda tx: tx / n * 360 - 180
    lat = lambda ty: math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * ty / n))))
    return {"south": lat(y + 1), "north": lat(y), "west": lon(x), "east": lon(x + 1)}


def tile_projector(z, x, y):
    n = 2 ** z

    def proj(lat, lon):
        lat = max(-85.05112878, min(85.05112878, lat))
        mx = (lon + 180) / 360
        s = math.sin(math.radians(lat))
        my = 0.5 - math.log((1 + s) / (1 - s)) / (4 * math.pi)
        return [round((mx * n - x) * EXTENT, 2), round((my * n - y) * EXTENT, 2)]

    return proj


# ---------------- Overpass ----------------


def fetch_overpass(query):
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    cached = RAW_DIR / f"{hashlib.sha256(query.encode()).hexdigest()}.json"
    if cached.exists():
        return json.loads(cached.read_bytes())
    last = None
    for attempt, backoff in enumerate((0, 20, 60)):
        time.sleep(backoff)
        for endpoint in OVERPASS_ENDPOINTS:
            try:
                t0 = time.time()
                print(f"  overpass {endpoint} (attempt {attempt + 1})", flush=True)
                req = urllib.request.Request(
                    endpoint, data=("data=" + urllib.parse.quote(query)).encode(),
                    headers={"Content-Type": "application/x-www-form-urlencoded", "User-Agent": "open-world-build/0.4"},
                    method="POST")
                with urllib.request.urlopen(req, timeout=300) as r:
                    body = r.read()
                data = json.loads(body)
                cached.write_bytes(body)
                print(f"  ok in {time.time() - t0:.0f}s ({len(body) // 1024} KB)", flush=True)
                return data
            except Exception as e:  # network errors, timeouts, bad JSON
                last = e
                print(f"  failed: {e}", file=sys.stderr, flush=True)
    raise RuntimeError(f"all Overpass endpoints failed: {last}")


def detail_query(b):
    bb = f'{b["south"]},{b["west"]},{b["north"]},{b["east"]}'
    parts = [
        'way["building"]', 'relation["building"]', 'way["highway"]',
        *[f'nwr["name"]["{k}"]' for k in ("amenity", "shop", "tourism", "leisure", "office", "craft", "historic", "healthcare")],
        'nwr["name"]["railway"="station"]',
        'node["place"~"^(neighbourhood|suburb|quarter|city|town|village|hamlet)$"]',
        'way["landuse"~"^(grass|recreation_ground|village_green|meadow|cemetery|forest|farmland|orchard|vineyard|allotments|basin|reservoir)$"]',
        'way["leisure"~"^(park|garden|pitch|playground|track|dog_park|golf_course|nature_reserve|stadium)$"]',
        'way["natural"~"^(water|wood|scrub|grassland|sand)$"]',
        'way["amenity"="parking"]', 'way["place"="square"]',
        'way["waterway"~"^(riverbank|stream|river|canal|ditch|drain)$"]',
        'relation["type"="multipolygon"]["leisure"~"^(park|garden|pitch|playground)$"]',
        'relation["type"="multipolygon"]["landuse"~"^(grass|recreation_ground|forest)$"]',
        'relation["type"="multipolygon"]["amenity"="parking"]',
        'node["natural"="tree"]', 'way["natural"="tree_row"]',
        'node["amenity"~"^(bench|bicycle_parking|waste_basket|post_box|drinking_water)$"]',
        'node["highway"~"^(street_lamp|stop|traffic_signals)$"]', 'node["emergency"="fire_hydrant"]',
    ]
    return "[out:json][timeout:300];(" + "".join(f"{p}({bb});" for p in parts) + ");out geom;"


# ---------------- helpers ----------------


def way_coords(geom):
    out = []
    for p in geom:
        q = (p["lat"], p["lon"])
        if not out or out[-1] != q:
            out.append(q)
    return out


def assemble_rings(ways):
    segs = [list(w) for w in ways if len(w) >= 2]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur = cur + s[1:]
                elif s[-1] == cur[-1]:
                    cur = cur + s[::-1][1:]
                elif s[-1] == cur[0]:
                    cur = s[:-1] + cur
                elif s[0] == cur[0]:
                    cur = s[::-1][:-1] + cur
                else:
                    continue
                segs.pop(i)
                changed = True
                break
        if cur[0] == cur[-1] and len(cur) >= 4:
            rings.append(cur[:-1])
    return rings


def point_in_ring(x, z, ring):
    inside, j = False, len(ring) - 1
    for i in range(len(ring)):
        xi, zi = ring[i]
        xj, zj = ring[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def element_polygons(el, proj):
    def ring_m(ring):
        out = [proj(la, lo) for la, lo in ring]
        if len(out) > 1 and out[0] == out[-1]:
            out.pop()
        return out

    if el["type"] == "way" and "geometry" in el:
        pts = way_coords(el["geometry"])
        if len(pts) >= 4 and pts[0] == pts[-1]:
            pts = pts[:-1]
        return [(ring_m(pts), [])] if len(pts) >= 3 else []
    if el["type"] == "relation" and "members" in el:
        def rings(role):
            return [ring_m(r) for r in assemble_rings(
                [way_coords(m["geometry"]) for m in el["members"]
                 if m.get("type") == "way" and m.get("role") == role and "geometry" in m])]
        outers, inners = rings("outer"), rings("inner")
        return [(o, [i for i in inners if point_in_ring(i[0][0], i[0][1], o)]) for o in outers]
    return []


def parse_length(s):
    if not s:
        return None
    s = s.strip().lower().replace(",", ".")
    m = re.match(r"^([\d.]+)\s*(m|meter|meters|metre|metres)?$", s)
    if m:
        return float(m.group(1))
    m = re.match(r"^([\d.]+)\s*(ft|feet|')$", s)
    if m:
        return float(m.group(1)) * 0.3048
    m = re.match(r"^(\d+)'\s*(\d+)\"?$", s)
    if m:
        return int(m.group(1)) * 0.3048 + int(m.group(2)) * 0.0254
    return None


def parse_num(s):
    try:
        return float(str(s).split(";")[0])
    except (TypeError, ValueError):
        return None


def humanize(s):
    return (s or "").replace("_", " ").strip().capitalize()


def center_of(el):
    if el["type"] == "node":
        return el["lat"], el["lon"]
    b = el.get("bounds")
    if b:
        return (b["minlat"] + b["maxlat"]) / 2, (b["minlon"] + b["maxlon"]) / 2
    return None


# ---------------- processors (output in tile units) ----------------


def buildings(elements, proj):
    out = []
    for el in elements:
        t = el.get("tags", {})
        if "building" not in t or t["building"] == "no" or el["type"] == "node":
            continue
        for outer, inners in element_polygons(el, proj):
            if len(outer) < 3:
                continue
            b = {"id": el["id"], "o": outer, "t": t["building"]}
            if inners:
                b["i"] = inners
            h = parse_length(t.get("height"))
            if h:
                b["h"] = round(h, 1)
            lv = parse_num(t.get("building:levels"))
            if lv:
                b["l"] = lv
            if t.get("name"):
                b["n"] = t["name"]
            if t.get("amenity"):
                b["a"] = t["amenity"]
            col = t.get("building:colour")
            if col and re.match(r"^#[0-9a-fA-F]{6}$", col):
                b["c"] = col.lower()
            out.append(b)
    return out


def roads(elements, proj):
    out = []
    for el in elements:
        t = el.get("tags", {})
        if el["type"] != "way" or "geometry" not in el or not t.get("highway"):
            continue
        pts = [proj(p["lat"], p["lon"]) for p in el["geometry"]]
        if len(pts) < 2:
            continue
        r = {"id": el["id"], "t": t["highway"], "p": pts}
        for key, short in (("name", "n"), ("sidewalk", "sw"), ("sidewalk:both", "swb"), ("sidewalk:left", "swl"),
                           ("sidewalk:right", "swr"), ("footway", "fw"), ("crossing", "cr"),
                           ("crossing:markings", "cm"), ("service", "sv"), ("surface", "su")):
            if t.get(key):
                r[short] = t[key]
        ln = parse_num(t.get("lanes"))
        if ln:
            r["ln"] = ln
        w = parse_length(t.get("width"))
        if w:
            r["w"] = w
        if t.get("oneway") in ("yes", "1", "true"):
            r["ow"] = 1
        if t.get("tunnel") not in (None, "no"):
            r["tu"] = 1
        if t.get("bridge") not in (None, "no"):
            r["br"] = 1
        if t.get("area") == "yes":
            r["ar"] = 1
        out.append(r)
    return out


FOOD = {"restaurant", "fast_food", "cafe", "bar", "pub", "ice_cream", "food_court", "biergarten"}
SKIP_AMENITY = {"parking", "parking_entrance", "bicycle_parking", "university", "parking_space",
                "motorcycle_parking", "waste_basket", "bench", "vending_machine", "toilets",
                "drinking_water", "shelter", "fountain", "clock", "recycling", "post_box",
                "bicycle_repair_station", "atm", "charging_station", "telephone", "loading_dock"}


def categorize(t):
    a, s, tr, le = t.get("amenity"), t.get("shop"), t.get("tourism"), t.get("leisure")
    if a in SKIP_AMENITY:
        return None
    if a in FOOD:
        return "food", a
    if a in ("bank", "bureau_de_change", "money_transfer"):
        return "money", a
    if a in ("pharmacy", "doctors", "dentist", "clinic", "hospital", "veterinary") or t.get("healthcare"):
        return "health", a or t.get("healthcare")
    if a in ("library", "school", "university", "college", "kindergarten", "childcare", "music_school",
             "language_school", "driving_school", "prep_school"):
        return "education", a
    if a == "place_of_worship":
        return "worship", a
    if a in ("cinema", "theatre", "arts_centre", "nightclub", "community_centre", "events_venue", "social_centre", "studio"):
        return "culture", a
    if a in ("townhall", "police", "fire_station", "post_office", "courthouse"):
        return "civic", a
    if a in ("fuel", "car_wash", "car_rental", "bicycle_rental", "bus_station", "taxi"):
        return "transport", a
    if s:
        return "shop", s
    if tr in ("hotel", "motel", "hostel", "guest_house"):
        return "lodging", tr
    if tr in ("museum", "gallery", "attraction", "artwork", "viewpoint", "information"):
        return "culture", tr
    if le:
        return "leisure", le
    if t.get("office"):
        return "office", t["office"]
    if t.get("craft"):
        return "shop", t["craft"]
    if t.get("historic"):
        return "culture", t["historic"]
    if t.get("railway") == "station":
        return "transport", "station"
    if a:
        return "service", a
    if tr:
        return "culture", tr
    return None


def pois(elements, proj):
    out, places = [], []
    for el in elements:
        t = el.get("tags", {})
        name = t.get("name")
        if not name:
            continue
        c = center_of(el)
        if not c:
            continue
        x, z = proj(*c)
        if t.get("place") and el["type"] == "node":
            places.append({"x": x, "z": z, "n": name, "k": t["place"]})
            continue
        cat = categorize(t)
        if not cat:
            continue
        p = {"id": f'{el["type"][0]}{el["id"]}', "x": x, "z": z, "n": name, "c": cat[0],
             "k": humanize(cat[1]) if cat[1] != "yes" else humanize(cat[0])}
        if el["type"] != "node":
            p["ar"] = 1
        addr = " ".join(v for v in (t.get("addr:housenumber"), t.get("addr:street")) if v)
        if addr:
            p["ad"] = addr
        for key, short in (("opening_hours", "oh"), ("cuisine", "cu"), ("website", "w"), ("phone", "ph")):
            if t.get(key):
                p[short] = t[key].replace(";", ", ").replace("_", " ") if short == "cu" else t[key]
        out.append(p)
    return out, places


def area_kind(t):
    lu, le, na, am = t.get("landuse"), t.get("leisure"), t.get("natural"), t.get("amenity")
    if t.get("highway") or t.get("building"):
        return None
    if am == "parking":
        return None if t.get("parking") in ("underground", "multi-storey", "rooftop") else "parking"
    if t.get("place") == "square":
        return "plaza"
    if na == "water" or t.get("waterway") == "riverbank" or lu in ("basin", "reservoir"):
        return "water"
    if le in ("pitch", "track", "playground"):
        return le
    if le in ("park", "garden", "dog_park", "golf_course", "nature_reserve", "stadium") \
            or lu in ("grass", "recreation_ground", "village_green", "meadow", "cemetery") or na == "grassland":
        return "grass"
    if lu == "forest" or na in ("wood", "scrub"):
        return "wood"
    if lu in ("farmland", "orchard", "vineyard", "allotments"):
        return "farm"
    if na == "sand":
        return "sand"
    return None


def areas(elements, proj):
    out, lines = [], []
    for el in elements:
        t = el.get("tags", {})
        ww = t.get("waterway")
        if ww in ("stream", "river", "canal", "ditch", "drain") and el["type"] == "way" and "geometry" in el:
            lines.append({"k": ww, "p": [proj(p["lat"], p["lon"]) for p in el["geometry"]]})
            continue
        kind = area_kind(t)
        if not kind:
            continue
        for outer, inners in element_polygons(el, proj):
            a = {"k": kind, "o": outer}
            if inners:
                a["i"] = inners
            if t.get("name"):
                a["n"] = t["name"]
            if t.get("leisure"):
                a["le"] = t["leisure"]
            out.append(a)
    return out, lines


def trees(elements, proj):
    out = []
    for el in elements:
        t = el.get("tags", {})
        if t.get("natural") not in ("tree", "tree_row"):
            continue
        leaf = 2 if t.get("leaf_type") == "needleleaved" else 1 if t.get("leaf_type") == "broadleaved" else 0
        h = parse_length(t.get("height")) or 0
        if el["type"] == "node":
            out.append([*proj(el["lat"], el["lon"]), leaf, round(h, 1)])
        elif el["type"] == "way" and "geometry" in el:
            pts = [(p["lat"], p["lon"]) for p in el["geometry"]]
            for (a_lat, a_lon), (b_lat, b_lon) in zip(pts, pts[1:]):
                steps = max(1, int(math.hypot(b_lat - a_lat, (b_lon - a_lon) * math.cos(math.radians(a_lat))) * 111_000 / 9))
                for k in range(steps):
                    f = k / steps
                    out.append([*proj(a_lat + (b_lat - a_lat) * f, a_lon + (b_lon - a_lon) * f), leaf, 0])
    return out


PROP_KINDS = {
    ("amenity", "bench"): "bench", ("amenity", "bicycle_parking"): "bikerack", ("highway", "street_lamp"): "lamp",
    ("amenity", "waste_basket"): "bin", ("emergency", "fire_hydrant"): "hydrant", ("amenity", "post_box"): "postbox",
    ("amenity", "drinking_water"): "fountain", ("highway", "stop"): "stop", ("highway", "traffic_signals"): "signal",
}


def props(elements, proj):
    out = []
    for el in elements:
        if el["type"] != "node":
            continue
        t = el.get("tags", {})
        for (k, v), kind in PROP_KINDS.items():
            if t.get(k) == v:
                x, z = proj(el["lat"], el["lon"])
                p = {"k": kind, "x": x, "z": z}
                d = parse_num(t.get("direction"))
                if d is not None:
                    p["dir"] = d
                out.append(p)
                break
    return out


def build_tile(z, x, y, force=False):
    path = OUT_DIR / str(z) / str(x) / f"{y}.json"
    if path.exists() and not force:
        existing = json.loads(path.read_text())
        if existing.get("version") == PROCESS_VERSION:
            print(f"{z}/{x}/{y}: up to date")
            return
    print(f"{z}/{x}/{y}: downloading")
    elements = fetch_overpass(detail_query(tile_bounds(z, x, y))).get("elements", [])
    proj = tile_projector(z, x, y)
    poi_list, places = pois(elements, proj)
    area_list, lines = areas(elements, proj)
    data = {
        "version": PROCESS_VERSION, "extent": EXTENT,
        "source": "OpenStreetMap contributors (ODbL), via Overpass API",
        "buildings": buildings(elements, proj), "roads": roads(elements, proj), "pois": poi_list,
        "places": places, "areas": area_list, "lines": lines, "trees": trees(elements, proj),
        "props": props(elements, proj),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, separators=(",", ":")))
    counts = ", ".join(f"{k} {len(v)}" for k, v in data.items() if isinstance(v, list))
    print(f"{z}/{x}/{y}: wrote {path.relative_to(ROOT)} ({path.stat().st_size // 1024} KB; {counts})")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="rebuild tiles even if up to date")
    opts = ap.parse_args()
    for z, x, y in DETAIL_TILES:
        build_tile(z, x, y, opts.force)
    index = OUT_DIR / "index.json"
    index.write_text(json.dumps({"tiles": [f"{z}/{x}/{y}" for z, x, y in DETAIL_TILES]}, indent=1) + "\n")
    print(f"wrote {index.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
