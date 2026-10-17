// Contact heights from the same triangles that draw streets, rather than a second
// interpolation of the elevation image. Each chunk owns and drops its small spatial grid.
const CELL = 8, STRIDE = 10;
const LAYERS = { ground: 0, grass: 1, pathGravel: 2, lot: 2, paving: 2, road: 3, sidewalk: 4, paint: 5 };

export class GroundSurface {
  static async build(meshes, budget) {
    const surface = new GroundSurface(), data = [], flags = [];
    surface.cells = new Map();
    for (const mesh of meshes) {
      const layer = LAYERS[mesh.name];
      if (layer === undefined) continue; // water, bridge undersides, railings and piers
      const p = mesh.geometry.attributes.position, index = mesh.geometry.index;
      const count = index ? index.count : p.count;
      for (let i = 0; i < count; i += 3) {
        if (i % 3000 === 0 && budget) await budget.tick();
        const a = index ? index.getX(i) : i, b = index ? index.getX(i + 1) : i + 1, c = index ? index.getX(i + 2) : i + 2;
        const ax = p.getX(a), az = p.getZ(a), ay = p.getY(a);
        const ux = p.getX(b) - ax, uz = p.getZ(b) - az, uy = p.getY(b) - ay;
        const vx = p.getX(c) - ax, vz = p.getZ(c) - az, vy = p.getY(c) - ay;
        const det = ux * vz - uz * vx;
        if (Math.abs(det) < 1e-8) continue; // vertical curb faces have no walkable area
        const id = flags.length;
        data.push(ax, az, ay, ux, uz, uy, vx, vz, vy, 1 / det);
        flags.push(layer + (mesh.userData.deckSurface ? 16 : 0));
        const minX = Math.floor(Math.min(ax, ax + ux, ax + vx) / CELL), maxX = Math.floor(Math.max(ax, ax + ux, ax + vx) / CELL);
        const minZ = Math.floor(Math.min(az, az + uz, az + vz) / CELL), maxZ = Math.floor(Math.max(az, az + uz, az + vz) / CELL);
        for (let x = minX; x <= maxX; x++) for (let z = minZ; z <= maxZ; z++) {
          const key = `${x},${z}`;
          let cell = surface.cells.get(key);
          if (!cell) surface.cells.set(key, cell = []);
          cell.push(id);
        }
      }
    }
    surface.data = new Float32Array(data); surface.flags = new Uint8Array(flags);
    return surface;
  }

  heightAt(x, z, y = null, normal = null) {
    const cell = this.cells.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`);
    if (!cell) return null;
    const d = this.data;
    let best = null, priority = -1, hit = -1;
    for (const id of cell) {
      const flag = this.flags[id], k = id * STRIDE;
      if (flag >= 16 && y === null) continue;
      const dx = x - d[k], dz = z - d[k + 1];
      const u = (dx * d[k + 7] - dz * d[k + 6]) * d[k + 9];
      const v = (d[k + 3] * dz - d[k + 4] * dx) * d[k + 9];
      if (u < -1e-5 || v < -1e-5 || u + v > 1.00001) continue;
      const h = d[k + 2] + u * d[k + 5] + v * d[k + 8];
      if (flag >= 16 && h > y + 1.1) continue; // stay below bridges when walking underneath
      if (flag > priority || (flag === priority && h > best)) { best = h; priority = flag; hit = k; }
    }
    if (normal && hit >= 0) {
      const k = hit, gx = (d[k + 5] * d[k + 7] - d[k + 8] * d[k + 4]) * d[k + 9];
      const gz = (d[k + 3] * d[k + 8] - d[k + 6] * d[k + 5]) * d[k + 9];
      normal.set(-gx, 1, -gz).normalize();
    }
    return best;
  }
}
