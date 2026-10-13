#!/usr/bin/env python3
"""
Download the CC0 material textures the game uses and write them to assets/textures/.

Sources: Poly Haven (polyhaven.com) and ambientCG (ambientcg.com), both CC0 (public domain).
For each material we keep a color map (1024 px) and an OpenGL normal map (512 px) as JPEG.

Usage:  pip install -r tools/requirements.txt
        python3 tools/fetch_textures.py           # fetch missing textures
        python3 tools/fetch_textures.py --force   # re-fetch all
"""
import argparse
import io
import json
import tempfile
import urllib.request
import zipfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "textures"

# game name: (source, asset id)
TEXTURES = {
    "asphalt": ("polyhaven", "asphalt_02"),
    "asphalt_light": ("polyhaven", "asphalt_04"),
    "sidewalk": ("polyhaven", "concrete_pavement"),
    "paving": ("polyhaven", "rectangular_paving"),
    "grass": ("polyhaven", "grass_ground"),
    "gravel": ("polyhaven", "gravel_concrete_02"),
    "stucco": ("polyhaven", "white_stucco"),
    "siding": ("ambientcg", "WoodSiding009"),
    "brick": ("polyhaven", "red_brick_03"),
    "brick_light": ("polyhaven", "brick_wall_02"),
    "concrete": ("polyhaven", "concrete_wall_008"),
    "metal": ("polyhaven", "corrugated_iron_02"),
    "shingles": ("ambientcg", "RoofingTiles013A"),
    "clay_tiles": ("ambientcg", "RoofingTiles006"),
}
UA = {"User-Agent": "open-world-textures/1.0"}


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
        return r.read()


def polyhaven(asset):
    files = json.loads(get(f"https://api.polyhaven.com/files/{asset}"))
    pick = lambda key: get(files[key]["1k"]["jpg"]["url"])
    return pick("Diffuse"), pick("nor_gl")


def ambientcg(asset):
    data = get(f"https://ambientcg.com/get?file={asset}_1K-JPG.zip")
    with tempfile.TemporaryDirectory() as tmp, zipfile.ZipFile(io.BytesIO(data)) as z:
        names = z.namelist()
        color = next(n for n in names if n.endswith("_Color.jpg"))
        normal = next(n for n in names if n.endswith("_NormalGL.jpg"))
        return z.read(color), z.read(normal)


def save(raw, path, size):
    img = Image.open(io.BytesIO(raw)).convert("RGB")
    if img.size != (size, size):
        img = img.resize((size, size), Image.LANCZOS)
    img.save(path, "JPEG", quality=85, optimize=True, progressive=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true")
    opts = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (source, asset) in TEXTURES.items():
        color, normal = OUT / f"{name}_color.jpg", OUT / f"{name}_normal.jpg"
        if color.exists() and normal.exists() and not opts.force:
            print(f"{name}: present")
            continue
        c, n = (polyhaven if source == "polyhaven" else ambientcg)(asset)
        save(c, color, 1024)
        save(n, normal, 512)
        print(f"{name}: {source} {asset} -> {color.stat().st_size // 1024} KB + {normal.stat().st_size // 1024} KB")

    lines = ["# Texture credits", "", "All textures are CC0 (public domain). Fetched by `tools/fetch_textures.py`.", "",
             "| File | Source | Asset |", "| --- | --- | --- |"]
    for name, (source, asset) in TEXTURES.items():
        url = f"https://polyhaven.com/a/{asset}" if source == "polyhaven" else f"https://ambientcg.com/view?id={asset}"
        lines.append(f"| `{name}_*.jpg` | {'Poly Haven' if source == 'polyhaven' else 'ambientCG'} | [{asset}]({url}) |")
    (OUT / "CREDITS.md").write_text("\n".join(lines) + "\n")
    print("wrote", (OUT / "CREDITS.md").relative_to(ROOT))


if __name__ == "__main__":
    main()
