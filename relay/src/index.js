// Multiplayer relay for Open World. Players connect with a WebSocket to /room/<z>-<x>-<y> (the
// map tile they're in); each room is one Durable Object that passes every player's name, look and
// position on to the other players in that room within RANGE meters. Nothing is stored.
//
// Client -> relay:  { t: 'p', name, look }                 profile (name, look)
//                   { t: 's', la, lo, y, s, a, v }         state: lat, lon, yaw, speed, height above
//                                                          ground, vehicle ('', 'bike', 'car:<model>')
// Relay -> client:  { t: 'hi', id }                        your id
//                   { t: 's', id, n, l, la, lo, y, s, a, v }  another player's state (n name, l look)
//                   { t: 'x', id }                         that player left
import { DurableObject } from 'cloudflare:workers';

const RANGE = 2000;        // meters within which players see each other
const MAX_PLAYERS = 200;   // per room
const MAX_RATE = 12;       // messages per second per player; more are dropped
const MAX_LEN = 400;       // bytes per message
const NAME_MAX = 20;
const LOOKS = new Set(['man', 'woman', 'harper', 'jordan']);
const VEHICLE = /^(|bike|car:[a-z-]{1,24})$/;

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const m = url.pathname.match(/^\/room\/(\d{1,2}-\d{1,7}-\d{1,7})$/);
    if (!m) return new Response(url.pathname === '/' ? 'Open World relay\n' : 'Not found\n', { status: url.pathname === '/' ? 200 : 404 });
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket\n', { status: 426 });
    return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
  },
};

const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX) || 'Walker';
const near = (a, b) => {
  const k = Math.cos((a.la * Math.PI) / 180) * 111320;
  return Math.hypot((a.lo - b.lo) * k, (a.la - b.la) * 110540) < RANGE;
};
const stateOf = (p) => JSON.stringify({ t: 's', id: p.id, n: p.name, l: p.look, la: p.la, lo: p.lo, y: p.y, s: p.s, a: p.a, v: p.v });

export class Room extends DurableObject {
  async fetch() {
    if (this.ctx.getWebSockets().length >= MAX_PLAYERS) return new Response('Room full\n', { status: 503 });
    const [client, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);
    // Kept with the socket so it survives the object hibernating between messages.
    server.serializeAttachment({ id, name: 'Walker', look: 'man', la: null, lo: null, y: 0, s: 0, a: 0, v: '', win: 0, n: 0 });
    this.ctx.acceptWebSocket(server);
    server.send(JSON.stringify({ t: 'hi', id }));
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_LEN) return;
    const me = ws.deserializeAttachment();
    const now = Date.now();
    if (now - me.win > 1000) { me.win = now; me.n = 0; }
    if (++me.n > MAX_RATE) { ws.serializeAttachment(me); return; }
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const placed = me.la !== null;
    if (m.t === 'p') {
      me.name = cleanName(m.name);
      me.look = LOOKS.has(m.look) ? m.look : 'man';
    } else if (m.t === 's') {
      const la = num(m.la, -85, 85), lo = num(m.lo, -180, 180);
      if (la === null || lo === null) return;
      Object.assign(me, { la, lo, y: num(m.y, -10, 10) ?? 0, s: num(m.s, -15, 40) ?? 0, a: num(m.a, 0, 5) ?? 0,
        v: typeof m.v === 'string' && VEHICLE.test(m.v) ? m.v : '' });
    } else {
      return;
    }
    ws.serializeAttachment(me);
    if (me.la === null) return;

    const mine = stateOf(me);
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      const o = other.deserializeAttachment();
      if (!o || o.la === null || !near(me, o)) continue;
      try { other.send(mine); } catch { /* closing */ }
      // Just arrived: also tell this player who is already around.
      if (!placed) { try { ws.send(stateOf(o)); } catch { /* closing */ } }
    }
  }

  webSocketClose(ws) { this._left(ws); }
  webSocketError(ws) { this._left(ws); }

  _left(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    const msg = JSON.stringify({ t: 'x', id: me.id });
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) { try { other.send(msg); } catch { /* closing */ } }
    }
    try { ws.close(1000, 'bye'); } catch { /* already closed */ }
  }
}
