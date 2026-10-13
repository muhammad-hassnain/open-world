# Roadmap

The idea: a world that starts as an accurate, stylized model of a real place built from open
map data, then gets more realistic wherever people contribute real photos and video.

## Now: stylized downtown from OpenStreetMap

Done:

- Walkable third-person world for downtown Davis (B and C Streets, 1st to 5th) with a low-detail
  ring of surrounding blocks.
- Streets, markings, crosswalks, curbed sidewalks, parks, parking, trees, lamps, benches, bike
  racks, hydrants and parked cars.
- Buildings from real footprints with styles, roofs, facades and storefronts.
- Real place names with switchable labels (tags, signs, off), info cards, minimap and full map.
- Data downloaded once and served from disk; playable from any device on the network.

Candidates for next (not committed to an order):

- Sidewalk corners with curb ramps, so corners are continuous instead of ending at the curb.
- People walking on sidewalks and cars driving on streets.
- Getting into a parked car and driving.
- Time of day: sunset, night with lit windows and street lamps.
- Touch controls for phones and tablets.
- Bigger areas, loaded in chunks as you walk.

## Later: a real-world layer from contributed captures

Status: **idea, not started.** No capture or photo pipeline exists yet.

The base layer stays OpenStreetMap everywhere. On top of it, any building or block that someone
has captured gets a realistic version that replaces the stylized one. Coverage grows as more
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
5. **Render**: when a building has an asset, the game draws it instead of the stylized version
   and keeps using the OSM footprint for collision.

Open questions: storage and hosting once there are many captures, image licensing for
contributed media, blurring faces and license plates, moderation, and keeping captured and
stylized blocks visually compatible.
