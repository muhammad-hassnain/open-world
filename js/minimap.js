import { CATS } from './labels.js';

const AREA_COLORS = {
  grass: '#9bd17d', wood: '#86b96b', pitch: '#8fc870', track: '#d08a6a', playground: '#ecdcb0',
  sand: '#eedfae', farm: '#e0d197', water: '#86c8e8', parking: '#c9cbcf', plaza: '#e7e1d4',
};
const S = 1.5; // pixels per meter in the per-chunk canvases
const VIEW_RADIUS = 90; // meters shown from center to edge

// Rotating minimap drawn from one small pre-rendered canvas per loaded chunk.
export class MiniMap {
  constructor(canvas) {
    this.canvas = canvas;
    this.chunks = new Map();
  }

  addChunk(ci) {
    const r = ci.rect;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.ceil((r.maxX - r.minX) * S));
    cv.height = Math.max(1, Math.ceil((r.maxZ - r.minZ) * S));
    const ctx = cv.getContext('2d');
    const X = (x) => (x - r.minX) * S, Z = (z) => (z - r.minZ) * S;
    const path = (pts, close) => {
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Z(p[1])) : ctx.moveTo(X(p[0]), Z(p[1]))));
      if (close) ctx.closePath();
    };
    ctx.fillStyle = '#b4d39a';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (const a of ci.areas) {
      if (!AREA_COLORS[a.k]) continue;
      ctx.fillStyle = AREA_COLORS[a.k];
      path(a.o, true); ctx.fill();
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const rd of ci.roads) {
      if (rd.kind !== 'path' && rd.kind !== 'sidewalk') continue;
      ctx.strokeStyle = rd.t === 'cycleway' ? '#9aa0a8' : '#efe9dc';
      ctx.lineWidth = Math.max(1.2, rd.hw * 2 * S);
      path(rd.p); ctx.stroke();
    }
    for (const pass of ['casing', 'fill']) {
      for (const rd of ci.roads) {
        if (rd.kind !== 'car' && rd.kind !== 'service') continue;
        ctx.strokeStyle = pass === 'casing' ? '#8b8f96' : rd.kind === 'car' ? '#ffffff' : '#f3f1ec';
        ctx.lineWidth = rd.hw * 2 * S + (pass === 'casing' ? 2.5 : 0);
        path(rd.p); ctx.stroke();
      }
    }
    ctx.fillStyle = '#e4dccd';
    ctx.strokeStyle = '#b6ab9a';
    ctx.lineWidth = 1;
    for (const b of ci.buildings) { path(b.outer, true); ctx.fill(); ctx.stroke(); }
    this.chunks.set(ci.key, { rect: r, canvas: cv });
  }

  removeChunk(key) { this.chunks.delete(key); }
  clear() { this.chunks.clear(); }

  // players: other players nearby, [{ x, z }].
  draw(px, pz, camYaw, yaw, places, players = []) {
    const cv = this.canvas, ctx = cv.getContext('2d');
    const W = cv.width, R = W / 2;
    const k = R / VIEW_RADIUS; // screen px per meter
    ctx.clearRect(0, 0, W, W);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#b4d39a'; ctx.fillRect(0, 0, W, W);
    ctx.translate(R, R);
    ctx.rotate(camYaw);
    const reach = VIEW_RADIUS * 1.5;
    for (const { rect, canvas } of this.chunks.values()) {
      if (rect.maxX < px - reach || rect.minX > px + reach || rect.maxZ < pz - reach || rect.minZ > pz + reach) continue;
      ctx.drawImage(canvas, (rect.minX - px) * k, (rect.minZ - pz) * k, (rect.maxX - rect.minX) * k, (rect.maxZ - rect.minZ) * k);
    }
    for (const it of places) {
      const dx = it.x - px, dz = it.z - pz;
      if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
      ctx.fillStyle = (CATS[it.cat] || CATS.service).color;
      ctx.beginPath(); ctx.arc(dx * k, dz * k, 2.6 * (W / 170), 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = '#2f7fc1'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    for (const o of players) {
      const dx = o.x - px, dz = o.z - pz;
      if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
      ctx.beginPath(); ctx.arc(dx * k, dz * k, 4.5 * (W / 170), 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    arrow(ctx, R, R, camYaw - yaw, 9 * (W / 170));
    const nx = R + Math.sin(camYaw) * (R - 12), ny = R - Math.cos(camYaw) * (R - 12);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(nx, ny, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);
  }
}

function arrow(ctx, x, y, angle, size) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(angle);
  ctx.fillStyle = '#ff7a45'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(0, -size); ctx.lineTo(size * 0.75, size * 0.8); ctx.lineTo(0, size * 0.35); ctx.lineTo(-size * 0.75, size * 0.8); ctx.closePath();
  ctx.fill(); ctx.stroke();
  ctx.restore();
}
