// Other players. A WebSocket to the relay (relay/, one room per zoom-6 map tile) shares each
// player's name, look and position as lat/lon, so it works even though everyone walked in at a
// different spot (each has their own Frame). Other players are drawn as Characters with name tags.
import * as THREE from 'three';
import { Character } from './character.js';
import { Vehicle, carsLoaded } from './vehicles.js';
import { damp, angleDelta } from './util.js';

// The deployed relay; ?relay=ws://localhost:8787 points a page at a local `wrangler dev`.
const RELAY = new URLSearchParams(location.search).get('relay') || 'wss://open-world-relay.m-hassnain-gee.workers.dev';
const ROOM_ZOOM = 6;        // one room per zoom-6 tile (about 600 km)
const SEND_MS = 200;        // at most 5 updates a second while moving
const HEARTBEAT_MS = 2000;  // and one every 2 s when standing still
const TIMEOUT_MS = 6000;    // a player not heard from for this long has gone
const DRAW_RANGE = 700;     // meters: farther players aren't drawn (their area isn't loaded)
const TAG_RANGE = 90;       // meters: name tags closer than this
const SNAP = 25;            // meters: jump instead of gliding when a player teleports

function roomOf(lat, lon) {
  const n = 2 ** ROOM_ZOOM, r = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n);
  return `${ROOM_ZOOM}-${x}-${y}`;
}

export class Multiplayer {
  // tags: element for name tags; onChange(status, count) is called when either changes.
  constructor({ scene, camera, tags, onChange }) {
    Object.assign(this, { scene, camera, tags, onChange });
    this.peers = new Map();   // id -> { char, tag, name, look, x, z, tx, tz, yaw, tyaw, s, a, seen }
    this.ws = null;
    this.room = null;
    this.status = 'off';      // 'off' | 'connecting' | 'online' | 'offline'
    this.wanted = false;
    this.profile = { name: '', look: 'man' };
    this.frame = null; this.world = null;
    this.last = { t: 0, x: 0, z: 0, yaw: 0, s: 0, a: 0, v: '' };
    this.retry = 1000;
    this._v = new THREE.Vector3();
  }

  get count() { return this.peers.size; }

  // A new street world (new frame): everyone is re-placed from their next update.
  setWorld(frame, world) {
    this.frame = frame; this.world = world;
    this.clearPeers();
    this.last.t = 0;
  }

  setProfile(name, look) {
    this.profile = { name, look };
    this._send({ t: 'p', name, look });
  }

  setOnline(on) {
    this.wanted = on;
    if (!on) { this._close(); this._status('off'); }
    else this.last.t = 0;  // connect on the next update
  }

  // Every frame: keep the connection in the right room, send our state, move the others.
  update(dt, player) {
    const now = performance.now();
    if (this.wanted && this.frame && player) {
      const p = player.pos;
      const [lat, lon] = this.frame.toLatLon(p.x, p.z);
      const room = roomOf(lat, lon);
      if (room !== this.room || !this.ws) this._connect(room);
      const veh = player.vehicle;
      const a = veh ? 0 : Math.max(0, p.y - this.world.groundAt(p.x, p.z, p.y));
      const v = veh ? veh.code : '', s = veh ? veh.speed : player.speed;  // vehicles send signed speed
      const L = this.last;
      const moved = Math.hypot(p.x - L.x, p.z - L.z) > 0.15 || Math.abs(angleDelta(L.yaw, player.yaw)) > 0.05
        || Math.abs(s - L.s) > 0.3 || a > 0.05 || L.a > 0.05;
      if (this.ws && this.ws.readyState === 1 && ((moved && now - L.t >= SEND_MS) || now - L.t >= HEARTBEAT_MS || v !== L.v)) {
        this._send({ t: 's', la: +lat.toFixed(7), lo: +lon.toFixed(7), y: +player.yaw.toFixed(3), s: +s.toFixed(2), a: +a.toFixed(2), v });
        Object.assign(L, { t: now, x: p.x, z: p.z, yaw: player.yaw, s, a, v });
      }
    }
    this._movePeers(dt, now, player);
  }

  // Positions of the others, for the minimap.
  positions() { return [...this.peers.values()].map((o) => ({ x: o.x, z: o.z })); }

  clearPeers() {
    for (const id of [...this.peers.keys()]) this._drop(id);
  }

  _connect(room) {
    this._close();
    this.room = room;
    this._status('connecting');
    let ws;
    try { ws = new WebSocket(`${RELAY}/room/${room}`); } catch { this._status('offline'); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 1000;
      this._status('online');
      this._send({ t: 'p', ...this.profile });
      this.last.t = 0;  // send our state right away
    };
    ws.onmessage = (e) => this._receive(e.data);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.clearPeers();
      if (!this.wanted) return;
      this._status('offline');
      // Try again, waiting longer each time (up to 30 s).
      clearTimeout(this._timer);
      this._timer = setTimeout(() => { if (this.wanted && !this.ws) this._connect(this.room); }, this.retry);
      this.retry = Math.min(30000, this.retry * 2);
    };
  }

  _close() {
    clearTimeout(this._timer);
    const ws = this.ws;
    this.ws = null;
    this.room = null;
    if (ws) { ws.onclose = null; try { ws.close(); } catch { /* already closed */ } }
    this.clearPeers();
  }

  _send(m) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  _status(s) {
    if (s === this.status) return;
    this.status = s;
    if (this.onChange) this.onChange(s, this.count);
  }

  _receive(data) {
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'x') { this._drop(m.id); return; }
    if (m.t !== 's' || !this.frame || typeof m.id !== 'string') return;
    const [tx, tz] = this.frame.toLocal(m.la, m.lo);
    let o = this.peers.get(m.id);
    if (!o) {
      const tag = document.createElement('div');
      tag.className = 'ptag';
      o = { char: new Character(m.l), tag, name: null, look: m.l, x: tx, z: tz, yaw: m.y };
      this.scene.add(o.char.root);
      this.tags.appendChild(tag);
      this.peers.set(m.id, o);
      if (this.onChange) this.onChange(this.status, this.count);
    }
    if (m.l !== o.look) { o.look = m.l; o.char.setLook(m.l); }
    if (m.n !== o.name) { o.name = m.n; o.tag.textContent = m.n; }
    if (Math.hypot(tx - o.x, tz - o.z) > SNAP) { o.x = tx; o.z = tz; }
    Object.assign(o, { tx, tz, tyaw: m.y, s: m.s || 0, a: m.a || 0, seen: performance.now() });
    this._ride(o, typeof m.v === 'string' ? m.v : '');
  }

  // Show a peer in their car or on their bike (or on foot).
  _ride(o, v) {
    if (v.startsWith('car:') && !carsLoaded()) v = '';
    if (v === (o.v || '')) return;
    o.v = v;
    if (o.vehicle) { this.scene.remove(o.vehicle.root); o.vehicle.dispose(); o.vehicle = null; }
    const root = o.char.root;
    if (!v) { this.scene.add(root); o.char.setSeat(null); return; }
    o.vehicle = new Vehicle(v === 'bike' ? 'bike' : 'car', v.slice(4), { color: '#2f7fc1' });
    this.scene.add(o.vehicle.root);
    if (v === 'bike') {
      o.vehicle.tilt.add(root);
      root.position.set(0, 0, 0.18);
      root.rotation.set(0, 0, 0);
      o.char.setSeat('bike');
    } else {
      o.char.setSeat('car');
    }
  }

  _drop(id) {
    const o = this.peers.get(id);
    if (!o) return;
    if (o.vehicle) { this.scene.remove(o.vehicle.root); o.vehicle.dispose(); }
    this.scene.remove(o.char.root);
    o.char.dispose?.();
    o.tag.remove();
    this.peers.delete(id);
    if (this.onChange) this.onChange(this.status, this.count);
  }

  _movePeers(dt, now, player) {
    const cam = this.camera, W = window.innerWidth, H = window.innerHeight, v = this._v;
    for (const [id, o] of this.peers) {
      if (now - o.seen > TIMEOUT_MS) { this._drop(id); continue; }
      // Vehicles move several meters between updates: aim where they should be by now.
      let tx = o.tx, tz = o.tz;
      if (o.vehicle) {
        const ahead = o.s * Math.min(0.6, (now - o.seen) / 1000);
        tx -= Math.sin(o.tyaw) * ahead; tz -= Math.cos(o.tyaw) * ahead;
      }
      o.x = damp(o.x, tx, 8, dt);
      o.z = damp(o.z, tz, 8, dt);
      o.yaw += angleDelta(o.yaw, o.tyaw) * (1 - Math.exp(-10 * dt));
      const far = player ? Math.hypot(o.x - player.pos.x, o.z - player.pos.z) : 0;
      const root = o.vehicle ? o.vehicle.root : o.char.root;
      root.visible = far < DRAW_RANGE;
      if (!root.visible) { o.tag.style.display = 'none'; continue; }
      const y = (this.world ? this.world.groundAt(o.x, o.z, o.y ?? null) : 0) + o.a;
      o.y = y - o.a;
      if (o.vehicle) {
        o.vehicle.follow(o.x, o.z, y, o.yaw, o.s, dt);
        o.char.root.visible = o.v === 'bike';
        o.char.update(dt, Math.abs(o.s), false);
      } else {
        root.position.set(o.x, y, o.z);
        root.rotation.y = o.yaw;
        o.char.update(dt, o.s, o.a > 0.05);
      }
      // Name tag above the head.
      v.set(o.x, y + 2.05, o.z).project(cam);
      const d = cam.position.distanceTo(root.position);
      if (v.z > 1 || d > TAG_RANGE) { o.tag.style.display = 'none'; continue; }
      o.tag.style.display = '';
      o.tag.style.transform = `translate(-50%, -100%) translate(${((v.x + 1) / 2) * W}px, ${((1 - v.y) / 2) * H}px)`;
    }
  }
}
