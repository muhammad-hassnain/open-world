#!/usr/bin/env python3
"""Optimize the CC0 Innerscene / MakeHuman locomotion collections for the browser.

Offline asset preparation only; the game has no build step or Python dependencies.
Install Pillow, numpy and meshoptimizer==0.2.30a0 in a temporary environment, then:
    python tools/prepare_people.py /path/to/downloads
Input names: openworld-{sam,maya,harper,jordan}-motions.glb.
Source links and license: assets/characters/CREDITS.md.
"""
import copy
import ctypes
import io
import json
import struct
import sys
from pathlib import Path

import meshoptimizer
import numpy as np
from PIL import Image

from pack_character import write_glb

OUT = Path(__file__).resolve().parent.parent / 'assets' / 'characters'
DTYPES = {5121: 'u1', 5123: '<u2', 5125: '<u4', 5126: '<f4'}
WIDTHS = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}
CLIPS = {'Idle_Standing': 'Idle', 'Walk_Relaxed': 'Walk', 'Jog': 'Jog', 'Run': 'Run'}

# The pinned Python wrapper omits this declaration (its simpler entry point has it).
_u32, _f32, _size = ctypes.POINTER(ctypes.c_uint), ctypes.POINTER(ctypes.c_float), ctypes.c_size_t
meshoptimizer.simplifier.lib.meshopt_simplifyWithAttributes.argtypes = [
    _u32, _u32, _size, _f32, _size, _size, _f32, _size, _f32, _size,
    ctypes.POINTER(ctypes.c_ubyte), _size, ctypes.c_float, ctypes.c_uint, _f32]
meshoptimizer.simplifier.lib.meshopt_simplifyWithAttributes.restype = _size


def prepare(path, name, low=False):
    raw = path.read_bytes()
    size = struct.unpack_from('<I', raw, 12)[0]
    g = json.loads(raw[20:20 + size])
    data = raw[28 + size:]
    views, accessors, blob = [], [], bytearray()

    def read(index):
        a = g['accessors'][index]
        v = g['bufferViews'][a['bufferView']]
        dtype, width = np.dtype(DTYPES[a['componentType']]), WIDTHS[a['type']]
        offset = v.get('byteOffset', 0) + a.get('byteOffset', 0)
        return np.ndarray((a['count'], width), dtype, data, offset,
                          strides=(v.get('byteStride', width * dtype.itemsize), dtype.itemsize)).copy()

    def add_view(b):
        blob.extend(b'\0' * (-len(blob) % 4))
        views.append({'buffer': 0, 'byteOffset': len(blob), 'byteLength': len(b)})
        blob.extend(b)
        return len(views) - 1

    def add(a, original, bounds=False):
        d = {k: v for k, v in original.items() if k not in ['min', 'max', 'byteOffset', 'bufferView', 'count']}
        d.update(bufferView=add_view(a.tobytes()), count=len(a))
        if bounds:
            d.update(min=a.min(axis=0).tolist(), max=a.max(axis=0).tolist())
        accessors.append(d)
        return len(accessors) - 1

    # Microscopic scalp strands and concealed teeth are unnecessary at gameplay distances.
    # Remove held props, because locomotion and the bicycle require free hands.
    meshes = []
    mesh_map = {}
    triangles = 0
    for i, m in enumerate(g['meshes']):
        if any(s in m.get('name', '').lower() for s in ['fine scalp', 'teeth', 'held accessory']):
            continue
        m = copy.deepcopy(m)
        for p in m['primitives']:
            attrs = {k: read(a) for k, a in p['attributes'].items()}
            indices = read(p['indices']).flatten().astype(np.uint32)
            if len(indices) > 1800:
                result = np.empty_like(indices)
                # Preserve UV boundaries and surface normals. The simplifier selects existing
                # vertices, so surviving skin weights and joints remain exactly normalized.
                detail = np.ascontiguousarray(np.concatenate([attrs['TEXCOORD_0'], attrs['NORMAL']], axis=1))
                ratio = (0.08 if low else 0.24) if m['name'] == 'base' else (0.25 if low else 0.65)
                count = meshoptimizer.simplify_with_attributes(result, indices, attrs['POSITION'], detail,
                    np.array([1, 1, .1, .1, .1], dtype=np.float32),
                    target_index_count=max(300, int(len(indices) * ratio) // 3 * 3),
                    target_error=.025 if low else .008)
                indices = result[:count]
            used, mapped = np.unique(indices, return_inverse=True)
            p['indices'] = add(mapped.astype('<u2').reshape(-1, 1), {'componentType': 5123, 'type': 'SCALAR'})
            for k, a in attrs.items():
                p['attributes'][k] = add(a[used], g['accessors'][p['attributes'][k]], k == 'POSITION')
            triangles += len(indices) // 3
        mesh_map[i] = len(meshes)
        meshes.append(m)
    g['meshes'] = meshes
    for node in g['nodes']:
        if 'mesh' in node:
            old = node.pop('mesh')
            if old in mesh_map:
                node['mesh'] = mesh_map[old]
            else:
                node.pop('skin', None)
    for skin in g['skins']:
        old = skin['inverseBindMatrices']
        skin['inverseBindMatrices'] = add(read(old), g['accessors'][old])
    animations = []
    for a in g['animations']:
        if a['name'] not in CLIPS:
            continue
        a['name'] = CLIPS[a['name']]
        for s in a['samplers']:
            for key in ['input', 'output']:
                old = s[key]
                s[key] = add(read(old), g['accessors'][old], key == 'input')
        animations.append(a)
    g['animations'] = animations
    material_ids = sorted({p['material'] for m in g['meshes'] for p in m['primitives']})
    material_map = {old: i for i, old in enumerate(material_ids)}
    g['materials'] = [g['materials'][i] for i in material_ids]
    for m in g['meshes']:
        for p in m['primitives']:
            p['material'] = material_map[p['material']]

    def texture_refs(obj):
        found = []
        if isinstance(obj, dict):
            for key, value in obj.items():
                if key.endswith('Texture') and isinstance(value, dict) and 'index' in value:
                    found.append(value)
                else:
                    found.extend(texture_refs(value))
        elif isinstance(obj, list):
            for value in obj:
                found.extend(texture_refs(value))
        return found

    refs = texture_refs(g['materials'])
    texture_ids = sorted({ref['index'] for ref in refs})
    texture_map = {old: i for i, old in enumerate(texture_ids)}
    g['textures'] = [g['textures'][i] for i in texture_ids]
    for ref in refs:
        ref['index'] = texture_map[ref['index']]
    image_ids = sorted({t['source'] for t in g['textures']})
    image_map = {old: i for i, old in enumerate(image_ids)}
    for t in g['textures']:
        t['source'] = image_map[t['source']]
    # Texture files are shared by the near and distant meshes, and fetched only once.
    images = []
    for i in image_ids:
        image = g['images'][i]
        v = g['bufferViews'][image['bufferView']]
        im = Image.open(io.BytesIO(data[v.get('byteOffset', 0):v.get('byteOffset', 0) + v['byteLength']]))
        alpha = 'A' in im.getbands() and im.getchannel('A').getextrema()[0] < 255
        limit = 1024 if 'diffuse' in image.get('name', '') and 'skin' in image.get('name', '') else 512
        im.thumbnail((limit, limit), Image.Resampling.LANCZOS)
        ext = 'png' if alpha else 'jpg'
        uri = f'{name}-{i}.{ext}'
        if not low:
            im.convert('RGBA' if alpha else 'RGB').save(OUT / uri, optimize=True, **({} if alpha else {'quality': 88}))
        images.append({'uri': uri, 'name': image.get('name', '')})
    g['images'] = images
    g['bufferViews'], g['accessors'], g['buffers'] = views, accessors, [{'byteLength': len(blob)}]
    g['asset']['copyright'] = 'Innerscene / MakeHuman Community, CC0; optimized for Open World. See CREDITS.md.'
    dest = OUT / f'{name}{"-lod" if low else ""}.glb'
    length = write_glb(dest, g, bytes(blob))
    print(f'{dest.name}: {triangles:,} triangles, {length / 1024:.0f} KiB')


if __name__ == '__main__':
    source = Path(sys.argv[1])
    for name in ['sam', 'maya', 'harper', 'jordan']:
        for low in [False, True]:
            prepare(source / f'openworld-{name}-motions.glb', name, low)
