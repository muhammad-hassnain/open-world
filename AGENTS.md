# AGENTS.md

Working notes for anyone changing this codebase, whether a person or an automated coding
agent. Read this before making changes; read [README.md](README.md) for what the project is.

## The project in one paragraph

A browser game that turns OpenStreetMap data into a walkable, stylized 3D neighborhood
(downtown Davis, CA: B and C Streets, 1st to 5th). `server.py` downloads OSM data once via the
Overpass API, converts it to compact JSON in local meters, caches it in `.cache/` and serves it.
The browser (plain ES modules + three.js 0.160.1, no build step) generates every street,
building, tree, sign and prop from that data at load time, then runs a third-person character
controller, labels and a minimap.

## Run

```bash
python3 server.py            # http://localhost:8080 ; first run downloads OSM data (1-3 min)
curl localhost:8080/data/status   # per-dataset download status
```

Restart the server after editing `server.py`. Front-end edits only need a browser reload
(responses are sent with `Cache-Control: no-store`).

## Verify your change

There is no unit-test suite; correctness is checked by loading the game.

1. **Console must be clean.** Load `http://localhost:8080/?test` and check for errors, or run
   the screenshot tool, which reports `pageerror`/console errors and exits non-zero on page errors.
2. **Look at it.** For anything visual:
   ```bash
   pip install -r tools/requirements.txt && python3 -m playwright install chromium   # once
   python3 tools/screenshot.py                 # views: spawn run signs street overview map
   python3 tools/screenshot.py signs street    # just some views -> ./screenshots/
   ```
   Open the PNGs and compare with before your change. On a machine without a usable GPU, add
   `--software` (slow).
3. **Movement/collision changes**: also try walking into walls, onto curbs and across streets.

`?test` skips the click-to-play overlay and lets keyboard input work without pointer lock.
It exposes `window.game` for scripted checks:

| Member | Use |
| --- | --- |
| `game.ready` | `true` once the world is built |
| `game.teleport(x, z, yaw?)` | move the player (meters, see coordinates below) |
| `game.setView(camYaw, camPitch, camDist?)` | aim the camera |
| `game.press(code, down)` | hold/release a key, e.g. `game.press('KeyW', true)` |
| `game.labels.setMode('tags' \| 'signs' \| 'off')` | switch label mode |
| `game.openMap(true \| false)` | open/close the full map |
| `game.world`, `game.player`, `game.labels`, `game.renderer` | inspect state, e.g. `renderer.info.render` |

## Code map

| File | Responsibility |
| --- | --- |
| `server.py` | `WORLD` area config, Overpass queries, processors (OSM → compact JSON), disk cache, HTTP |
| `js/main.js` | Renderer, sky, sun/shadows, load + build order, input, HUD, game loop, `window.game` |
| `js/world.js` | `World`: road classification and widths, spatial hashes, collision (`resolveCircle`), `groundAt` (curbs), `heightAt`, `nearestRoad`, `onRoad`, `locate` |
| `js/streets.js` | Ground, area fills, road ribbons, center lines, stop bars, crosswalks, paths, sidewalks (mapped + generated), spots for trees/lamps/cars |
| `js/buildings.js` | Style classification, height/floor layout, walls, roofs (hip roofs on rectangular houses), facades, awnings |
| `js/props.js` | Instanced trees, lamps, benches, bike racks, hydrants, bins, parked cars |
| `js/labels.js` | Place list, sign placement on walls/lawns/posts, street-sign corners, floating tags, lazy 3D signs, nearest-place lookup |
| `js/minimap.js` | Pre-rendered map canvas, rotating minimap, full map + click-to-teleport |
| `js/character.js` | Procedural character model and walk/run/jump animation |
| `js/player.js` | Movement, gravity, curb stepping, collision, third-person camera with wall avoidance |
| `js/util.js` | Polygon helpers, `orient`, `resample`, `offsetPolyline`, `SpatialHash`, `GeoBuilder` mesh builder |
| `tools/screenshot.py` | Headless screenshots (Playwright) |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DATA.md](docs/DATA.md).

## Conventions (follow these)

- **No build tooling.** No npm, bundler or transpiler. Browser code is native ES modules. three.js
  is pinned to `0.160.1` in the import map in `index.html`; addons import from `three/addons/...`.
  If you upgrade three.js, re-check lighting intensities and the sky shader.
- **Server uses only the Python standard library** and must keep working on Python 3.9+.
- **Coordinates are meters** relative to `WORLD.origin`: `+x` east, `+z` south, `+y` up
  (north is `-z`). The server already converts lat/lon; the client never handles degrees.
- **Polygon orientation:** `orient()` makes outer rings counter-clockwise seen from above
  (negative shoelace area in x,z) and holes clockwise. With that, the outward normal of edge
  `a → b` is `(-dz, dx)`. Wall and facade code depends on this.
- **Geometry:** build static geometry with `GeoBuilder` (non-indexed, flat-shaded, vertex colors)
  and merge into a few large meshes. Repeated objects go in an `InstancedMesh` (see
  `props.js`). Only label signs are individual meshes, created lazily near the player.
  Budget today: ~35 draw calls, ~0.9M triangles in the widest view.
- **Flat layers** (ground, areas, roads, markings) are separated by small heights (`Y` table in
  `streets.js`) and rely on the logarithmic depth buffer. Put new flat layers in that table.
- **Custom shaders** must include `#include <colorspace_fragment>` on its own line, or colors
  come out too dark.
- **Visual style is clean and stylized:** soft palettes, Lambert materials, no photo textures yet.
  Keep new assets consistent with that.
- **Data pipeline:** if you change an Overpass query or a processor in `server.py`, bump
  `PROCESS_VERSION` so cached processed files are rebuilt. Raw Overpass responses are cached by
  query hash in `.cache/overpass/`; processed files live in `.cache/data/`.
- **Never commit `.cache/`** (it is in `.gitignore`).
- **The OpenStreetMap credit line** (`#attrib` in `index.html`) is a license requirement; keep it visible.
- **Commits and PRs:** short descriptive messages about the change. Do not add co-author
  trailers, "generated with" lines, or any tool attribution.

## Common tasks

**Change the area.** Edit `WORLD` (`origin`, `core`, `context`) in `server.py`, restart. Update
`findSpawn()` in `js/main.js` if C Street & 3rd Street aren't in the new area.

**Add an OSM dataset.** Add an entry to `DATASETS` in `server.py` (`name: (overpass_query,
processor)`), write the processor to emit compact local-meter JSON, then add the name to
`DATASETS` in `js/main.js` (and to `OPTIONAL_EMPTY` if the game should load without it). Pass it
into `World` and document the format in `docs/DATA.md`.

**Add a prop type.** Map the OSM tag in `PROP_KINDS` (`server.py`), bump `PROCESS_VERSION`, add
a geometry function and an entry in `buildFurniture()` (`js/props.js`), and add a collider if
people shouldn't walk through it.

**Tune buildings.** Style rules are in `styleOf()`, heights/floors in `layout()`, facade details
in `facades()` (`js/buildings.js`). Building heights are mostly estimates because few OSM
buildings here have `height` or `building:levels`.

**Add or restyle a place category.** Categories come from `categorize()` in `server.py`; colors
and display names are in `CATS` in `js/labels.js`.

## Gotchas

- The public Overpass API is slow and sometimes returns 504s or times out. The server retries
  each dataset four times and tries mirror endpoints; `/data/<name>.json` blocks until the
  download finishes (up to 5 minutes) and returns 503 if it ultimately fails. Only `buildings`
  and `roads` are required; the client loads without the others.
- Headless Chromium needs `--use-angle=gl-egl` to use the GPU on Linux; SwiftShader is too slow
  for this scene. After many screenshots in one browser session, `page.screenshot` can hang even
  though the page keeps rendering, so `tools/screenshot.py` launches a fresh browser per view.
- Pointer lock may be refused (some browsers, insecure origins); the game then falls back to
  click-and-drag to look.
- OSM data is uneven: some sidewalks are mapped, most aren't. `streets.js` generates sidewalks
  only where no mapped sidewalk is within 6.5 m, so changes there can create double or missing
  sidewalks. Check both B and C Streets after touching it.
