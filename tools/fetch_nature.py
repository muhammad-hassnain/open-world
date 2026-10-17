#!/usr/bin/env python3
"""Prepare small, local CC0 foliage atlases and bark maps. Requires Pillow and curl.
Run manually when updating assets; no build step or runtime asset API calls.
"""
import io
import json
import subprocess
import math
import random
from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageChops

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'nature'


def get(url):
    return subprocess.check_output(['curl', '-fsSL', '--retry', '2', '-A', 'open-world-textures/1.0', url])


def maps(asset):
    manifest = json.loads(get(f'https://api.polyhaven.com/files/{asset}'))

    def read(key):
        formats = manifest[key]['1k']
        item = formats.get('png') or formats.get('jpg')
        return Image.open(io.BytesIO(get(item['url'])))
    return read


def foliage(asset, name, prefix, crop):
    read = maps(asset)
    color = read(f'{prefix}_diff').convert('RGBA')
    color.putalpha(read(f'{prefix}_alpha').convert('L'))
    color = color.crop(crop).resize((256, 512), Image.Resampling.LANCZOS)
    # Exclude the atlas's unrelated UV islands/padding around this sprig.
    if name == 'needles':
        mask = Image.new('L', color.size)
        ImageDraw.Draw(mask).polygon([(28,48),(195,48),(242,115),(240,280),(187,345),
            (170,418),(161,511),(126,511),(114,418),(81,399),(87,358),(28,302),(24,102)], fill=255)
        color.putalpha(ImageChops.multiply(color.getchannel('A'), mask))
    color.save(OUT / f'{name}.png', optimize=True)


def broadleaf():
    # This source atlas includes baked UV padding for its original tree mesh. A rectangular
    # crop would expose that padding as white shards. Isolate one photographic leaf, then
    # arrange a new, clean twig atlas with an explicit silhouette instead.
    read = maps('tree_small_02')
    leaf = read('leaves_diff').convert('RGBA').crop((35, 45, 240, 160))
    mask = Image.new('L', leaf.size)
    ImageDraw.Draw(mask).polygon([(31,15),(52,10),(71,11),(90,18),(112,35),(128,56),
        (143,78),(125,91),(101,97),(77,91),(57,78),(39,61),(29,41),(27,26)], fill=255)
    leaf.putalpha(mask)
    leaf = leaf.crop((27, 10, 144, 98)).rotate(30, expand=True, resample=Image.Resampling.BICUBIC)
    atlas = Image.new('RGBA', (512, 512))
    draw = ImageDraw.Draw(atlas)
    R = random.Random(971)
    for start, end in [((265,490),(208,45)), ((253,365),(383,95)), ((240,260),(89,102)),
                       ((259,421),(429,304)), ((254,378),(73,292))]:
        draw.line([start,end], fill=(104,103,48,255), width=4)
        dx, dy = end[0]-start[0], end[1]-start[1]
        length = math.hypot(dx,dy)
        for i in range(8):
            t = 0.22 + i * 0.095
            sx, sy = start[0]+dx*t, start[1]+dy*t
            side = -1 if i % 2 else 1
            cx, cy = sx - dy/length*side*37, sy + dx/length*side*37
            im = leaf.copy()
            if side > 0: im = im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
            im = im.rotate(side*(15+R.random()*40), expand=True, resample=Image.Resampling.BICUBIC)
            size = int(85+R.random()*28)
            im.thumbnail((size,85), Image.Resampling.LANCZOS)
            im = ImageEnhance.Brightness(im).enhance(0.88+R.random()*0.22)
            draw.line([(sx,sy),(cx,cy)], fill=(110,112,53,255), width=2)
            atlas.alpha_composite(im, (round(cx-im.width/2),round(cy-im.height/2)))
    atlas.save(OUT / 'broadleaf.png', optimize=True)


if __name__ == '__main__':
    OUT.mkdir(exist_ok=True)
    broadleaf()
    foliage('pine_tree_01', 'needles', 'twig', (0, 0, 246, 460))
    bark = maps('bark_willow')
    for key, name, size in [('Diffuse', 'bark', 1024), ('nor_gl', 'bark-normal', 512)]:
        im = bark(key).convert('RGB').resize((size, size), Image.Resampling.LANCZOS)
        im.save(OUT / f'{name}.jpg', quality=88, optimize=True)
