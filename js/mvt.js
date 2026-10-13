// Minimal Mapbox Vector Tile (v2) decoder: protobuf wire format -> layers of features.
// Geometry stays in tile coordinates (0..extent, y down).

class Reader {
  constructor(buf) { this.b = buf; this.p = 0; }
  varint() {
    let r = 0, s = 0, byte;
    do {
      byte = this.b[this.p++];
      if (s < 28) r |= (byte & 0x7f) << s;
      else r += (byte & 0x7f) * 2 ** s;
      s += 7;
    } while (byte & 0x80);
    return r;
  }
  svarint() { const n = this.varint(); return n % 2 === 1 ? (n + 1) / -2 : n / 2; }
  bytes() { const len = this.varint(); const out = this.b.subarray(this.p, this.p + len); this.p += len; return out; }
  skip(wire) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.p += 8;
    else if (wire === 2) this.p += this.varint();
    else if (wire === 5) this.p += 4;
    else throw new Error(`mvt: unsupported wire type ${wire}`);
  }
}

const utf8 = new TextDecoder();

function readValue(buf) {
  const r = new Reader(buf);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let v = null;
  while (r.p < buf.length) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1) v = utf8.decode(r.bytes());
    else if (field === 2) { v = view.getFloat32(r.p, true); r.p += 4; }
    else if (field === 3) { v = view.getFloat64(r.p, true); r.p += 8; }
    else if (field === 4 || field === 5) v = r.varint();
    else if (field === 6) v = r.svarint();
    else if (field === 7) v = !!r.varint();
    else r.skip(wire);
  }
  return v;
}

function packed(buf) {
  const r = new Reader(buf), out = [];
  while (r.p < buf.length) out.push(r.varint());
  return out;
}

// Returns an array of parts, each an array of [x, y] points.
function decodeGeometry(cmds) {
  const parts = [];
  let cur = null, x = 0, y = 0, i = 0;
  while (i < cmds.length) {
    const c = cmds[i++], id = c & 7, count = c >> 3;
    if (id === 1 || id === 2) {
      for (let k = 0; k < count; k++) {
        const dx = cmds[i++], dy = cmds[i++];
        x += (dx >> 1) ^ -(dx & 1);
        y += (dy >> 1) ^ -(dy & 1);
        if (id === 1) { cur = []; parts.push(cur); }
        cur.push([x, y]);
      }
    } else if (id === 7) {
      if (cur && cur.length) cur.push([cur[0][0], cur[0][1]]);
    }
  }
  return parts;
}

function readFeature(buf, keys, values) {
  const r = new Reader(buf);
  const f = { id: null, type: 0, props: {}, geometry: [] };
  let tags = [], geom = [];
  while (r.p < buf.length) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1) f.id = r.varint();
    else if (field === 2) tags = packed(r.bytes());
    else if (field === 3) f.type = r.varint();
    else if (field === 4) geom = packed(r.bytes());
    else r.skip(wire);
  }
  for (let i = 0; i + 1 < tags.length; i += 2) f.props[keys[tags[i]]] = values[tags[i + 1]];
  f.geometry = decodeGeometry(geom);
  return f;
}

function readLayer(buf) {
  const r = new Reader(buf);
  const layer = { name: '', extent: 4096, features: [] };
  const keys = [], values = [], raw = [];
  while (r.p < buf.length) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 1) layer.name = utf8.decode(r.bytes());
    else if (field === 2) raw.push(r.bytes());
    else if (field === 3) keys.push(utf8.decode(r.bytes()));
    else if (field === 4) values.push(readValue(r.bytes()));
    else if (field === 5) layer.extent = r.varint();
    else r.skip(wire);
  }
  layer.features = raw.map((b) => readFeature(b, keys, values));
  return layer;
}

// Polygon parts -> [{ outer, holes }] using the MVT winding rule
// (exterior rings have positive shoelace area in tile coordinates).
export function polygons(parts) {
  const out = [];
  for (const ring of parts) {
    if (ring.length < 4) continue;
    let a = 0;
    for (let i = 0; i < ring.length - 1; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    if (a > 0) out.push({ outer: ring.slice(0, -1), holes: [] });
    else if (a < 0 && out.length) out[out.length - 1].holes.push(ring.slice(0, -1));
  }
  return out;
}

export function decodeTile(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const r = new Reader(buf);
  const layers = {};
  while (r.p < buf.length) {
    const tag = r.varint(), field = tag >> 3, wire = tag & 7;
    if (field === 3) { const l = readLayer(r.bytes()); layers[l.name] = l; }
    else r.skip(wire);
  }
  return layers;
}
