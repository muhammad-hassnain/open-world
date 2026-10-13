import { CATS } from './labels.js';
import { resample } from './util.js';

const AREA_COLORS = {
  grass: '#9bd17d', wood: '#86b96b', pitch: '#8fc870', track: '#d08a6a', playground: '#ecdcb0',
  sand: '#eedfae', farm: '#e0d197', water: '#86c8e8', parking: '#c9cbcf', plaza: '#e7e1d4',
};
const S = 2; // pre-render pixels per meter

export class MiniMap {
  constructor(world, labels, mini, full) {
    this.world = world;
    this.labels = labels;
    this.mini = mini;
    this.full = full;
    const c = world.core, m = 40;
    this.x0 = c.minX - m; this.z0 = c.minZ - m;
    this.w = c.maxX - c.minX + 2 * m; this.h = c.maxZ - c.minZ + 2 * m;
    this.pre = this._prerender();
    this.fullOpen = false;
  }

  _prerender() {
    const w = this.world;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(this.w * S); cv.height = Math.ceil(this.h * S);
    const ctx = cv.getContext('2d');
    const X = (x) => (x - this.x0) * S, Z = (z) => (z - this.z0) * S;
    const poly = (ring) => { ctx.beginPath(); ring.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Z(p[1])) : ctx.moveTo(X(p[0]), Z(p[1])))); ctx.closePath(); };
    const line = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p[0]), Z(p[1])) : ctx.moveTo(X(p[0]), Z(p[1])))); };

    ctx.fillStyle = '#b4d39a';
    ctx.fillRect(0, 0, cv.width, cv.height);
    for (const a of w.areas) {
      if (!AREA_COLORS[a.k]) continue;
      ctx.fillStyle = AREA_COLORS[a.k];
      poly(a.o); ctx.fill();
    }
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const r of w.roads) {
      if (r.kind === 'path' || r.kind === 'sidewalk') {
        ctx.strokeStyle = r.t === 'cycleway' ? '#9aa0a8' : '#efe9dc';
        ctx.lineWidth = Math.max(1.5, r.hw * 2 * S);
        line(r.p); ctx.stroke();
      }
    }
    for (const pass of ['casing', 'fill']) {
      for (const r of w.roads) {
        if (r.kind !== 'car' && r.kind !== 'service') continue;
        ctx.strokeStyle = pass === 'casing' ? '#8b8f96' : r.kind === 'car' ? '#ffffff' : '#f3f1ec';
        ctx.lineWidth = r.hw * 2 * S + (pass === 'casing' ? 3 : 0);
        line(r.p); ctx.stroke();
      }
    }
    for (const b of w.buildings) {
      ctx.fillStyle = b.style === 'house' ? '#e9dfcf' : b.style === 'shopfront' ? '#e8cdb6' : '#dcd6cc';
      poly(b.outer); ctx.fill();
      ctx.strokeStyle = '#b6ab9a'; ctx.lineWidth = 1; ctx.stroke();
    }
    return cv;
  }

  drawMini(px, pz, camYaw, yaw) {
    const cv = this.mini, ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height, R = W / 2;
    const k = (W / 2) / (90 * S); // show ~90 m radius
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.arc(R, R, R, 0, Math.PI * 2); ctx.clip();
    ctx.fillStyle = '#b4d39a'; ctx.fillRect(0, 0, W, H);
    ctx.translate(R, R);
    ctx.rotate(camYaw);
    ctx.scale(k, k);
    ctx.drawImage(this.pre, -(px - this.x0) * S, -(pz - this.z0) * S);
    for (const it of this.labels.items) {
      const dx = (it.x - px) * S, dz = (it.z - pz) * S;
      if (Math.abs(dx) > 200 * S || Math.abs(dz) > 200 * S) continue;
      ctx.fillStyle = (CATS[it.cat] || CATS.service).color;
      ctx.beginPath(); ctx.arc(dx, dz, 2.6 / k, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    this._arrow(ctx, R, R, camYaw - yaw, 9);
    const nx = R + Math.sin(camYaw) * (R - 12), ny = R - Math.cos(camYaw) * (R - 12);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath(); ctx.arc(nx, ny, 9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('N', nx, ny + 0.5);
  }

  _arrow(ctx, x, y, angle, size) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(angle);
    ctx.fillStyle = '#ff7a45'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, -size); ctx.lineTo(size * 0.75, size * 0.8); ctx.lineTo(0, size * 0.35); ctx.lineTo(-size * 0.75, size * 0.8); ctx.closePath();
    ctx.fill(); ctx.stroke();
    ctx.restore();
  }

  // Full-screen map: returns a function mapping screen click -> world point.
  drawFull(px, pz, yaw) {
    const cv = this.full, ctx = cv.getContext('2d');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.clientWidth * dpr; cv.height = cv.clientHeight * dpr;
    const W = cv.width, H = cv.height;
    const fit = Math.min(W / this.pre.width, H / this.pre.height) * 0.94;
    const ox = (W - this.pre.width * fit) / 2, oy = (H - this.pre.height * fit) / 2;
    ctx.fillStyle = '#1b2128'; ctx.fillRect(0, 0, W, H);
    ctx.drawImage(this.pre, ox, oy, this.pre.width * fit, this.pre.height * fit);
    const sx = (x) => ox + (x - this.x0) * S * fit, sz = (z) => oy + (z - this.z0) * S * fit;

    // Street names along the longest segment of each street.
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `600 ${Math.round(11 * dpr)}px system-ui`;
    const done = new Set();
    for (const r of this.world.carRoads) {
      if (!r.n || done.has(r.n)) continue;
      const same = this.world.carRoads.filter((q) => q.n === r.n);
      const pts = same.flatMap((q) => resample(q.p, 60)).filter((p) => this.world.inCore(p.x, p.z, 25));
      if (!pts.length) continue;
      done.add(r.n);
      for (const p of pts.filter((_, i) => i % 3 === 1 || pts.length < 3).slice(0, 3)) {
        let ang = Math.atan2(p.tz, p.tx);
        if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
        ctx.save(); ctx.translate(sx(p.x), sz(p.z)); ctx.rotate(ang);
        ctx.lineWidth = 3 * dpr; ctx.strokeStyle = '#ffffff'; ctx.strokeText(r.n, 0, 0);
        ctx.fillStyle = '#3a3f46'; ctx.fillText(r.n, 0, 0);
        ctx.restore();
      }
    }
    for (const it of this.labels.items) {
      ctx.fillStyle = (CATS[it.cat] || CATS.service).color;
      ctx.beginPath(); ctx.arc(sx(it.x), sz(it.z), 3.5 * dpr, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 1 * dpr; ctx.stroke();
    }
    this._arrow(ctx, sx(px), sz(pz), -yaw, 11 * dpr);
    return (clientX, clientY) => {
      const rect = cv.getBoundingClientRect();
      const X = (clientX - rect.left) * dpr, Y = (clientY - rect.top) * dpr;
      return { x: (X - ox) / (S * fit) + this.x0, z: (Y - oy) / (S * fit) + this.z0 };
    };
  }
}
