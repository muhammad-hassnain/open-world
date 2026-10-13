# Roadmap

The idea: an open world of the whole planet. It starts as an accurate, generated model built from
open map data, so it covers anywhere OpenStreetMap does, and gets more realistic wherever people
contribute real photos and video. Davis, California is the first area with extra detail.

## Done

- **Walkable neighborhood:** third-person character, streets, sidewalks, crosswalks, buildings
  with styles and facades, trees, street furniture, parked cars, labels and signs, info cards,
  minimap (downtown Davis first).
- **The whole world (phase 1):** globe with search, "Walk here" anywhere, streaming chunks from
  OpenFreeMap vector tiles, fly back out with `G`, detailed pre-built tiles where available,
  road widths fitted to old city streets, right-to-left map labels.
- **Realistic materials:** CC0 textures for asphalt, concrete sidewalks, pavers, grass, siding,
  stucco, brick, concrete, metal and roofs; parking lots with stalls; gable/hip roofs, porches,
  shutters and balconies; roof colors measured from USGS aerial photos in the US.

## Next: more of the world, better

2. **Detail anywhere.** Fetch the richer OpenStreetMap data for the area you're in on demand
   (sidewalks, crossings, trees, opening hours), swapping it in when it arrives, instead of
   only for pre-built tiles. Needs a fair-use strategy for the public Overpass API.
3. **Big cities and regional rules.** Build chunks in a Web Worker for the densest cities;
   pick driving side, road-marking colors, sign styles and building defaults per country.
4. **More realism.** Real-looking trees, cars and people (currently simple shapes), curb ramps
   and continuous sidewalk corners, better height guesses where OpenStreetMap has none, and roof
   colors outside the US.

Other candidates (no order): people walking, cars driving, driving yourself, time of day and
night lighting, touch controls, deploying as a static site.

## Later: a real-world layer from contributed captures

Status: **idea, parked.** No capture or photo pipeline exists yet. When this is picked up, the
planned first step is facade photos for a single building, then splats or meshes for a few
landmarks.

The base layer stays OpenStreetMap everywhere. On top of it, any building or block that someone
has captured gets a captured version that replaces the generated one. Coverage grows as more
captures come in, first from the project owner, later from other people.

Approaches under consideration, from simplest to most realistic:

| Approach | What you capture | What changes in the game | Effort |
| --- | --- | --- | --- |
| Facade photos | A straight-on phone photo of a building front | The photo is straightened and mapped onto that wall instead of generated windows | Small |
| Street photo spots | Photos with location (own, or open sources like Mapillary) | Viewable in place, like a mini Street View | Small |
| Photogrammetry mesh | A short video or ~50 photos around a building | A textured 3D model replaces the generated building | Medium |
| Gaussian splat | A 1–2 minute walk-around video | A photoreal 3D capture replaces the block | Large |

Any of them needs the same pipeline shape:

1. **Capture**: a phone photo or video, tagged with the building's OSM id or a location.
2. **Process**: straighten photos, or reconstruct a mesh or splat (a local GPU is enough).
3. **Align**: place the result on the map. Phone GPS is only accurate to a few meters, so
   footprints from OSM are used to snap it into place, with manual adjustment at first.
4. **Publish**: store the asset plus a small manifest (`osm_id`, transform, source, license).
5. **Render**: when a building has an asset, the game draws it instead of the generated version
   and keeps using the OSM footprint for collision.

Open questions: storage and hosting once there are many captures, image licensing for
contributed media, blurring faces and license plates, moderation, and keeping captured and
generated blocks visually compatible.
