# AGENTS.md

Working notes for anyone changing this codebase, whether a person or an automated coding
agent. Read this before making changes; read [README.md](README.md) for what the project is.

## The project in one paragraph

An open world of the whole planet built from OpenStreetMap data. A MapLibre globe lets you pick
any place; "Walk here" builds a realistic, walkable 3D neighborhood around that point and streams
more as you move. Everything runs in the browser (plain ES modules + three.js 0.160.1 +
MapLibre 5.24.0, no build step): it downloads OpenFreeMap vector tiles (or, for selected tiles,
richer pre-built OpenStreetMap data from `data/detail/`), enriched with Overture Maps places and
buildings, and elevation tiles, cuts them into
chunks and generates streets, buildings, trees, signs and props on the real terrain. `serve.py` only serves files. Design for
"anywhere": Davis is the starting point, not a special case.

## Run

```bash
python3 serve.py            # http://localhost:8080 (globe) ; static files only
```

Useful URLs: `/?test` (walk straight into Davis, no click-to-play), `/?test&at=LAT,LON`
(walk in anywhere), `/?globe` (open the globe; `game.ready` when it has loaded),
`/#LAT,LON` (deep link). Front-end edits need only a reload (`Cache-Control: no-store`).

## Verify your change

There is no unit-test suite; correctness is checked by loading the game.

1. **Console must be clean.** The screenshot tool reports page errors and console errors and
   exits non-zero on page errors.
2. **Look at it.** For anything visual:
   ```bash
   pip install -r tools/requirements.txt && python3 -m playwright install chromium   # once
   python3 tools/screenshot.py                     # davis signs paris tokyo nyc overview map globe
   python3 tools/screenshot.py davis paris         # just some views -> ./screenshots/
   ```
   Check at least one detailed area (davis) and one vector-tile city (paris, tokyo or nyc):
   they go through different data paths. On a machine without a usable GPU, add `--software` (slow).
3. **Streaming/perf changes:** walk or run across several chunks and watch the fps counter;
   chunks should load ahead of you without long frames.

`window.game` (available in every mode) for scripted checks:

| Member | Use |
| --- | --- |
| `game.ready` | `true` once the street world (or `?globe`) has loaded |
| `game.enterStreet(lat, lon, bearing)` | build the world at a new place |
| `game.teleport(x, z, yaw?)` | move within the current world (local meters) |
| `game.setView(camYaw, camPitch, camDist?)` | aim the camera |
| `game.press(code, down)` | hold/release a key, e.g. `game.press('KeyW', true)` |
| `game.labels.setMode('tags' \| 'signs' \| 'off')` | switch label mode |
| `game.openMap(true \| false)`, `game.openGlobe('globe' \| 'map')` | globe/map screens |
| `game.world`, `game.chunks`, `game.player`, `game.globe`, `game.renderer` | inspect state; `chunks.stats`, `renderer.info.render` |

## Code map

| File | Responsibility |
| --- | --- |
| `js/main.js` | Renderer, sky, sun/shadows, screens (`globe`/`loading`/`street`), `enterStreet`, `findSpawn`, input, HUD, loop, `window.game` |
| `js/rendering.js` | Fixed-light shader guards and adaptive 3D resolution; About graphics choice; performance state in `game.quality.stats` |
| `js/geometry.js` | Cooperative exact vertex indexing for static chunk meshes; preserves UV/normal/color boundaries and surface positions |
| `js/globe.js` | MapLibre globe (OpenFreeMap style, RTL text plugin), Nominatim search and reverse geocoding |
| `js/materials.js` | Shared `MeshStandardMaterial`s: textured (with `userData.scale` = meters per texture repeat) and plain/paint/glass/water |
| `js/aerial.js` | USGS aerial image per z14 tile (US only) → median roof color `rc` per building |
| `js/geo.js` | Web Mercator math, `Frame` (local meters around the walk-in point), tile rectangles; `DATA_ZOOM` 14, `CHUNK_ZOOM` 16 |
| `js/terrain.js` | `Terrain`: loads Terrarium elevation PNGs (z15) per z14 tile, bilinear `at(x, z)` relative to the walk-in point, `water(x, z)` clamped to sea level |
| `js/farview.js` | `FarView`: zoom-12 `Terrain` ring mesh (420 m to 20 km, colored by height/slope) plus a sea disc, rebuilt after moving 2.5 km; sunk and depth-pushed behind the chunks; `lowAround()` drives `atmo.viewBoost` (haze lifts when high) |
| `js/tiledata.js` | Fetch a z14 tile: detail JSON if listed in `data/detail/index.json`, else OpenFreeMap; OpenMapTiles → common format; `toLocal` |
| `js/overture.js` | Overture Maps PMTiles reader (range requests, newest release from the bucket listing); `mergeOverture` adds fresher places (drops ones closed for good, fills address/phone/web) and footprints/building types OSM lacks |
| `js/navigate.js` | `Navigator`: OSRM route (FOSSGIS server, OSRM demo as fallback) from the player to a map point ("Drive here"), progress along it, next maneuver / lanes / distance / ETA panel (`#nav`), reroute when off the route; `line` for the minimap, `onChange` for the map layer |
| `js/roadsigns.js` | `RoadSigns`: guide signs (gantries on freeways, posts elsewhere) and route shields from `chunk.signs`, canvas panels built within 520 m of the player |
| `js/arcade.js` | `Arcade`: Speed Points (near misses, oncoming, drifts, top speed, takedowns, escapes; combo ×5; saved in localStorage), nitrous refill, gas stations (fuel POIs: repair, refill, respray, lose 2 stars unseen), slow-motion crash cam (`timeScale`, `applyCamera`) |
| `js/speedcams.js` | `SpeedCams`: speed cameras and speed zones (start/end gates, average speed) on major roads, placed per lat/lon grid cell so they're at the same place every visit; bests in localStorage |
| `js/races.js` | `Races`: race starts (beacons) per lat/lon grid cell; sprint (~3.5 km) or 2-lap circuit routed by OSRM (`fetchRoute`), checkpoints, 3 AI rivals following the route polyline (bend speed, rubber band, unstick), countdown, position, results, best times |
| `js/mvt.js` | Mapbox Vector Tile decoder (protobuf → layers/features, polygon ring grouping) |
| `js/bridges.js` | Deck heights for bridges and their ramps per tile (`elevateRoads`), `deckY(road, x, z)` |
| `js/chunks.js` | `ChunkManager`: which chunks to load/build/drop, tile prep (T-junction repair, road-width fitting, footway classification), clipping, builds |
| `js/clip.js` | Clip rings/polylines to a rectangle; `onBoundary` marks seams between chunks |
| `js/world.js` | `ChunkIndex` (per-chunk data + spatial hashes) and `World` (queries across chunks: `resolveCircle`, `groundAt`, `heightAt`, `nearestRoad`, `onRoad`, `locate`, …) |
| `js/streets.js` | Ground, areas, roads, center lines, stop lines, crosswalks, paths, sidewalks, spots for trees/lamps/cars; lite mode for distant chunks |
| `js/buildings.js` | `styleOf`, `layout` (floors/heights), walls (skipping chunk seams), roofs, facades, awnings; lite mode |
| `js/props.js` | Shared, instanced trees, lamps, benches, bike racks, hydrants, bins, parked cars |
| `js/trees.js` | Textured branch/canopy geometry, shared wind uniforms and matching depth shaders; per-instance near/far detail updated at 2 Hz (65 m desktop / 40 m mobile, 10 m hysteresis) |
| `js/labels.js` | Per-chunk place items, sign placement, street-sign corners, floating tags, lazy 3D signs |
| `js/multiplayer.js` | `Multiplayer`: WebSocket to the relay (room per zoom-6 tile), sends own state as lat/lon at ≤5 Hz (heartbeat 2 s), draws other players as `Character`s with name tags; `setOnline`, `setProfile`, `positions()` |
| `relay/src/index.js` | The relay: `Room` Durable Object per region forwarding each player's state to players within 2 km; rate limits, cleans names |
| `js/photos.js` | `placePhotos(name, lat, lon)`: Wikidata item near the place with a matching name → P18 image + Commons category photos, with author/license; cached |
| `js/minimap.js` | Per-chunk minimap canvases and the rotating minimap |
| `js/character.js` | `Character(look, appearance)`: four textured CC0 Innerscene/MakeHuman people, idle/walk/jog/run, head glances, analytic bicycle limb reach, lighter NPC meshes and owned-resource disposal; `setLook()` |
| `js/vehicles.js` | `Vehicle('car' \| 'bike', type)`: Kenney models, fixed-step car dynamics, terrain/surface samples, contact impulses, AI path steering; kinematic bikes; `loadCars()`, `parkedCarMesh()` for instanced cars |
| `js/carphysics.js` | Original 120 Hz car solver: per-wheel combined grip, mass/yaw inertia, spring/damper suspension and weight transfer, drivetrain/gears, drag, slope gravity and weather; `CAR_HANDLING` per model; pure JS numerical checks in `tools/check_carphysics.mjs` |
| `js/traffic.js` | `Traffic`: ~20 instanced cars following car roads via `world.nodes` (across chunks), right-hand lane, junction choice, gap keeping, red lights (`world.signalAt` + `signalState`); `take()` for the player; `buildLights`/`updateLights` for light poles in full chunks |
| `js/police.js` | `Police`: crimes seen by patrols (`_crimes`, line of sight), heat from chase time while seen; out of every unit's sight circle the cooldown drops one star each time it fills (`_sight`), `markers()` for the minimap (which zooms out in a chase); units (`Vehicle` + `steerTo` + A* `route` over `world.nodes`), roadblocks, busted/cooldown meters and HUD, `Siren` (Web Audio) |
| `js/atmosphere.js` | `Atmosphere`: owns sky (shader with sun disc, sunset glow, clouds, stars), fog, sun/moon and hemisphere lights, env map rebakes; `sunPosition(date, lat, lon)`; live weather from Open-Meteo (WMO codes → clouds/rain/snow/fog/storm); GPU rain/snow; wet/snowy surfaces; night: lit windows (glass shader), lamp glow + point lights at the nearest lamps, headlights; time/weather modes |
| `js/drivingfx.js` | `DrivingEffects`: fixed pools for skidmarks, tire smoke/spray/dust, impact sparks and light halos with cached occlusion; `clear()` on world changes; `game.drivingFX.stats` for checks |
| `js/soundscape.js` | `Soundscape`: original Web Audio engine/tires/impacts/horns/footsteps/rain, shared siren context and sound toggle, capped transient voices; `game.sound.stats` |
| `js/pedestrians.js` | `Pedestrians`: 8 local people (4 mobile), typed by `people.js`, extending validated routes, pausing, passing and avoiding nearby cars; pooled characters, `clear()` on world changes; `game.pedestrians.stats` |
| `js/people.js` | Deterministic factory of stroller/commuter/walker/jogger appearance and behavior descriptors; clothing palettes, height/build, pace, pauses and animation phase |
| `js/limits.js` | `speedLimit(road, miles)` by road class, `milesHere(lat, lon)` (US, UK); used by the speedometer, traffic speeds and police speeding |
| `js/profile.js` | Player name and look in localStorage (`loadProfile`, `saveProfile`, `cleanName`) |
| `js/player.js` | Movement (`gait` 0 walk, 1 run, 2 sprint), curbs, collision, camera |
| `js/touch.js` | `TouchControls`: joystick fixed in a bottom corner (held all the way locks a sprint that continues after release until the stick is touched again), look anywhere else, pinch zoom, Jump in the other corner; `setSide('left' \| 'right')` (saved in localStorage); adds `body.touch` / `body.stick-right` |
| `js/util.js` | Polygon helpers, `resample`, `offsetPolyline`, `SpatialHash`, `GeoBuilder` (with world-space UVs), `MultiBuilder`, `Budget` |
| `tools/build_detail.py` | Overpass → `data/detail/<z>/<x>/<y>.json` for tiles in `DETAIL_TILES` |
| `tools/fetch_textures.py` | Downloads the CC0 textures into `assets/textures/` and writes `CREDITS.md` |
| `tools/screenshot.py` | Headless screenshots (Playwright) |
| `tools/pack_character.py` | Character `.gltf` → compact `.glb` keeping only the animations the game uses and removing weapons (no weapons in the game) |

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/DATA.md](docs/DATA.md).

## Conventions (follow these)

- **No build tooling.** No npm, bundler or transpiler. three.js (`0.160.1`) and MapLibre
  (`5.24.0`) are pinned in `index.html`. If you upgrade three.js, re-check lighting and the sky shader.
- **Static site.** Everything must work from plain files (it is meant to be deployable to static
  hosting). Don't add server-side logic; `serve.py` stays a file server using only the
  standard library on Python 3.9+. The one exception is the multiplayer relay in `relay/`
  (Cloudflare Worker + Durable Object, deployed separately with `npx wrangler deploy`); it only
  forwards messages between players, stores nothing, and the game works without it.
- **Build for anywhere, not just Davis.** Derive behavior from OSM data and geometry. Both data
  sources (vector tiles and detail files) must keep working; anything that only exists in
  detail data (sidewalk tags, opening hours, trees) needs a fallback for vector tiles.
- **Coordinates are meters** in the current `Frame`: origin at the walk-in point, `+x` east,
  `+z` south, `+y` up. Tile data arrives in tile units and is converted with `toLocal`.
  `y = 0` is the ground at the walk-in point; heights elsewhere come from `world.elevation(x, z)`.
- **Polygon orientation:** `orient()` makes outer rings counter-clockwise seen from above
  (negative shoelace area in x,z) and holes clockwise; the outward normal of edge `a → b` is
  `(-dz, dx)`. Wall and facade code depends on this.
- **Chunks are independent.** Builders only create geometry inside their chunk's rectangle;
  edges on the rectangle (`seam`) are not walls. Cross-chunk lookups go through `World`.
- **Keep the main thread responsive.** Long loops in builders call `await budget.tick()`.
  Static scenery is merged with `GeoBuilder`; repeated objects use shared geometry/materials
  (`userData.shared = true`, never disposed) in an `InstancedMesh`. Everything else created for a
  chunk is disposed when the chunk is rebuilt or dropped.
- **Everything sits on the terrain.** Ground layers (ground, areas, roads, markings) go through a
  `MultiBuilder` with `drape`, which subdivides triangles to `maxEdge` and adds the elevation;
  write them flat (small `Y` offsets from `streets.js`) and let the drape lift them. Their draw
  order on slopes comes from `layered()` in `materials.js` (a depth bias toward the camera), so
  a new ground material needs a layer there. Keep this view-space bias consistent with
  people/vehicle contact materials. Buildings use `mb.setYOffset(b.base)`: one base per building, foundations
  below. Props, labels and anything else placed in the world add `world.groundAt` or
  `world.elevation`. Test "is this a sidewalk" with `world.onSidewalk`, never `groundAt > 0`.
- **Custom shaders** must include `#include <colorspace_fragment>` on its own line.
- **Text in any script.** Names can be Arabic, Urdu, Hebrew, CJK, etc. HTML and canvas text
  are shaped by the browser; map labels need MapLibre's RTL plugin (already loaded).
- **Realistic look:** surfaces use CC0 textures (`assets/textures/`, fetched by
  `tools/fetch_textures.py`) on `MeshStandardMaterial`, tinted by vertex colors (a white stucco
  texture becomes any paint color). Texture coordinates are world-anchored (`uvWall`,
  `uvAlong`, `uvPlanar` on `GeoBuilder`) so textures line up across walls and chunks; set the
  right one before adding faces. Rendering uses ACES tone mapping and an environment map baked
  from the sky. Trees use shared instanced branch/foliage meshes with distance detail; cars are low-poly, and people are textured CC0 models
  (Innerscene / MakeHuman) loaded with `GLTFLoader`, cloned with `SkeletonUtils` per person.
  `people.js` supplies deterministic appearance/behavior templates. Textures/geometry are shared;
  per-person tinted materials and skeleton bone textures must be disposed. `Character` restores
  its last animation pose before procedural edits, not the bind pose (the mixer caches constants).
- **Detail data:** if you change the Overpass query or processors in `tools/build_detail.py`,
  bump `PROCESS_VERSION` and rebuild (`python3 tools/build_detail.py --force`).
- **Credits must stay visible:** `#attrib` (street view) and MapLibre's attribution (globe)
  are license requirements for OpenStreetMap/OpenMapTiles/OpenFreeMap data and the elevation
  sources (Terrain Tiles link); keep the Nominatim credit under the search box. Photos always show
  their author and license. The About panel (`#about`) lists every data source; update it when
  you add one.
- **Commits and PRs:** short descriptive messages about the change. Do not add co-author
  trailers, "generated with" lines, or any tool attribution.

## Common tasks

**Add a detailed area.** Add `(14, x, y)` to `DETAIL_TILES` in `tools/build_detail.py`, run it,
commit the files under `data/detail/`.

**Map a new OpenMapTiles field or layer.** Edit `adaptVector()` in `js/tiledata.js`; keep the
output in the common format documented in `docs/DATA.md`, and add the same field to
`tools/build_detail.py` if detail data can provide it.

**Tune buildings.** `styleOf()` (style from type, POIs inside, zone, size, levels), `layout()`
(floors and heights), `facades()` in `js/buildings.js`.

**Tune streaming.** Radii are at the top of `js/chunks.js` (`FULL_R`, `LITE_R`, `DOWN_R`,
`DROP_R`); fog distance is in `js/main.js`.

**Add a prop type.** Geometry function + entry in `assets()` and `buildFurniture()`
(`js/props.js`); add a collider if people shouldn't walk through it. Mapped props only exist
in detail data.

## Area-specific assumptions (to generalize later)

- Lane markings follow the region (`yellowCenterLines` in `limits.js`: yellow center lines in the
  Americas, Norway, Finland, China, South Korea, Taiwan; white elsewhere), but lanes, stop lines,
  parked-car direction and sidewalk placement assume right-hand traffic. Lane counts come from
  OSM `lanes` (detail data only); elsewhere `laneLayout()` in `world.js` uses defaults by class
  fitted to the road width.
- Street signs are US-style green blades; sidewalk and lane widths are US defaults.
- Fallback building heights and styles are tuned for a small US downtown.
- The default start point and the only detailed tile are downtown Davis.

## Gotchas

- OpenMapTiles has no building types, sidewalk/crossing tags, trees, benches or opening hours.
  Styles are inferred, footways are classified as sidewalks/crossings by geometry
  (`classifyFootways`), and street trees/lamps are generated.
- OpenMapTiles' `render_height` of exactly 5 means "unknown"; other values become floors at
  3.66 m per floor.
- Vector tiles merge features with identical attributes; `polygons()` splits building
  multipolygons back into individual buildings by ring winding.
- Old city centers are narrower than default road widths; `fitRoadWidths` narrows roads to the
  measured wall-to-wall width. Without it, asphalt runs under buildings.
- Headless Chromium needs `--use-angle=gl-egl` to use the GPU on Linux. After many screenshots
  in one browser session `page.screenshot` can hang; `tools/screenshot.py` uses a fresh browser
  per view. MapLibre logs harmless "performance warning: READ-usage buffer" messages there.
- Terrain is a bare-earth model from 30 m (most of the world) to 3–10 m (US) data. Bridges and
  overpasses aren't in it; `bridges.js` (`elevateRoads`, per tile) gives bridge roads deck heights
  between their ends on the ground, adds clearance over roads below (by OSM `layer`) and lifts the
  approaches into ramps at 5.5%. Elevated roads have `ez` and a third coordinate (deck height) on
  their points, which `clipLine` interpolates; `streets.js` draws them with a second builder draped
  on the deck. Anything that stands on the ground must pass its own height:
  `world.groundAt(x, z, y)` includes decks within a step of `y`; without `y` it's the terrain.
  `world.offDeck` is the railing (vehicles slide along it). `world.onRoad` ignores bridges (ground
  queries under them). Tunnels are skipped. Pier colliders don't exist yet. Hilly chunks have
  about 40% more triangles because the ground is subdivided to 5 m; flat chunks use 40 m.
- Files under `assets/` are cached by browsers for a day (`vercel.json`). When you replace one
  in place (same name), bump its version in the URL (`MODEL_VERSION` in `js/character.js` for
  characters) or players keep seeing the old file.
- Roof colors need the USGS imagery export (US only); it adds a few seconds to the first load of
  each tile and has a 10 s timeout, after which roofs keep generated colors.
- Place photos use the regular MediaWiki APIs (Wikidata `list=search` with `nearcoord:` and
  `haswbstatement:P18`, then `wbgetentities`, then Commons `imageinfo`), not the Wikidata Query
  Service, which rate-limits hard. Every photo shown must carry its author and license.
- The start-at-your-location prompt (geolocation) only exists on https and localhost, so it
  never appears over a plain-http Tailscale address.
- Vehicles: parked cars are props in `chunk.parked` (`takeParkedCar` hides the instance and turns
  its collider off; it comes back when the chunk rebuilds). Vehicles that move between chunks are
  `world.obstacles` (circles) while parked; the one being driven passes itself as `ignore` to
  `resolveCircle`. The rider pose (`RIDE` in `character.js`) uses two-bone reach over the idle clip to
  place hands on grips and independently rigged feet on the rotating pedals.
- Traffic lights: `ChunkIndex.signals` (from junctions; mapped `signal` props in detail data, else
  where two roads of tertiary or higher cross with one secondary or higher). Each controller
  alternates two axes on a 36 s cycle; `signalState(sig, axis, t)` is the one source of truth for
  lamps and cars. Car models' handling is `CAR_MODELS` in `vehicles.js`.
- Police units have `hp`; ramming (closing speed) and their own crashes damage them, and at 0
  they're `wreck`ed (`onTakedown`). Spike strips (heat 2+) and units right behind you for a few seconds (heat 2+, "shot out") set
  `vehicle.flat` until a gas station. Chase units boost when more than 60 m away. Traffic light poles
  are breakable circle colliders (`onBreak`, `world.smash`); car movement is substepped (0.5 m).
  Nitrous is `vehicle.nitro` (0..1) and `ctl.boost`; Shift while driving, the N₂O touch button.
- Police units drive with `rough` collisions (only buildings and vehicles with a driver stop them)
  so they don't jam on parked cars and props, and are replaced when they stop getting closer out
  of sight. The player's driven car stays in `world.obstacles` so units can box it in.
- Lighting changes go through `Atmosphere.apply()`; don't set sun, fog or sky colors elsewhere.
  The number of lights is fixed (lamp point lights and the headlight always exist, at intensity 0
  by day) so shaders don't recompile when night falls. Custom shaders that are depth-tested need
  the `logdepthbuf` chunks (see the rain/snow shaders).
- Terrain PNGs are decoded in `terrain.js` (`decodePNG`), not via a canvas: browsers can
  color-manage canvas images (wide-gamut Macs), and one step in the red channel is 256 m.
- Multiplayer privacy: a player who started at their own (geolocated) position starts hidden;
  "hide me" is remembered in localStorage (`openworld.hidden`). Tests (`?test`) stay offline
  unless `?relay=` is given. Test with two browser contexts against `npx wrangler dev`.
- Overture keeps only the last few monthly releases online; `overture.js` lists the bucket for the
  newest one that has both `places` and `buildings` (`FALLBACK_RELEASE` if listing fails). Overture
  calls these tiles "for data inspection", so everything must keep working when they fail.
- Road signs come from Overture's transportation tiles (`mergeSigns` in `overture.js`): each
  `destinations` entry (labels for going from a segment onto `to_segment` at `from_connector`)
  becomes a panel 170 m (freeways) or 60 m before the connector, grouped per decision point; the
  turn direction comes from the geometry of the next segment. These tiles are only fetched for
  tiles with motorway/trunk/primary roads. US route shields get a cardinal direction from the
  route number's parity. Exit numbers aren't in the data (OSRM has them for the route).
- The OSRM servers are free community services: one request per route, per reroute (at most
  every 8 s) and per race start; keep it that way.
- Events (speed cameras, zones, race starts) are decided per lat/lon grid cell with a hash of the
  cell, not per chunk, so they don't move between visits and bests (keyed by cell) stay valid.
- Nominatim allows about one request per second; search only runs on submit and reverse
  geocoding once per walk-in.
- Pointer lock may be refused; the game then falls back to click-and-drag to look.
- Touch controls switch on with the first touch (or at load on a coarse-pointer device) and
  skip the click-to-play panel. Test them with Playwright's `has_touch`/`is_mobile` context and
  CDP `Input.dispatchTouchEvent`; `body.touch` CSS moves the minimap, card and credits.
- The site deploys to Vercel as static files (`vercel.json`). Don't add Python files named
  `app.py`, `index.py`, `server.py`, `main.py`, `wsgi.py` or `asgi.py` at the root or in `src/`,
  `app/` or `api/`: Vercel treats them as a Python web app and the deploy fails. That is why the
  local server is `serve.py`.
