# Character credits

## Textured people

The current player and pedestrians use **CC0 1.0** character models, skin/clothing/hair maps,
and original locomotion clips by **Innerscene**, adapted from **MakeHuman/MPFB CC0 assets**.
Each source explicitly permits modification and redistribution, including commercial use.

- `sam*.glb`, `sam-*.jpg/png`: [Sam locomotion collection](https://www.innerscene.com/tools/library/3d-parts/locomotion-collection-sam-3d-person-animated-dc23800f).
- `maya*.glb`, `maya-*.jpg/png`: [Maya locomotion collection](https://www.innerscene.com/tools/library/3d-parts/locomotion-collection-maya-3d-person-animated-1499b2fd).
- `harper*.glb`, `harper-*.jpg/png`: [Harper locomotion collection](https://www.innerscene.com/tools/library/3d-parts/locomotion-collection-harper-3d-person-animated-797e1e2a).
- `jordan*.glb`, `jordan-*.jpg/png`: [Jordan locomotion collection](https://www.innerscene.com/tools/library/3d-parts/locomotion-collection-jordan-3d-person-animated-911f1584).

Sources downloaded October 17, 2026. Optimized with `tools/prepare_people.py`: reduced geometry
while preserving UV seams/skin weights, removed held props and microscopic scalp/teeth meshes,
kept idle/walk/jog/run, resized texture maps, and created lighter population meshes.
The game shares texture images and geometry between people and varies clothing tints/proportions.

[CC0 dedication](https://creativecommons.org/publicdomain/zero/1.0/).
[MakeHuman core asset license](https://static.makehumancommunity.org/makehuman/faq/are_makehuman_files_free.html).

## Original low-poly models

Retained for existing asset links; the current characters use the textured models above.

| File | Source | Author | License |
| --- | --- | --- | --- |
| `man.glb` | "Suit" from [Ultimate Modular Men Pack](https://quaternius.com/packs/ultimatemodularcharacters.html) | Quaternius | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `woman.glb` | "Suit" from [Ultimate Modular Women Pack](https://quaternius.com/packs/ultimatemodularwomen.html) | Quaternius | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

Packed from the packs' glTF files with `tools/pack_character.py`, which keeps the Idle, Walk,
Run and Wave animations, removes any weapons (the suit man's pistol) and writes a binary `.glb`.
