# Data formats

All map data comes from [OpenStreetMap](https://www.openstreetmap.org) and is
© OpenStreetMap contributors under the [Open Database License](https://www.openstreetmap.org/copyright).

## Sources

| Source | Covers | Delivered as | Has |
| --- | --- | --- | --- |
| [OpenFreeMap](https://openfreemap.org) vector tiles, [OpenMapTiles](https://openmaptiles.org/schema/) schema | The whole planet, updated weekly | z14 `.pbf` tiles fetched by the browser | Building footprints with heights/colours, roads by class with names, landcover/landuse, water, named places, neighborhoods |
| Detail tiles from `tools/build_detail.py` (Overpass API) | Tiles listed in `DETAIL_TILES` (downtown Davis today) | `data/detail/14/<x>/<y>.json` + `data/detail/index.json` | Everything above plus building types, mapped sidewalks/crossings, lanes/width tags, trees, benches, lamps, hydrants, addresses, opening hours, cuisine, websites |

Both are converted to the **common format** below, with coordinates in tile units
(`0..extent`, y pointing south) and then to meters by `toLocal()` in `js/tiledata.js`.

## Common tile format

```json
{
  "extent": 4096,
  "buildings": [Building], "roads": [Road], "pois": [Place], "places": [Locality],
  "areas": [Area], "zones": [Zone], "lines": [Waterway], "trees": [[x, z, leaf, height]], "props": [Prop]
}
```

Detail files also carry `"version"` (`PROCESS_VERSION` of the build tool) and `"source"`.

### Building

| Field | Meaning |
| --- | --- |
| `id` | OSM id (detail) or a stable id derived from the geometry (vector) |
| `o` | Outer ring `[[x, z], ...]` (not closed) |
| `i` | Inner rings (courtyards), optional |
| `t` | OSM `building` value (`house`, `commercial`, …); always `yes` from vector tiles |
| `h` | Height in meters, optional |
| `l` | Floors, optional (vector tiles: derived from `render_height` / 3.66) |
| `mh` | Minimum height (building parts lifted off the ground), optional |
| `c` | Colour: hex or CSS name, optional |
| `n`, `a` | Name and `amenity`, optional (detail only) |
| `rc` | Roof color `[r, g, b]` (sRGB 0–255) measured from aerial imagery; added in the browser for US tiles, not stored in files |

### Road

| Field | Meaning |
| --- | --- |
| `id` | OSM way id (detail) or derived id (vector) |
| `t` | Highway type: `motorway`, `primary`, …, `residential` (vector `minor`), `service`, `footway`, `cycleway`, `path`, `pedestrian`, `steps`, `track`, `*_link` |
| `p` | Polyline `[[x, z], ...]` |
| `n` | Name (vector: matched from the `transportation_name` layer) |
| `ow` | `1` if one-way (vector `oneway: -1` is reversed to `1`) |
| `sv` | `service` value (`driveway`, `parking_aisle`, `alley`, …) |
| `tu`, `br`, `ar` | `1` if tunnel, bridge, or `area=yes` |
| `fw` | `footway` (`sidewalk`, `crossing`); for vector tiles set by geometry in `classifyFootways` |
| `w`, `ln` | Width (m) and lanes; `w` is also set by `fitRoadWidths` for narrow streets |
| `sw`, `swb`, `swl`, `swr`, `cr`, `cm`, `su` | Sidewalk, crossing and surface tags (detail only) |

### Place (`pois`)

| Field | Meaning |
| --- | --- |
| `id` | `n123`/`w123`/`r123` (detail) or `v<hash>` (vector) |
| `x`, `z` | Point |
| `n` | Name (in the local language, any script) |
| `c` | Category: `food`, `shop`, `money`, `health`, `education`, `worship`, `culture`, `civic`, `transport`, `lodging`, `leisure`, `office`, `service` |
| `k` | Human-readable kind, e.g. `Restaurant`, `Clothes`, `Post office` |
| `ad`, `oh`, `cu`, `w`, `ph` | Address, opening hours, cuisine, website, phone (detail only) |

### Others

- **Locality** (`places`): `{ x, z, n, k }` with `k` one of `neighbourhood`, `suburb`, `quarter`,
  `city`, `town`, `village`, `hamlet`. Used for the "where am I" bar.
- **Area**: `{ k, o, i?, n?, le? }`, `k` one of `grass`, `wood`, `pitch`, `track`, `playground`,
  `sand`, `farm`, `water`, `parking`, `plaza`; `le` is the `leisure` value (`park`, `garden`).
- **Zone** (vector only): landuse polygons `{ k, o, i? }` with `k` like `residential`,
  `commercial`, `retail`, `industrial`, `school`, `university`, `hospital`, `railway`. Used to
  infer building styles; not drawn.
- **Waterway** (`lines`): `{ k: "river" | "stream" | "canal" | "ditch" | "drain", p }`.
- **Tree**: `[x, z, leaf, height]`, `leaf` 0 unknown / 1 broadleaved / 2 needleleaved (detail only).
- **Prop**: `{ k, x, z, dir? }`, `k` one of `bench`, `bikerack`, `lamp`, `bin`, `hydrant`,
  `postbox`, `fountain`, `stop`, `signal` (detail only).

## What the game adds that isn't in the data

Generated, not mapped: sidewalks where none are mapped, street trees, lamps, parked cars,
building heights and styles when unknown, wall materials, facade details, roof shapes and
colours (unless tagged or, in the US, measured from aerial photos), parking stalls, and
narrowed road widths. Treat these as decoration; the layout, names and footprints are real.
