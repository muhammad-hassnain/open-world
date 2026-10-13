# Roadmap

The idea: an open world of the whole planet. It starts as an accurate, stylized model built from
open map data, so it can cover anywhere OpenStreetMap does, and gets more realistic wherever
people contribute real photos and video. Davis, California is the first area.

## Now: stylized downtown Davis from OpenStreetMap

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

## Next: from one neighborhood to the whole world

Today the server loads one fixed area. Getting to "anywhere" means:

1. **Tiles instead of one box.** Split the world into fixed tiles (for example web-map tiles at
   a zoom level where a tile is a few hundred meters wide), download and process OSM data per
   tile, and cache each tile on disk.
2. **Stream as you move.** Load the tiles around the player and unload far ones; build
   geometry per tile so loading a tile never stalls the game.
3. **Precision far from the origin.** Keep a local origin per tile (or move the origin with the
   player) so coordinates stay small anywhere on Earth.
4. **Data at planet scale.** The public Overpass API is fine for one town, not for the world.
   Move to OSM extracts (for example regional files) or pre-built vector tiles, processed by our
   own server.
5. **Regional rules.** Driving side, road-marking colors, sign styles, sidewalk and building
   defaults, and place-name languages differ by country; pick them from the location instead of
   assuming the US.
6. **Pick where to go.** Search for a place or pick it on a map, then spawn there.

## Later: a real-world layer from contributed captures

Status: **idea, parked.** No capture or photo pipeline exists yet. When this is picked up, the
planned first step is facade photos for a single building, then splats or meshes for a few
landmarks.

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
