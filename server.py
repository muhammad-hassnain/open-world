#!/usr/bin/env python3
"""
Open-world dev server.

- Serves the game (index.html, js/, assets/) on 0.0.0.0 so tailnet devices can reach it.
- Downloads OpenStreetMap data for the world area once (Overpass API), converts it
  to compact local-meter JSON, and serves it from disk (gzipped) under /data/.
"""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import gzip
import hashlib
import json
import math
import mimetypes
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parent
RAW_DIR = ROOT / ".cache" / "overpass"
DATA_DIR = ROOT / ".cache" / "data"
RAW_DIR.mkdir(parents=True, exist_ok=True)
DATA_DIR.mkdir(parents=True, exist_ok=True)

HOST = "0.0.0.0"
PORT = int(os.environ.get("PORT", "8080"))

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

# Bump when processing output changes so stale processed files are regenerated.
PROCESS_VERSION = "3"

WORLD = {
    "name": "Downtown Davis",
    # B St / C St, 1st St to 5th St (center of the four corner intersections)
    "origin": {"lat": 38.5440, "lon": -121.7442},
    # Detailed, walkable area: A St to D St, 1st St to 5th St, plus a small margin.
    "core": {"south": 38.5400, "west": -121.7482, "north": 38.5478, "east": -121.7410},
    # Low-detail backdrop so the horizon isn't empty.
    "context": {"south": 38.5365, "west": -121.7530, "north": 38.5515, "east": -121.7360},
}

LAT0 = WORLD["origin"]["lat"]
LON0 = WORLD["origin"]["lon"]
M_PER_LAT = 111_132.0
M_PER_LON = 111_320.0 * math.cos(math.radians(LAT0))


def proj(lat, lon):
    return [round((lon - LON0) * M_PER_LON, 2), round(-(lat - LAT0) * M_PER_LAT, 2)]


def bbox_m(b):
    x0, z1 = proj(b["south"], b["west"])
    x1, z0 = proj(b["north"], b["east"])
    return {"minX": x0, "maxX": x1, "minZ": z0, "maxZ": z1}


def bbox_q(b):
    return f'{b["south"]},{b["west"]},{b["north"]},{b["east"]}'


# ---------------- Overpass ----------------

def fetch_overpass(query: str) -> dict:
    key = hashlib.sha256(query.encode()).hexdigest()
    cached = RAW_DIR / f"{key}.json"
    if cached.exists():
        return json.loads(cached.read_bytes())

    last_err = None
    for endpoint in OVERPASS_ENDPOINTS:
        try:
            t0 = time.time()
            print(f"[overpass] {endpoint}", flush=True)
            req = urllib.request.Request(
                endpoint,
                data=("data=" + urllib.parse.quote(query)).encode(),
                headers={"Content-Type": "application/x-www-form-urlencoded",
                         "User-Agent": "open-world-dev/0.3"},
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=180) as r:
                body = r.read()
            data = json.loads(body)
            cached.write_bytes(body)
            print(f"[overpass] ok in {time.time() - t0:.1f}s ({len(body) // 1024} KB)", flush=True)
            return data
        except Exception as e:  # network errors, timeouts, bad JSON
            last_err = e
            print(f"[overpass] {endpoint} failed: {e}", file=sys.stderr, flush=True)
    raise RuntimeError(f"all overpass endpoints failed: {last_err}")


# ---------------- Geometry helpers ----------------

def way_coords(geom):
    pts = [(p["lat"], p["lon"]) for p in geom]
    out = []
    for p in pts:
        if not out or out[-1] != p:
            out.append(p)
    return out


def assemble_rings(ways):
    """Join open way pieces (lists of (lat,lon)) into closed rings."""
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


def ring_m(ring):
    out = [proj(la, lo) for la, lo in ring]
    if len(out) > 1 and out[0] == out[-1]:
        out.pop()
    return out


def point_in_ring(x, z, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, zi = ring[i]
        xj, zj = ring[j]
        if (zi > z) != (zj > z) and x < (xj - xi) * (z - zi) / (zj - zi + 1e-12) + xi:
            inside = not inside
        j = i
    return inside


def element_polygons(el):
    """Return [(outer_ring_m, [inner_rings_m])] for a closed way or multipolygon relation."""
    if el["type"] == "way" and "geometry" in el:
        pts = way_coords(el["geometry"])
        if len(pts) >= 4 and pts[0] == pts[-1]:
            pts = pts[:-1]
        if len(pts) < 3:
            return []
        return [(ring_m(pts), [])]
    if el["type"] == "relation" and "members" in el:
        outers = assemble_rings([way_coords(m["geometry"]) for m in el["members"]
                                 if m.get("type") == "way" and m.get("role") == "outer" and "geometry" in m])
        inners = assemble_rings([way_coords(m["geometry"]) for m in el["members"]
                                 if m.get("type") == "way" and m.get("role") == "inner" and "geometry" in m])
        outers = [ring_m(r) for r in outers]
        inners = [ring_m(r) for r in inners]
        result = []
        for o in outers:
            mine = [i for i in inners if point_in_ring(i[0][0], i[0][1], o)]
            result.append((o, mine))
        return result
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


# ---------------- Processors ----------------

def process_buildings(data):
    out = []
    for el in data.get("elements", []):
        t = el.get("tags", {})
        btype = t.get("building", "yes")
        if btype == "no":
            continue
        for outer, inners in element_polygons(el):
            if len(outer) < 3:
                continue
            b = {"id": el["id"], "o": outer, "t": btype}
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
            out.append(b)
    return {"buildings": out}


def process_roads(data):
    roads = []
    node_use = {}
    car = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
           "living_street", "service", "motorway_link", "trunk_link", "primary_link",
           "secondary_link", "tertiary_link"}
    for el in data.get("elements", []):
        if el.get("type") != "way" or "geometry" not in el:
            continue
        t = el.get("tags", {})
        hw = t.get("highway")
        if not hw:
            continue
        pts = [proj(p["lat"], p["lon"]) for p in el["geometry"]]
        nodes = el.get("nodes", [])
        if len(pts) < 2:
            continue
        r = {"id": el["id"], "t": hw, "p": pts}
        for key, short in (("name", "n"), ("sidewalk", "sw"), ("sidewalk:both", "swb"),
                           ("sidewalk:left", "swl"), ("sidewalk:right", "swr"),
                           ("footway", "fw"), ("crossing", "cr"), ("crossing:markings", "cm"),
                           ("service", "sv"), ("surface", "su")):
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
        idx = len(roads)
        roads.append(r)
        if hw in car and "ar" not in r:
            for vi, nid in enumerate(nodes):
                node_use.setdefault(nid, []).append((idx, vi))

    junctions = []
    for nid, uses in node_use.items():
        if len({u[0] for u in uses}) < 2:
            continue
        ri, vi = uses[0]
        x, z = roads[ri]["p"][vi]
        junctions.append({"x": x, "z": z, "r": [[a, b] for a, b in uses]})
    return {"roads": roads, "junctions": junctions}


FOOD = {"restaurant", "fast_food", "cafe", "bar", "pub", "ice_cream", "food_court", "biergarten"}
SKIP_AMENITY = {"parking", "parking_entrance", "bicycle_parking", "university", "parking_space",
                "motorcycle_parking", "waste_basket", "bench", "vending_machine", "toilets",
                "drinking_water", "shelter", "fountain", "clock", "recycling", "post_box",
                "bicycle_repair_station", "atm", "charging_station", "telephone", "loading_dock"}


def categorize(t):
    a, s, tr, le = t.get("amenity"), t.get("shop"), t.get("tourism"), t.get("leisure")
    if t.get("place"):
        return "place", t["place"]
    if a in SKIP_AMENITY:
        return None
    if a in FOOD:
        return "food", a
    if a in ("bank", "bureau_de_change", "money_transfer"):
        return "money", a
    if a in ("pharmacy", "doctors", "dentist", "clinic", "hospital", "veterinary") or t.get("healthcare"):
        return "health", a or t.get("healthcare")
    if a in ("library", "school", "university", "college", "kindergarten", "childcare",
             "music_school", "language_school", "driving_school", "prep_school"):
        return "education", a
    if a == "place_of_worship":
        return "worship", a
    if a in ("cinema", "theatre", "arts_centre", "nightclub", "community_centre", "events_venue",
             "social_centre", "studio"):
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


def process_pois(data):
    out = []
    for el in data.get("elements", []):
        t = el.get("tags", {})
        name = t.get("name")
        if not name:
            continue
        cat = categorize(t)
        if not cat:
            continue
        if el["type"] == "node":
            lat, lon = el["lat"], el["lon"]
        elif "center" in el:
            lat, lon = el["center"]["lat"], el["center"]["lon"]
        else:
            continue
        x, z = proj(lat, lon)
        p = {"id": f'{el["type"][0]}{el["id"]}', "x": x, "z": z, "n": name, "c": cat[0],
             "k": humanize(cat[1]) if cat[1] != "yes" else humanize(cat[0])}
        if el["type"] != "node":
            p["ar"] = 1
        addr = " ".join(v for v in (t.get("addr:housenumber"), t.get("addr:street")) if v)
        if addr:
            p["ad"] = addr
        for key, short in (("opening_hours", "oh"), ("cuisine", "cu"), ("website", "w"),
                           ("phone", "ph"), ("description", "d")):
            if t.get(key):
                p[short] = t[key].replace(";", ", ").replace("_", " ") if short == "cu" else t[key]
        out.append(p)
    return {"pois": out}


def area_kind(t):
    lu, le, na, am = t.get("landuse"), t.get("leisure"), t.get("natural"), t.get("amenity")
    if am == "parking":
        return None if t.get("parking") in ("underground", "multi-storey", "rooftop") else "parking"
    if am == "university":
        return "campus"
    if t.get("highway") == "pedestrian" or t.get("place") == "square":
        return "plaza"
    if na == "water" or t.get("waterway") == "riverbank" or lu in ("basin", "reservoir"):
        return "water"
    if le == "pitch":
        return "pitch"
    if le == "track":
        return "track"
    if le == "playground":
        return "playground"
    if le in ("park", "garden", "dog_park", "golf_course", "nature_reserve", "stadium") \
            or lu in ("grass", "recreation_ground", "village_green", "meadow", "cemetery") \
            or na == "grassland":
        return "grass"
    if lu == "forest" or na in ("wood", "scrub"):
        return "wood"
    if lu in ("farmland", "orchard", "vineyard", "allotments"):
        return "farm"
    if na == "sand" or le == "beach":
        return "sand"
    return None


def process_areas(data):
    areas, lines = [], []
    for el in data.get("elements", []):
        t = el.get("tags", {})
        ww = t.get("waterway")
        if ww in ("stream", "river", "canal", "ditch", "drain") and el["type"] == "way" and "geometry" in el:
            lines.append({"k": ww, "p": [proj(p["lat"], p["lon"]) for p in el["geometry"]]})
            continue
        kind = area_kind(t)
        if not kind:
            continue
        for outer, inners in element_polygons(el):
            a = {"k": kind, "o": outer}
            if inners:
                a["i"] = inners
            if t.get("name"):
                a["n"] = t["name"]
            if t.get("leisure"):
                a["le"] = t["leisure"]
            areas.append(a)
    return {"areas": areas, "lines": lines}


def process_trees(data):
    out = []
    for el in data.get("elements", []):
        t = el.get("tags", {})
        leaf = 2 if t.get("leaf_type") == "needleleaved" else 1 if t.get("leaf_type") == "broadleaved" else 0
        h = parse_length(t.get("height")) or 0
        if el["type"] == "node":
            x, z = proj(el["lat"], el["lon"])
            out.append([x, z, leaf, round(h, 1)])
        elif el["type"] == "way" and "geometry" in el:  # tree_row: sample every ~9 m
            pts = [proj(p["lat"], p["lon"]) for p in el["geometry"]]
            carry = 0.0
            for (ax, az), (bx, bz) in zip(pts, pts[1:]):
                seg = math.hypot(bx - ax, bz - az)
                d = carry
                while d < seg:
                    f = d / seg
                    out.append([round(ax + (bx - ax) * f, 2), round(az + (bz - az) * f, 2), leaf, 0])
                    d += 9.0
                carry = d - seg
    return {"trees": out}


PROP_KINDS = {
    ("amenity", "bench"): "bench",
    ("amenity", "bicycle_parking"): "bikerack",
    ("highway", "street_lamp"): "lamp",
    ("amenity", "waste_basket"): "bin",
    ("emergency", "fire_hydrant"): "hydrant",
    ("amenity", "post_box"): "postbox",
    ("amenity", "drinking_water"): "fountain",
    ("highway", "stop"): "stop",
    ("highway", "traffic_signals"): "signal",
}


def process_props(data):
    out = []
    for el in data.get("elements", []):
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
    return {"props": out}


def q_buildings(b):
    return f'[out:json][timeout:180];(way["building"]({bbox_q(b)});relation["building"]({bbox_q(b)}););out geom;'


CAR_RE = "^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"

DATASETS = {
    "buildings": (q_buildings(WORLD["core"]), process_buildings),
    "roads": (f'[out:json][timeout:180];way["highway"]({bbox_q(WORLD["core"])});out geom;', process_roads),
    "pois": (
        "[out:json][timeout:180];(" + "".join(
            f'nwr["name"]["{k}"]({bbox_q(WORLD["core"])});'
            for k in ("amenity", "shop", "tourism", "leisure", "office", "craft", "historic", "healthcare")
        ) + f'nwr["name"]["railway"="station"]({bbox_q(WORLD["core"])});'
            f'node["place"~"^(neighbourhood|suburb|quarter)$"]({bbox_q(WORLD["core"])});'
            ");out center tags;",
        process_pois),
    "areas": (
        "[out:json][timeout:180];(" + "".join(
            f'{f}({bbox_q(WORLD["core"])});' for f in (
                'way["landuse"~"^(grass|recreation_ground|village_green|meadow|cemetery|forest|farmland|orchard|vineyard|allotments|basin|reservoir)$"]',
                'way["leisure"~"^(park|garden|pitch|playground|track|dog_park|golf_course|nature_reserve|stadium)$"]',
                'way["natural"~"^(water|wood|scrub|grassland|sand)$"]',
                'way["amenity"="parking"]',
                'way["place"="square"]',
                'way["waterway"~"^(riverbank|stream|river|canal|ditch|drain)$"]',
                'way["highway"="pedestrian"]["area"="yes"]',
                'relation["type"="multipolygon"]["leisure"~"^(park|garden|pitch|playground)$"]',
                'relation["type"="multipolygon"]["landuse"~"^(grass|recreation_ground|forest)$"]',
                'relation["type"="multipolygon"]["amenity"="parking"]',
            )
        ) + ");out geom;",
        process_areas),
    "trees": (f'[out:json][timeout:180];(node["natural"="tree"]({bbox_q(WORLD["core"])});'
              f'way["natural"="tree_row"]({bbox_q(WORLD["core"])}););out geom;', process_trees),
    "props": ("[out:json][timeout:180];(" + "".join(
        f'node["{k}"="{v}"]({bbox_q(WORLD["core"])});' for (k, v) in PROP_KINDS
    ) + ");out;", process_props),
    "context_buildings": (q_buildings(WORLD["context"]), process_buildings),
    "context_roads": (f'[out:json][timeout:180];way["highway"~"{CAR_RE}"]({bbox_q(WORLD["context"])});out geom;',
                      process_roads),
}

# ---------------- Processed data store ----------------

_lock = threading.Lock()
_payload: dict[str, bytes] = {}
_payload_gz: dict[str, bytes] = {}
_status: dict[str, str] = {name: "pending" for name in DATASETS}


def _processed_path(name):
    query = DATASETS[name][0]
    key = hashlib.sha256((query + PROCESS_VERSION).encode()).hexdigest()[:12]
    return DATA_DIR / f"{name}-{key}.json"


def _store(name, payload: bytes):
    gz = gzip.compress(payload, compresslevel=6)
    with _lock:
        _payload[name] = payload
        _payload_gz[name] = gz
        _status[name] = "ready"


def _prepare(name):
    path = _processed_path(name)
    if path.exists():
        _store(name, path.read_bytes())
        return
    query, processor = DATASETS[name]
    for attempt, backoff in enumerate((0, 15, 45, 90)):
        time.sleep(backoff)
        try:
            _status[name] = "downloading" if attempt == 0 else f"retrying ({attempt})"
            raw = fetch_overpass(query)
            payload = json.dumps(processor(raw), separators=(",", ":")).encode()
            path.write_bytes(payload)
            _store(name, payload)
            print(f"[data] {name}: {len(payload) // 1024} KB", flush=True)
            return
        except Exception as e:
            print(f"[data] {name} attempt {attempt + 1} failed: {e}", file=sys.stderr, flush=True)
            last = e
    _status[name] = f"error: {last}"


def start_prefetch():
    # Sequential: the public Overpass server limits concurrent requests per IP.
    def run():
        for name in DATASETS:
            _prepare(name)
    threading.Thread(target=run, daemon=True).start()


def wait_for(name, timeout=300.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        with _lock:
            if name in _payload:
                return True
        if _status.get(name, "").startswith("error"):
            return False
        time.sleep(0.2)
    return False


META = json.dumps({
    "name": WORLD["name"],
    "origin": WORLD["origin"],
    "metersPerDegLat": M_PER_LAT,
    "metersPerDegLon": M_PER_LON,
    "core": bbox_m(WORLD["core"]),
    "context": bbox_m(WORLD["context"]),
    "datasets": list(DATASETS),
}).encode()

# ---------------- HTTP ----------------

mimetypes.add_type("text/javascript", ".js")
STATIC_DIRS = ("js", "assets")


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write(f"[{self.address_string()}] {fmt % args}\n")

    def _gzip_ok(self):
        return "gzip" in (self.headers.get("Accept-Encoding") or "").lower()

    def _send(self, status, body, ctype, gz=False):
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        if gz:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _send_maybe_gz(self, body, ctype):
        if self._gzip_ok() and len(body) > 1024:
            self._send(200, gzip.compress(body, compresslevel=6), ctype, gz=True)
        else:
            self._send(200, body, ctype)

    def do_GET(self):
        path = urllib.parse.unquote(self.path.split("?", 1)[0])

        if path == "/data/meta.json":
            self._send_maybe_gz(META, "application/json")
            return
        if path == "/data/status":
            self._send(200, json.dumps(_status).encode(), "application/json")
            return
        m = re.match(r"^/data/([a-z_]+)\.json$", path)
        if m and m.group(1) in DATASETS:
            name = m.group(1)
            if not wait_for(name):
                self._send(503, json.dumps({"error": _status.get(name)}).encode(), "application/json")
                return
            if self._gzip_ok():
                self._send(200, _payload_gz[name], "application/json", gz=True)
            else:
                self._send(200, _payload[name], "application/json")
            return

        if path == "/":
            path = "/index.html"
        rel = path.lstrip("/")
        allowed = rel == "index.html" or rel.split("/", 1)[0] in STATIC_DIRS
        target = (ROOT / rel).resolve()
        if not allowed or ROOT not in target.parents or not target.is_file():
            self._send(404, b"not found", "text/plain")
            return
        ctype = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        body = target.read_bytes()
        if ctype.startswith("text/") or ctype == "application/json":
            self._send_maybe_gz(body, ctype)
        else:
            self._send(200, body, ctype)


def main():
    start_prefetch()
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"open-world server on http://{HOST}:{PORT}", flush=True)
    try:
        import subprocess
        ip = subprocess.check_output(["tailscale", "ip", "-4"], text=True).split()[0]
        print(f"  tailnet: http://{ip}:{PORT}", flush=True)
    except Exception:
        pass
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.server_close()


if __name__ == "__main__":
    main()
