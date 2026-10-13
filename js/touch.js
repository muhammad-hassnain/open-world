// Touch controls for phones and tablets: a floating joystick that appears under the thumb on the
// left half of the screen (hold it pushed all the way to lock into a sprint), drag on the right
// half to look, pinch to zoom the camera, and a Jump button. Turned on by the first touch, so
// touch-screen laptops get them too.
import { clamp } from './util.js';

const STICK_R = 52;        // px the knob can travel from the stick's center
const DEAD = 0.12;         // stick fraction ignored around the center
const WALK_ZONE = 0.55;    // up to here the stick sets walking speed; beyond it blends into a run
const LOOK_SENS = 0.006;   // radians per px dragged
const PINCH_SENS = 0.03;   // camera meters per px of pinch
const FULL = 0.9;          // stick fraction that counts as pushed all the way
const SPRINT_HOLD = 900;   // ms pushed all the way before the sprint locks in
const SPRINT_KEEP = 0.5;   // a locked sprint lasts until the stick eases back below this

export class TouchControls {
  // surface: element that receives look/stick touches (the canvas).
  // ui: { stick, knob, jump } elements.
  constructor(surface, ui) {
    this.ui = ui;
    this.enabled = false;
    this.onEnable = null;
    this.stick = null;          // { id, ox, oy, dx, dy, fullSince, sprint }
    this.looks = new Map();     // pointerId -> { x, y }
    this.pinch = 0;             // last distance between two look touches
    this.lookX = 0; this.lookY = 0; this.zoom = 0;
    this.jump = false;

    surface.addEventListener('pointerdown', (e) => this._down(e, surface));
    surface.addEventListener('pointermove', (e) => this._move(e));
    surface.addEventListener('pointerup', (e) => this._up(e));
    surface.addEventListener('pointercancel', (e) => this._up(e));
    window.addEventListener('touchstart', () => this.enable(), { passive: true });
    window.addEventListener('resize', () => this._drawStick());
    const press = (el, fn) => el.addEventListener('pointerdown', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    press(ui.jump, () => { this.jump = true; });
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    document.body.classList.add('touch');
    this._drawStick();
    if (this.onEnable) this.onEnable();
  }

  // Input for this frame; look, zoom and jump are consumed.
  read() {
    const out = { fwd: 0, right: 0, gait: 0, lookX: this.lookX, lookY: this.lookY, zoom: this.zoom, jump: this.jump };
    this.lookX = 0; this.lookY = 0; this.zoom = 0; this.jump = false;
    const s = this.stick;
    if (s) {
      const m = Math.min(1, Math.hypot(s.dx, s.dy));
      // Held all the way for a moment: lock into a sprint until the stick eases back.
      const now = performance.now();
      if (m < FULL) s.fullSince = 0; else if (!s.fullSince) s.fullSince = now;
      const sprint = m >= SPRINT_KEEP && (s.sprint || (s.fullSince > 0 && now - s.fullSince > SPRINT_HOLD));
      if (sprint !== s.sprint) { s.sprint = sprint; this.ui.stick.classList.toggle('sprint', sprint); }
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
    this._drawStick();
  }

  _down(e, surface) {
    if (e.pointerType === 'mouse') return;
    this.enable();
    e.preventDefault();  // no emulated mouse events (they would start pointer lock)
    surface.setPointerCapture(e.pointerId);
    if (e.clientX < window.innerWidth / 2 && !this.stick) {
      this.stick = { id: e.pointerId, ox: e.clientX, oy: e.clientY, dx: 0, dy: 0, fullSince: 0, sprint: false };
      this._drawStick();
    } else {
      this.looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.pinch = this._pinchDist();
    }
  }

  _move(e) {
    const s = this.stick;
    if (s && e.pointerId === s.id) {
      let dx = e.clientX - s.ox, dy = e.clientY - s.oy;
      const d = Math.hypot(dx, dy);
      if (d > STICK_R) {
        // Drag the stick along so it stays under the thumb.
        s.ox += dx * (1 - STICK_R / d); s.oy += dy * (1 - STICK_R / d);
        dx *= STICK_R / d; dy *= STICK_R / d;
      }
      s.dx = dx / STICK_R; s.dy = dy / STICK_R;
      this._drawStick();
      return;
    }
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
    if (this.stick && e.pointerId === this.stick.id) {
      this.stick = null;
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

  // Idle: a faint stick in the bottom-left corner shows where to put your thumb.
  _drawStick() {
    const s = this.stick, { stick, knob } = this.ui;
    const x = s ? s.ox : 96, y = s ? s.oy : window.innerHeight - 120;
    stick.style.transform = `translate(${x}px, ${y}px)`;
    stick.classList.toggle('active', !!s);
    if (!s) stick.classList.remove('sprint');
    knob.style.transform = s ? `translate(${s.dx * STICK_R}px, ${s.dy * STICK_R}px)` : '';
  }
}
