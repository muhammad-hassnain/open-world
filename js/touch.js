// Touch controls for phones and tablets: a joystick fixed in a bottom corner (hold it pushed all
// the way to lock into a sprint, which keeps going after you let go until you touch the stick
// again), drag anywhere else to look and steer, pinch to zoom the camera, and a Jump button in
// the other corner. The joystick can be on the left (default) or the right. Turned on by the
// first touch, so touch-screen laptops get them too.
import { clamp } from './util.js';

const STICK_X = 100;       // px from the side edge to the stick's center
const STICK_Y = 112;       // px from the bottom edge to the stick's center
const STICK_R = 52;        // px the knob can travel from the center
const ZONE = 95;           // a touch starting this close to the center grabs the stick
const DEAD = 0.12;         // stick fraction ignored around the center
const WALK_ZONE = 0.55;    // up to here the stick sets walking speed; beyond it blends into a run
const FULL = 0.9;          // stick fraction that counts as pushed all the way
const SPRINT_HOLD = 900;   // ms pushed all the way before the sprint locks in
const SPRINT_KEEP = 0.5;   // while held, a locked sprint lasts until the stick eases back below this
const LOOK_SENS = 0.006;   // radians per px dragged
const PINCH_SENS = 0.03;   // camera meters per px of pinch
const SIDE_KEY = 'openworld.stickSide';

export class TouchControls {
  // surface: element that receives stick/look touches (the canvas).
  // ui: { stick, knob, jump, sideButtons } elements; sideButtons have data-side="left|right".
  constructor(surface, ui) {
    this.ui = ui;
    this.enabled = false;
    this.onEnable = null;
    this.stick = null;          // { id, dx, dy, fullSince, sprint, auto }
    this.looks = new Map();     // pointerId -> { x, y }
    this.pinch = 0;             // last distance between two look touches
    this.lookX = 0; this.lookY = 0; this.zoom = 0;
    this.jump = false;
    this.jumpHeld = false;     // the Jump button doubles as the brake while driving
    let side = 'left';
    try { side = localStorage.getItem(SIDE_KEY) || side; } catch { /* storage unavailable */ }
    this.setSide(side, false);

    surface.addEventListener('pointerdown', (e) => this._down(e, surface));
    surface.addEventListener('pointermove', (e) => this._move(e));
    surface.addEventListener('pointerup', (e) => this._up(e));
    surface.addEventListener('pointercancel', (e) => this._up(e));
    window.addEventListener('touchstart', () => this.enable(), { passive: true });
    window.addEventListener('resize', () => this._drawStick());
    ui.jump.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.jump = true; this.jumpHeld = true; });
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) ui.jump.addEventListener(ev, () => { this.jumpHeld = false; });
    // Nitrous while driving.
    this.boostHeld = false;
    if (ui.boost) {
      ui.boost.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); this.boostHeld = true; });
      for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) ui.boost.addEventListener(ev, () => { this.boostHeld = false; });
    }
    for (const b of ui.sideButtons) b.addEventListener('click', () => this.setSide(b.dataset.side));
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add('touch');
    this._drawStick();
    if (this.onEnable) this.onEnable();
  }

  // Joystick in the bottom-left ('left') or bottom-right ('right') corner; Jump in the other.
  setSide(side, save = true) {
    this.side = side === 'right' ? 'right' : 'left';
    document.body.classList.toggle('stick-right', this.side === 'right');
    for (const b of this.ui.sideButtons) b.classList.toggle('on', b.dataset.side === this.side);
    if (save) { try { localStorage.setItem(SIDE_KEY, this.side); } catch { /* storage unavailable */ } }
    this._drawStick();
  }

  // Input for this frame; look, zoom and jump are consumed.
  read() {
    const out = { fwd: 0, right: 0, gait: 0, lookX: this.lookX, lookY: this.lookY, zoom: this.zoom, jump: this.jump, brake: this.jumpHeld, boost: this.boostHeld };
    this.lookX = 0; this.lookY = 0; this.zoom = 0; this.jump = false;
    const s = this.stick;
    if (s && s.auto) {
      // Sprint locked and thumb lifted: keep sprinting that way (steer by looking around).
      out.right = s.dx; out.fwd = -s.dy; out.gait = 2;
    } else if (s) {
      const m = Math.min(1, Math.hypot(s.dx, s.dy));
      // Held all the way for a moment: lock into a sprint.
      const now = performance.now();
      if (m < FULL) s.fullSince = 0; else if (!s.fullSince) s.fullSince = now;
      const sprint = m >= SPRINT_KEEP && (s.sprint || (s.fullSince > 0 && now - s.fullSince > SPRINT_HOLD));
      if (sprint !== s.sprint) { s.sprint = sprint; this._drawStick(); }
      if (m > DEAD) {
        const k = Math.min(1, m / WALK_ZONE) / m;
        out.right = s.dx * k;
        out.fwd = -s.dy * k;
        out.gait = s.sprint ? 2 : clamp((m - WALK_ZONE) / (FULL - WALK_ZONE), 0, 1);
      }
    }
    return out;
  }

  // Release everything (e.g. when leaving the street view).
  reset() {
    this.stick = null;
    this.looks.clear();
    this.jumpHeld = false;
    this._drawStick();
  }

  _center() {
    return { x: this.side === 'right' ? window.innerWidth - STICK_X : STICK_X, y: window.innerHeight - STICK_Y };
  }

  _down(e, surface) {
    if (e.pointerType === 'mouse') return;
    this.enable();
    e.preventDefault();  // no emulated mouse events (they would start pointer lock)
    surface.setPointerCapture(e.pointerId);
    const c = this._center();
    const onStick = Math.hypot(e.clientX - c.x, e.clientY - c.y) < ZONE;
    if (onStick && (!this.stick || this.stick.auto)) {
      // Grab the stick; touching it while a locked sprint runs on its own stops the sprint.
      this.stick = { id: e.pointerId, dx: 0, dy: 0, fullSince: 0, sprint: false, auto: false };
      this._aim(e);
    } else {
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pinch = this._pinchDist();
    }
  }

  _aim(e) {
    const c = this._center(), s = this.stick;
    let dx = (e.clientX - c.x) / STICK_R, dy = (e.clientY - c.y) / STICK_R;
    const m = Math.hypot(dx, dy);
    if (m > 1) { dx /= m; dy /= m; }
    s.dx = dx; s.dy = dy;
    this._drawStick();
  }

  _move(e) {
    if (this.stick && e.pointerId === this.stick.id) { this._aim(e); return; }
    const p = this.looks.get(e.pointerId);
    if (!p) return;
    if (this.looks.size === 1) {
      this.lookX += (e.clientX - p.x) * LOOK_SENS;
      this.lookY += (e.clientY - p.y) * LOOK_SENS;
    }
    p.x = e.clientX; p.y = e.clientY;
    if (this.looks.size === 2) {
      const d = this._pinchDist();
      this.zoom += (this.pinch - d) * PINCH_SENS;
      this.pinch = d;
    }
  }

  _up(e) {
    const s = this.stick;
    if (s && e.pointerId === s.id) {
      const m = Math.hypot(s.dx, s.dy);
      if (s.sprint && m > 0) {
        // Let go during a locked sprint: it keeps going until the stick is touched again.
        Object.assign(s, { id: null, auto: true, dx: s.dx / m, dy: s.dy / m });
      } else {
        this.stick = null;
      }
      this._drawStick();
    } else if (this.looks.delete(e.pointerId)) {
      this.pinch = this._pinchDist();
    }
  }

  _pinchDist() {
    if (this.looks.size < 2) return 0;
    const [a, b] = [...this.looks.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _drawStick() {
    const s = this.stick, { stick, knob } = this.ui, c = this._center();
    stick.style.transform = `translate(${c.x}px, ${c.y}px)`;
    stick.classList.toggle('active', !!s);
    stick.classList.toggle('sprint', !!(s && s.sprint));
    knob.style.transform = s ? `translate(${s.dx * STICK_R}px, ${s.dy * STICK_R}px)` : '';
  }
}
