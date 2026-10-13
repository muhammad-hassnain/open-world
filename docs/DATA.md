# Data formats

All data comes from [OpenStreetMap](https://www.openstreetmap.org) through the Overpass API and
is © OpenStreetMap contributors under the
[Open Database License](https://www.openstreetmap.org/copyright).

`server.py` converts it into compact JSON. Coordinates are **meters** relative to
`WORLD.origin`, as `[x, z]` pairs: `+x` east, `+z` south. Short field names keep payloads
small; optional fields are omitted when OSM has no value. Inspect any dataset with:

```bash
curl -s --compressed localhost:8080/data/pois.json | python3 -m json.tool | head -50
```

## `meta.json`

```json
{
  "name": "Downtown Davis",
  "origin": { "lat": 38.544, "lon": -121.7442 },
  "metersPerDegLat": 111132.0,
  "metersPerDegLon": 87066.7,
  "core":    { "minX": -348.3, "maxX": 278.6, "minZ": -422.3, "maxZ": 444.5 },
  "context": { "minX": -766.2, "maxX": 714.0, "minZ": -833.5, "maxZ": 833.5 },
  "datasets": ["buildings", "roads", "pois", "areas", "trees", "props", "context_buildings", "context_roads"]
}
```

## Datasets

| Name | Area | Overpass source | Required |
| --- | --- | --- | --- |
| `buildings` | core | `way`/`relation` with `building` | yes |
| `roads` | core | `way` with `highway` | yes |
| `pois` | core | named `amenity`, `shop`, `tourism`, `leisure`, `office`, `craft`, `historic`, `healthcare`, stations; `place` neighborhoods | no |
| `areas` | core | parks, grass, pitches, playgrounds, water, woods, farmland, parking, plazas, waterways | no |
| `trees` | core | `natural=tree` nodes, `natural=tree_row` ways | no |
| `props` | core | benches, bike parking, street lamps, bins, hydrants, post boxes, drinking water, stop signs, traffic signals | no |
| `context_buildings` | context | same as `buildings` | no |
| `context_roads` | context | car and service roads only | no |

### `buildings` → `{ "buildings": [Building] }`

| Field | Meaning |
| --- | --- |
| `id` | OSM way/relation id |
| `o` | Outer ring `[[x, z], ...]` (not closed; orientation not guaranteed) |
| `i` | Inner rings (courtyards), optional |
| `t` | `building` tag value (`house`, `commercial`, `university`, `yes`, …) |
| `h` | Height in meters from `height`, optional |
| `l` | `building:levels`, optional |
| `n` | Name, optional |
| `a` | `amenity`, optional |

Multipolygon relations are assembled from their member ways; each outer ring becomes its own
entry with the inner rings that fall inside it.

### `roads` → `{ "roads": [Road], "junctions": [Junction] }`

| Field | Meaning |
| --- | --- |
| `id` | OSM way id |
| `t` | `highway` value (`residential`, `tertiary`, `footway`, `service`, …) |
| `p` | Polyline `[[x, z], ...]` |
| `n` | Name |
| `ln`, `w` | Lanes, width (m) |
| `ow` | `1` if one-way |
| `sw`, `swb`, `swl`, `swr` | `sidewalk`, `sidewalk:both`, `sidewalk:left`, `sidewalk:right` |
| `fw` | `footway` (`sidewalk`, `crossing`, …) |
| `cr`, `cm` | `crossing`, `crossing:markings` |
| `sv`, `su` | `service`, `surface` |
| `tu`, `br`, `ar` | `1` if tunnel, bridge, or `area=yes` |

A **junction** is an OSM node shared by two or more car/service roads:
`{ "x", "z", "r": [[roadIndex, vertexIndex], ...] }`, where `roadIndex` indexes `roads`.

### `pois` → `{ "pois": [Place] }`

| Field | Meaning |
| --- | --- |
| `id` | `n123`, `w123` or `r123` (node/way/relation) |
| `x`, `z` | Point (node position, or center of a way/relation) |
| `n` | Name |
| `c` | Category: `food`, `shop`, `money`, `health`, `education`, `worship`, `culture`, `civic`, `transport`, `lodging`, `leisure`, `office`, `service`, `place` |
| `k` | Human-readable kind, e.g. `Restaurant`, `Ice cream`, `Post office` |
| `ar` | `1` if it came from an area (way/relation) |
| `ad`, `oh`, `cu`, `w`, `ph`, `d` | Address, opening hours, cuisine, website, phone, description |

### `areas` → `{ "areas": [Area], "lines": [Waterway] }`

Area: `k` (kind: `grass`, `wood`, `pitch`, `track`, `playground`, `sand`, `farm`, `water`,
`parking`, `plaza`, `campus`), `o`, `i`, `n` (name), `le` (`leisure` value).
Waterway: `{ "k": "stream" | "river" | "canal" | "ditch" | "drain", "p": [[x, z], ...] }`.

### `trees` → `{ "trees": [[x, z, leaf, height]] }`

`leaf` is `0` unknown, `1` broadleaved, `2` needleleaved; `height` is meters or `0`.
Tree rows are sampled every 9 m.

### `props` → `{ "props": [{ "k", "x", "z", "dir"? }] }`

`k` is one of `bench`, `bikerack`, `lamp`, `bin`, `hydrant`, `postbox`, `fountain`, `stop`,
`signal`; `dir` is the OSM `direction` in degrees when tagged. The game currently draws benches,
bike racks, hydrants and bins from this list, and uses mapped lamps only if at least 10 exist
in the area (otherwise it generates lamps along streets).

## What the game adds that isn't in OSM

Generated, not mapped: sidewalks where none are mapped, street trees in planting strips, street
lamps, parked cars, building heights (when untagged), facade details, roofs and colors. Treat
these as decoration; the layout, names and footprints are real.
