// Turn-by-turn navigation. Routes come from OSRM on OpenStreetMap data (the FOSSGIS server
// that openstreetmap.org uses, falling back to the OSRM demo server): geometry, maneuvers with
// exit numbers and signposted destinations, and the lanes at each junction. The route is
// followed as you move; leaving it for a few seconds asks for a new one from where you are.

const ROUTERS = [
  'https://routing.openstreetmap.de/routed-car/route/v1/driving',
  'https://router.project-osrm.org/route/v1/driving',
];
const OFF_ROUTE_M = 45, OFF_ROUTE_S = 3, REROUTE_EVERY_S = 8, ARRIVE_M = 30;

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function fetchRoute(from, to) {
  const path = `${from[1].toFixed(6)},${from[0].toFixed(6)};${to[1].toFixed(6)},${to[0].toFixed(6)}`;
  let err = null;
  for (const base of ROUTERS) {
    try {
      const res = await fetch(`${base}/${path}?overview=full&geometries=geojson&steps=true`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (j.code !== 'Ok' || !j.routes?.length) throw new Error(j.message || j.code);
      return j.routes[0];
    } catch (e) { err = e; }
  }
  throw err;
}

// Arrow for a maneuver, as SVG: a stem from the bottom bending toward `deg` (0 ahead, 90 right).
function arrowSvg(deg, size = 44, color = 'currentColor') {
  if (deg === 'uturn') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}"><path d="M30 42V20a8 8 0 0 0-16 0v10" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/><path d="M6 27l8 9 8-9z" fill="${color}"/></svg>`;
  }
  const a = (deg * Math.PI) / 180, ex = 24 + 13 * Math.sin(a), ey = 22 - 13 * Math.cos(a);
  const cx = 24, cy = 22;
  const hx = 24 + 20 * Math.sin(a), hy = 22 - 20 * Math.cos(a);
  const px = Math.cos(a) * 8, py = Math.sin(a) * 8;
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}"><path d="M24 44V${cy} Q${cx} ${cy - 4} ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${color}" stroke-width="5" stroke-linecap="round"/>`
    + `<path d="M${hx.toFixed(1)} ${hy.toFixed(1)}L${(ex + px).toFixed(1)} ${(ey + py).toFixed(1)}L${(ex - px).toFixed(1)} ${(ey - py).toFixed(1)}z" fill="${color}"/></svg>`;
}
const ANGLE = { straight: 0, 'slight right': 35, right: 90, 'sharp right': 135, 'slight left': -35, left: -90, 'sharp left': -135, uturn: 'uturn' };
const angleOf = (m) => (m.type === 'arrive' || m.type === 'depart' ? 0 : ANGLE[m.modifier] ?? 0);

function roadName(s) {
  const ref = s.ref ? s.ref.split(';')[0].trim() : '';
  if (s.name && ref) return `${ref} · ${s.name}`;
  return s.name || ref || '';
}

function instruction(s) {
  const m = s.maneuver, name = roadName(s), mod = m.modifier || '';
  const toward = s.destinations ? ` toward ${s.destinations.split(':').pop().trim()}` : '';
  const onto = name ? ` onto ${name}` : '';
  switch (m.type) {
    case 'depart': return `Head ${['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'][Math.round(m.bearing_after / 45) % 8]}${name ? ` on ${name}` : ''}`;
    case 'arrive': return 'Arrive at your destination';
    case 'on ramp': return `Take the ramp${s.destinations ? ` to ${s.destinations}` : onto}`;
    case 'off ramp': return `Take exit${s.exits ? ` ${s.exits.split(';')[0]}` : ''}${toward || onto}`;
    case 'fork': return `Keep ${mod.includes('left') ? 'left' : mod.includes('right') ? 'right' : 'straight'}${toward || onto}`;
    case 'merge': return `Merge${onto}`;
    case 'new name': return `Continue${onto}`;
    case 'continue': return `Continue${mod && mod !== 'straight' ? ` ${mod}` : ''}${onto}`;
    case 'roundabout': case 'rotary': case 'roundabout turn':
      return `At the roundabout, take the ${m.exit ? ['', '1st', '2nd', '3rd', '4th', '5th', '6th'][m.exit] || `${m.exit}th` : ''} exit${onto}`;
    case 'end of road': return `At the end of the road, turn ${mod}${onto}`;
    default: return `${mod === 'straight' ? 'Go straight' : `Turn ${mod}`}${onto}`;
  }
}

function lanesHtml(lanes) {
  if (!lanes || lanes.length < 2 || !lanes.some((l) => l.valid) || lanes.every((l) => l.valid)) return '';
  return `<div class="nav-lanes">${lanes.map((l) => {
    const ind = l.indications.find((i) => i !== 'none') || 'straight';
    return `<span class="${l.valid ? 'on' : ''}">${arrowSvg(ANGLE[ind] ?? 0, 22)}</span>`;
  }).join('')}</div>`;
}

function fmtDist(m, miles) {
  if (miles) {
    const mi = m / 1609.34;
    if (mi < 0.1) return `${Math.max(50, Math.round((m * 3.28084) / 50) * 50)} ft`;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${Math.max(10, Math.round(m / 10) * 10)} m`;
  return `${m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}
const fmtTime = (s) => (s < 3600 ? `${Math.max(1, Math.round(s / 60))} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`);

export class Navigator {
  constructor(el) {
    this.el = el;
    this.route = null;     // { pts: [[x, z]], cum: [m], lonlat, steps, distance, duration }
    this.dest = null;      // { lat, lon, name }
    this.frame = null;
    this.onChange = null;  // called with the route's [lon, lat] line (or null) when it changes
    this.i = 0; this.off = 0; this.lastFetch = -1e9; this.t = 0; this.busy = false; this.arrived = 0;
    el.querySelector('.nav-close')?.addEventListener('click', () => this.stop());
  }

  get active() { return !!this.dest; }
  get line() { return this.route ? this.route.pts : null; }

  async start(frame, x, z, dest) {
    this.frame = frame;
    this.dest = dest;
    this.arrived = 0;
    this.route = null;
    this._show(`<div class="nav-main"><div class="nav-text"><b>Finding a route…</b><span>${esc(dest.name || '')}</span></div></div>`);
    await this._fetch(x, z);
  }

  stop() {
    this.dest = null; this.route = null; this._html = null;
    this.el.classList.add('hidden');
    this.onChange?.(null);
  }

  // A new world (frame) keeps the destination; the route is fetched again from there.
  reframe(frame, x, z) {
    if (!this.dest) return;
    this.frame = frame;
    this.route = null;
    this._fetch(x, z);
  }

  async _fetch(x, z) {
    if (this.busy || !this.dest) return;
    this.busy = true;
    this.lastFetch = this.t;
    const dest = this.dest;
    try {
      const r = await fetchRoute(this.frame.toLatLon(x, z), [dest.lat, dest.lon]);
      if (this.dest !== dest) return;
      const lonlat = r.geometry.coordinates;
      const pts = lonlat.map(([lon, lat]) => this.frame.toLocal(lat, lon));
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      // Each maneuver's position along the route.
      const steps = r.legs.flatMap((l) => l.steps);
      let j = 0;
      for (const s of steps) {
        const [mx, mz] = this.frame.toLocal(s.maneuver.location[1], s.maneuver.location[0]);
        let best = Infinity, bi = j;
        for (let k = j; k < pts.length; k++) {
          const d = Math.hypot(pts[k][0] - mx, pts[k][1] - mz);
          if (d < best) { best = d; bi = k; }
          if (d > best + 400) break;
        }
        j = bi;
        s.at = cum[bi];
      }
      this.route = { pts, cum, lonlat, steps, distance: r.distance, duration: r.duration };
      this.i = 0; this.off = 0;
      this.onChange?.(lonlat);
    } catch (e) {
      console.warn('[nav] no route', e);
      this._show(`<div class="nav-main"><div class="nav-text"><b>No route found</b><span>${esc(e.message || '')}</span></div></div>`);
    } finally {
      this.busy = false;
    }
  }

  _show(html) {
    if (html !== this._html) { this._html = html; this.el.querySelector('.nav-body').innerHTML = html; }
    this.el.classList.remove('hidden');
  }

  // Follow the route from (x, z); updates the panel.
  update(dt, x, z, miles) {
    this.t += dt;
    const R = this.route;
    if (!this.dest || !R) return;
    // Where we are along the route: nearest segment, searched near the last position.
    const n = R.pts.length;
    let best = Infinity, bi = this.i, bt = 0;
    const lo = Math.max(0, this.i - 20), hi = Math.min(n - 1, this.i + 400);
    const scan = (a, b) => {
      for (let k = a; k < b; k++) {
        const p = R.pts[k], q = R.pts[k + 1], dx = q[0] - p[0], dz = q[1] - p[1], l2 = dx * dx + dz * dz || 1e-9;
        const t = Math.max(0, Math.min(1, ((x - p[0]) * dx + (z - p[1]) * dz) / l2));
        const d = Math.hypot(p[0] + dx * t - x, p[1] + dz * t - z);
        if (d < best) { best = d; bi = k; bt = t; }
      }
    };
    scan(lo, hi);
    if (best > OFF_ROUTE_M) scan(0, n - 1);
    this.i = bi;
    const along = R.cum[bi] + (R.cum[Math.min(bi + 1, n - 1)] - R.cum[bi]) * bt;
    this.off = best > OFF_ROUTE_M ? this.off + dt : 0;
    if (this.off > OFF_ROUTE_S && this.t - this.lastFetch > REROUTE_EVERY_S) { this._fetch(x, z); }

    const left = Math.max(0, R.distance - along);
    if (left < ARRIVE_M || Math.hypot(R.pts[n - 1][0] - x, R.pts[n - 1][1] - z) < ARRIVE_M) {
      if (!this.arrived) this.arrived = this.t;
      this._show(`<div class="nav-main"><div class="nav-arrow">${arrowSvg(0)}</div><div class="nav-text"><b>You have arrived</b><span>${esc(this.dest.name || '')}</span></div></div>`);
      if (this.t - this.arrived > 6) this.stop();
      return;
    }
    // Next maneuver ahead of us (skip the departure).
    const next = R.steps.find((s) => s.at > along + 2 && s.maneuver.type !== 'depart') || R.steps[R.steps.length - 1];
    const toNext = Math.max(0, next.at - along);
    const lanes = toNext < 1500 ? next.intersections?.[0]?.lanes : null;
    const eta = (left / R.distance) * R.duration;
    const off = this.off > 0.5 ? '<div class="nav-off">Off route · rerouting…</div>' : '';
    this._show(`<div class="nav-main"><div class="nav-arrow">${arrowSvg(angleOf(next.maneuver))}<em>${fmtDist(toNext, miles)}</em></div>`
      + `<div class="nav-text"><b>${esc(instruction(next))}</b>${next.exits && next.maneuver.type === 'off ramp' ? `<span class="nav-exit">EXIT ${esc(next.exits.split(';')[0])}</span>` : ''}</div></div>`
      + lanesHtml(lanes)
      + `<div class="nav-foot">${fmtDist(left, miles)} · ${fmtTime(eta)}${this.dest.name ? ` · ${esc(this.dest.name)}` : ''}</div>${off}`);
  }
}
