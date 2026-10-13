# Open World

An open world of the whole planet, built from real map data and explored on foot in third
person. Spin the globe, search for any place, zoom in to a street and walk it: every road,
building, park and shop comes from [OpenStreetMap](https://www.openstreetmap.org), generated in
the browser with realistic materials. It starts in downtown Davis, California, which has extra
detail.

![Standing on C Street next to Central Park in Davis](docs/images/davis.png)

| Go anywhere from the globe | Paris, Le Marais | Storefront and street signs in Davis |
| --- | --- | --- |
| ![Globe](docs/images/globe.png) | ![Paris](docs/images/paris.png) | ![Signs mode at B & 3rd Street](docs/images/signs.png) |

Where it's going: more realistic places as people contribute real photos and video, and more
detail everywhere. See [docs/ROADMAP.md](docs/ROADMAP.md).

## Features

- **The whole world.** A 3D globe with place search; zoom in to any street and press
  **Walk here**. Press `G` to fly back out. The world streams in around you as you walk.
  If you share your location, you start on the street where you are.
  If you share your location, you start on the street where you are.
- **Third-person character** with walk, run, sprint and jump animations, an over-the-shoulder camera
  that avoids walls, and collision with buildings, trees, lamps and parked cars.
- **Real terrain**: streets, buildings and parks follow the ground, so San Francisco's hills
  climb and Montmartre rises to Sacré-Cœur. Elevation comes from open terrain tiles covering
  the whole planet.
- **Streets from real data**: road widths fitted to the buildings around them, cracked asphalt,
  center lines, stop lines, crosswalks, concrete sidewalks with curbs, footpaths, bike paths,
  parks, water, and parking lots with painted stalls.
- **Buildings from real footprints**: real heights and colors where OpenStreetMap has them,
  otherwise styles inferred from what's inside and the surrounding zone. Real materials (siding,
  stucco, brick, concrete, corrugated metal; shingle, clay-tile and gravel roofs), gable and hip
  roofs, porches, shutters, balconies, storefronts and awnings, varied building by building.
- **Real roof colors in the US**: each roof's color is measured from USGS aerial photos.
- **Street life**: trees, street lamps, benches, bike racks, hydrants and parked cars.
- **Real places in any language**: shop, restaurant and building names as floating tags or
  physical signs (`L` switches), an info card when you walk up to a place, and a live
  "where am I" bar with the street, cross street and neighborhood.
- **Photos of real places**: walk up to a landmark and its photos from
  [Wikimedia Commons](https://commons.wikimedia.org) appear on the info card; press `P` (or tap
  the card) to browse them, each with its author and license.
- **Photos of real places**: walk up to a landmark and its photos from
  [Wikimedia Commons](https://commons.wikimedia.org) appear on the info card; press `P` (or tap
  the card) to browse them, each with its author and license.
- **Extra detail where it's been built**: selected areas (downtown Davis today) use richer
  OpenStreetMap data with mapped sidewalks, crosswalks, trees, benches and opening hours.

## Quick start

Requirements: Python 3.9+ and a browser with WebGL 2. There is no build step and nothing to
install.

```bash
python3 serve.py
```

Open <http://localhost:8080>. The globe flies to Davis; press **Walk here** (or search for
somewhere else first).

The server only serves files; map data is fetched by the browser and kept in its cache, so
places you've visited load faster next time. The server listens on all interfaces, so other
devices on your network or [Tailscale](https://tailscale.com) tailnet can play at
`http://<this-machine's-ip>:8080`. Set `PORT=9000` to use a different port.

Links: `http://localhost:8080/#48.85745,2.36154` starts walking at that latitude/longitude;
the address bar keeps your current position so you can share it.

## Controls

| Action | Keys |
| --- | --- |
| Move | `W` `A` `S` `D` or arrow keys |
| Run / jump | `Shift` / `Space` |
| Sprint | Tap `Shift` twice and hold |
| Look | Mouse (or `Q` / `E`); if the mouse can't be captured, click and drag |
| Zoom camera | Mouse wheel |
| Labels: tags → signs → off | `L` |
| Photos of the place you're at | `P` |
| Photos of the place you're at | `P` |
| Map of where you are (pick a spot to walk to) | `M` |
| Fly out to the globe | `G` |
| Respawn where you walked in | `R` |
| Pause / release mouse | `Esc` |

On phones and tablets: put your thumb anywhere on the left half of the screen for a joystick
(push further to run; hold it all the way for a moment to lock into a sprint), drag on the right
half to look, pinch to zoom, and tap **Jump**.

## How it works

```
Globe (MapLibre + OpenFreeMap) ──"Walk here"──▶ street world at that point
                                                 │
 OpenFreeMap vector tiles (whole planet) ────────┤  browser downloads ~2 km tiles,
 data/detail/*.json (pre-built richer areas) ────┘  cuts them into ~500 m chunks and
                                                    builds streets, buildings and props
                                                    around the player as they move
 Terrain Tiles (elevation PNGs) ──────────────────▶ everything is draped on the ground
```

Everything runs in the browser; `serve.py` is a plain file server. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details and [docs/DATA.md](docs/DATA.md) for
the data formats.

## Project layout

```
index.html              Page, HUD and globe UI, styles, script/import map
js/main.js              Boot, screens (globe/loading/street), input, HUD, game loop, spawning
js/globe.js             MapLibre globe, place search and reverse geocoding (Nominatim)
js/materials.js         Shared textured materials (CC0 textures in assets/textures)
js/aerial.js            Roof colors sampled from USGS aerial imagery (US only)
js/geo.js               Web Mercator tiles and the local metric frame around the walk-in point
js/terrain.js           Elevation from Terrain Tiles (Terrarium PNGs), sampled per point
js/tiledata.js          Load a tile (vector or detail) and convert it to the common format
js/mvt.js               Minimal Mapbox Vector Tile decoder
js/chunks.js            Streaming: tile prep, clipping into chunks, full/lite builds, unloading
js/clip.js              Polygon and polyline clipping to chunk rectangles
js/world.js             Chunk indexes and world queries: collision, curbs, streets, locations
js/streets.js           Ground, areas, roads, markings, crosswalks, sidewalks, furniture spots
js/buildings.js         Building styles, heights, facades, roofs
js/props.js             Trees, lamps, benches, bike racks, hydrants, parked cars (instanced)
js/labels.js            Place labels: floating tags, 3D signs, street signs, info-card lookup
js/photos.js            Photos of places from Wikimedia Commons (matched through Wikidata)
js/photos.js            Photos of places from Wikimedia Commons (matched through Wikidata)
js/minimap.js           Rotating minimap from per-chunk canvases
js/character.js         Procedural stylized character and its animation
js/player.js            Movement, collision response, third-person camera
js/touch.js             Touch controls: floating joystick with sprint lock, look, pinch zoom, Jump
js/util.js              Geometry helpers, spatial hash, mesh builder, time slicing
data/detail/            Pre-built detailed tiles (downtown Davis)
assets/textures/        CC0 material textures (see CREDITS.md there)
serve.py                Static file server (Python standard library only)
tools/build_detail.py   Build detailed tiles from OpenStreetMap (Overpass API)
tools/fetch_textures.py Download and prepare the material textures
tools/screenshot.py     Headless screenshots for checking visual changes
docs/                   Architecture, data formats, roadmap, images
```

## Deploying

It's a static site: any static host works, with no build step. On [Vercel](https://vercel.com),
import the repository with **Framework Preset: Other** and **Root Directory: the repository
root** (Vercel may suggest Python and `tools/` because of the scripts there; don't accept that).
`vercel.json` sets cache headers for textures and map data. Every push to `main` redeploys.
Live: <https://open-world-sigma-two.vercel.app>.

## Adding a detailed area

Detailed tiles come from `tools/build_detail.py`. Add the tile (zoom 14 x/y) to
`DETAIL_TILES` in that file, run `python3 tools/build_detail.py`, and commit the generated
`data/detail/` files. Everywhere else uses the vector tiles automatically.

## Contributing

- Read [AGENTS.md](AGENTS.md); it is the short guide for anyone (person or tool) changing the code.
- For visual changes, run `python3 tools/screenshot.py` and look at the images before and
  after your change.

## Credits and license

- Map data © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (ODbL).
  Vector tiles by [OpenFreeMap](https://openfreemap.org) using the
  [OpenMapTiles](https://openmaptiles.org) schema. Search by [Nominatim](https://nominatim.org).
  The in-game credit lines must stay visible.
- Material textures from [Poly Haven](https://polyhaven.com) and [ambientCG](https://ambientcg.com),
  CC0 ([list](assets/textures/CREDITS.md)). Roof colors from USGS/USDA orthoimagery
  ([The National Map](https://www.usgs.gov/programs/national-geospatial-program/national-map)), public domain.
- Elevation from [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on AWS (Mapzen;
  USGS 3DEP, SRTM, GMTED2010, ETOPO1, EU-DEM and national datasets); the full required
  attribution is in [docs/DATA.md](docs/DATA.md#elevation).
- Place photos from [Wikimedia Commons](https://commons.wikimedia.org), each under its own
  license with its author credited in the game; places are matched through
  [Wikidata](https://www.wikidata.org) (CC0).
- Place photos from [Wikimedia Commons](https://commons.wikimedia.org), each under its own
  license with its author credited in the game; places are matched through
  [Wikidata](https://www.wikidata.org) (CC0).
- Rendering by [three.js](https://threejs.org) (MIT) and [MapLibre GL JS](https://maplibre.org)
  (BSD), loaded from unpkg.
- Code is released under the [MIT License](LICENSE).
