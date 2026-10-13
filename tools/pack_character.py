#!/usr/bin/env python3
"""Pack a character .gltf (embedded buffer) into a compact .glb for the game.

Keeps only the animations the game uses and drops the data nothing references anymore.
Standard library only.

    python3 tools/pack_character.py Suit.gltf assets/characters/man.glb
    python3 tools/pack_character.py Suit.gltf out.glb --keep Idle Walk Run Wave

The characters in assets/characters/ come from Quaternius' "Ultimate Modular Men" and
"Ultimate Modular Women" packs (CC0, https://quaternius.com).
"""
import argparse
import base64
import json
import struct

KEEP = ['Idle', 'Walk', 'Run', 'Wave']


def load(path):
    g = json.load(open(path))
    buffers = []
    for b in g['buffers']:
        uri = b['uri']
        if not uri.startswith('data:'):
            raise SystemExit('only embedded (data:) buffers are supported')
        buffers.append(base64.b64decode(uri.split(',', 1)[1]))
    return g, buffers


def pack(g, buffers, keep):
    g['animations'] = [a for a in g.get('animations', []) if a['name'] in keep]
    missing = set(keep) - {a['name'] for a in g['animations']}
    if missing:
        print('warning: animations not found:', ', '.join(sorted(missing)))

    # Accessors still in use.
    used = set()
    for m in g['meshes']:
        for p in m['primitives']:
            used.update(p['attributes'].values())
            if 'indices' in p:
                used.add(p['indices'])
            for t in p.get('targets', []):
                used.update(t.values())
    for s in g.get('skins', []):
        if 'inverseBindMatrices' in s:
            used.add(s['inverseBindMatrices'])
    for a in g['animations']:
        for s in a['samplers']:
            used.update((s['input'], s['output']))

    # Copy the buffer views those accessors use into one new buffer.
    acc_map, view_map, accessors, views, blob = {}, {}, [], [], bytearray()
    for i in sorted(used):
        acc = dict(g['accessors'][i])
        v = acc.get('bufferView')
        if v is not None:
            if v not in view_map:
                view = dict(g['bufferViews'][v])
                data = buffers[view.get('buffer', 0)]
                start = view.get('byteOffset', 0)
                chunk = data[start:start + view['byteLength']]
                blob.extend(b'\0' * (-len(blob) % 4))
                view.update(buffer=0, byteOffset=len(blob))
                blob.extend(chunk)
                view_map[v] = len(views)
                views.append(view)
            acc['bufferView'] = view_map[v]
        acc_map[i] = len(accessors)
        accessors.append(acc)

    for m in g['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: acc_map[v] for k, v in p['attributes'].items()}
            if 'indices' in p:
                p['indices'] = acc_map[p['indices']]
            p['targets'] = [{k: acc_map[v] for k, v in t.items()} for t in p.get('targets', [])]
            if not p['targets']:
                del p['targets']
    for s in g.get('skins', []):
        if 'inverseBindMatrices' in s:
            s['inverseBindMatrices'] = acc_map[s['inverseBindMatrices']]
    for a in g['animations']:
        for s in a['samplers']:
            s['input'], s['output'] = acc_map[s['input']], acc_map[s['output']]

    g['accessors'], g['bufferViews'] = accessors, views
    blob.extend(b'\0' * (-len(blob) % 4))
    g['buffers'] = [{'byteLength': len(blob)}]
    return g, bytes(blob)


def write_glb(path, g, blob):
    js = json.dumps(g, separators=(',', ':')).encode()
    js += b' ' * (-len(js) % 4)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, 'wb') as f:
        f.write(struct.pack('<III', 0x46546C67, 2, total))
        f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(blob), 0x004E4942)); f.write(blob)
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('src'); ap.add_argument('dst')
    ap.add_argument('--keep', nargs='+', default=KEEP, help='animation names to keep')
    a = ap.parse_args()
    g, buffers = load(a.src)
    g, blob = pack(g, buffers, set(a.keep))
    size = write_glb(a.dst, g, blob)
    print(f'{a.dst}: {size / 1024:.0f} KB, animations: {", ".join(x["name"] for x in g["animations"])}')


if __name__ == '__main__':
    main()
