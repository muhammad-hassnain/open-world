# Data formats

Map data comes from [OpenStreetMap](https://www.openstreetmap.org) (© OpenStreetMap contributors,
[Open Database License](https://www.openstreetmap.org/copyright)), enriched with
[Overture Maps](https://docs.overturemaps.org/attribution/) places and buildings.

## Sources

| Source | Covers | Delivered as | Has |
| --- | --- | --- | --- |
| [OpenFreeMap](https://openfreemap.org) vector tiles, [OpenMapTiles](https://openmaptiles.org/schema/) schema | The whole planet, updated weekly | z14 `.pbf` tiles fetched by the browser | Building footprints with heights/colours, roads by class with names, landcover/landuse, water, named places, neighborhoods |
| Detail tiles from `tools/build_detail.py` (Overpass API) | Tiles listed in `DETAIL_TILES` (downtown Davis today) | `data/detail/14/<x>/<y>.json` + `data/detail/index.json` | Everything above plus building types, mapped sidewalks/crossings, lanes/width tags, trees, benches, lamps, hydrants, addresses, opening hours, cuisine, websites |

Both are enriched in the browser with [Overture Maps](https://overturemaps.org) (`js/overture.js`),
read from Overture's monthly PMTiles archives
(`https://overturemaps-extras-us-west-2.s3.amazonaws.com/tiles/<release>/{places,buildings}.pmtiles`,
newest release found by listing the bucket) with range requests, z14 like the other sources:

* **Places** (Meta, Foursquare, Microsoft, BrightQuery; CDLA Permissive 2.0) are matched to OSM
  places by name within 60 m. A match fills in the missing address, phone and website; an OSM place
  that Overture only knows as `permanently_closed` is dropped. Unmatched places that are open, have
  confidence ≥ 0.7 and a storefront-like category become new places with ids `o<overture id>`
  (offices, home businesses, parking and parcel lockers are left out).
* **Buildings**: a footprint that overlaps an OSM building only adds what that building lacks
  (`t` from `class`, floors, height, facade colour); this gives vector-tile buildings real types.
  Footprints OSM doesn't have (Microsoft ML, Esri, Google; ≥ 12 m²) are added.

If Overture is unreachable (12 s timeout) the tile keeps its OSM data only.

Elevation is separate from the map data; see [Elevation](#elevation). Place photos come live
from [Wikimedia Commons](https://commons.wikimedia.org), matched to places through
[Wikidata](https://www.wikidata.org); each photo keeps its own license and is shown with its
author and license.

Both map sources are converted to the **common format** below, with coordinates in tile units
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

## Elevation

[Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) (originally made by Mapzen, hosted
on AWS Open Data) at `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`,
fetched by the browser at zoom 15. Each pixel's height in meters is `R·256 + G + B/256 − 32768`.
Resolution depends on the source: 3–10 m in the US (USGS 3DEP), about 30 m in most of the world
(SRTM), coarser at high latitudes. It is a terrain model: buildings and trees are not in it, and
bridges and overpasses are not either.

Required attribution (shown in game as a link):

* ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and funded under
  National Science Foundation awards 1043681, 1559691, and 1542736;
* Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
* Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich;
* Canada terrain data contains information licensed under the Open Government Licence – Canada;
* Europe terrain data produced using Copernicus data and information funded by the European
  Union - EU-DEM layers;
* Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration;
* Mexico terrain data source: INEGI, Continental relief, 2016;
* New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New Zealand and
  the New Zealand Government (All rights reserved);
* Norway terrain data © Kartverket;
* United Kingdom terrain data © Environment Agency copyright and/or database right 2015. All
  rights reserved;
* United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the
  U.S. Geological Survey.

Source: [tilezen/joerd attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md).

## What the game adds that isn't in the data

Generated, not mapped: sidewalks where none are mapped, street trees, lamps, parked cars,
building heights and styles when unknown, wall materials, facade details, roof shapes and
colours (unless tagged or, in the US, measured from aerial photos), parking stalls, and
narrowed road widths. Treat these as decoration; the layout, names and footprints are real.
