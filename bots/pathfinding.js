// ============================================================
// [AI BOTS - NEAR HACKATHON] Server-side walkability + A* pathfinding.
//
// Mirrors the client's own collision rules (isWalkableTile + canStand in
// game.jsx) so a bot can never walk somewhere a human player couldn't.
// Positions are in WORLD PIXELS, top-left corner of the player sprite -
// exactly the same {x, y} the clients send in playerMove.
// ============================================================
const M = require("./mapData");

const { GRID_W, GRID_H, TILE, PLAYER_SIZE, GATES } = M;

const GRID_ROWS = [];
for (let r = 0; r < GRID_H; r++) GRID_ROWS.push(M.GRID.slice(r * GRID_W, (r + 1) * GRID_W));

function tileAt(tx, ty) {
  if (tx < 0 || ty < 0 || tx >= GRID_W || ty >= GRID_H) return " ";
  return GRID_ROWS[ty][tx];
}

// lockedGateIds: Set of gate ids currently locked by a sabotage (or null).
function isWalkableTile(tx, ty, lockedGateIds) {
  const c = tileAt(tx, ty);
  if (c !== "." && c !== "c" && c !== "D") return false;
  if (lockedGateIds && lockedGateIds.size) {
    for (const g of GATES) {
      if (!lockedGateIds.has(g.id)) continue;
      if (tx >= g.x && tx < g.x + g.w && ty >= g.y && ty < g.y + g.h) return false;
    }
  }
  return true;
}

// Same rule as the client's canStand(): every tile the padded player box
// overlaps must be walkable (not just its four corners - the 30px box is
// wider than a 22px tile, so corner-only checks missed thin walls).
function canStand(px, py, lockedGateIds) {
  const x1 = px - M.COLLISION_PAD_X, x2 = px + PLAYER_SIZE + M.COLLISION_PAD_X;
  const y1 = py - M.COLLISION_PAD_TOP, y2 = py + PLAYER_SIZE + M.COLLISION_PAD_BOTTOM;
  const tx1 = Math.floor(x1 / TILE), tx2 = Math.floor(x2 / TILE);
  const ty1 = Math.floor(y1 / TILE), ty2 = Math.floor(y2 / TILE);
  for (let ty = ty1; ty <= ty2; ty++) {
    for (let tx = tx1; tx <= tx2; tx++) {
      if (!isWalkableTile(tx, ty, lockedGateIds)) return false;
    }
  }
  return true;
}

// ---- Navigation grid -------------------------------------------------
// Path nodes are HALF tiles (11px): corridors are narrow relative to the
// player's padded collision box, so tile-centre-only nodes would miss
// some valid lanes. Each node's pixel position is the player's top-left
// when "standing" on that node.
const STEP = TILE / 2;
const NAV_W = GRID_W * 2;
const NAV_H = GRID_H * 2;

function nodePx(nx, ny) {
  return { x: nx * STEP + (STEP - PLAYER_SIZE / 2) - STEP / 2, y: ny * STEP + (STEP - PLAYER_SIZE / 2) - STEP / 2 };
}
function pxToNode(px, py) {
  // inverse of nodePx (nearest node)
  const off = (STEP - PLAYER_SIZE / 2) - STEP / 2;
  return { nx: Math.round((px - off) / STEP), ny: Math.round((py - off) / STEP) };
}

function buildNav(lockedGateIds) {
  const ok = new Uint8Array(NAV_W * NAV_H);
  for (let ny = 0; ny < NAV_H; ny++) {
    for (let nx = 0; nx < NAV_W; nx++) {
      const p = nodePx(nx, ny);
      if (canStand(p.x, p.y, lockedGateIds)) ok[ny * NAV_W + nx] = 1;
    }
  }
  return ok;
}

const BASE_NAV = buildNav(null);
// Cache nav grids per locked-gate combination (sabotage locks only ever
// use one of two fixed gate groups, so this stays tiny).
const navCache = new Map([["", BASE_NAV]]);
function navFor(lockedGateIds) {
  if (!lockedGateIds || !lockedGateIds.size) return BASE_NAV;
  const key = [...lockedGateIds].sort().join(",");
  if (!navCache.has(key)) navCache.set(key, buildNav(lockedGateIds));
  return navCache.get(key);
}

function isOpen(nav, nx, ny) {
  return nx >= 0 && ny >= 0 && nx < NAV_W && ny < NAV_H && nav[ny * NAV_W + nx] === 1;
}

// Nearest standable node to an arbitrary pixel position (BFS outward).
function nearestOpenNode(nav, px, py, maxRadius = 12) {
  const { nx, ny } = pxToNode(px, py);
  if (isOpen(nav, nx, ny)) return { nx, ny };
  for (let r = 1; r <= maxRadius; r++) {
    let best = null, bestD = Infinity;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (!isOpen(nav, nx + dx, ny + dy)) continue;
        const d = dx * dx + dy * dy;
        if (d < bestD) { bestD = d; best = { nx: nx + dx, ny: ny + dy }; }
      }
    }
    if (best) return best;
  }
  return null;
}

// Simple binary heap for A*.
class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p].f <= a[i].f) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

const DIRS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

// Returns an array of pixel waypoints from (fromPx) to (toPx), or null if
// unreachable. Diagonal moves are only allowed when both adjacent
// straight neighbours are open, so bots never cut wall corners.
function findPath(fromPx, toPx, lockedGateIds) {
  const nav = navFor(lockedGateIds);
  const s = nearestOpenNode(nav, fromPx.x, fromPx.y);
  const g = nearestOpenNode(nav, toPx.x, toPx.y);
  if (!s || !g) return null;
  const idx = (x, y) => y * NAV_W + x;
  const goal = idx(g.nx, g.ny);
  const gScore = new Float32Array(NAV_W * NAV_H).fill(Infinity);
  const came = new Int32Array(NAV_W * NAV_H).fill(-1);
  const closed = new Uint8Array(NAV_W * NAV_H);
  const h = (x, y) => { const dx = Math.abs(x - g.nx), dy = Math.abs(y - g.ny); return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy); };
  const heap = new MinHeap();
  const start = idx(s.nx, s.ny);
  gScore[start] = 0;
  heap.push({ i: start, f: h(s.nx, s.ny) });
  while (heap.size) {
    const { i } = heap.pop();
    if (closed[i]) continue;
    if (i === goal) break;
    closed[i] = 1;
    const x = i % NAV_W, y = (i / NAV_W) | 0;
    for (const [dx, dy, cost] of DIRS) {
      const nx = x + dx, ny = y + dy;
      if (!isOpen(nav, nx, ny)) continue;
      if (dx && dy && (!isOpen(nav, x + dx, y) || !isOpen(nav, x, y + dy))) continue;
      const ni = idx(nx, ny);
      const ng = gScore[i] + cost;
      if (ng < gScore[ni]) { gScore[ni] = ng; came[ni] = i; heap.push({ i: ni, f: ng + h(nx, ny) }); }
    }
  }
  if (start !== goal && came[goal] === -1) return null;
  const nodes = [];
  for (let c = goal; c !== -1; c = came[c]) { nodes.push(c); if (c === start) break; }
  nodes.reverse();
  return simplify(nodes.map((n) => nodePx(n % NAV_W, (n / NAV_W) | 0)), lockedGateIds);
}

// Drop intermediate waypoints when a straight walk between two points is
// fully standable (sampled every 1px - coarser sampling cut thin wall corners) - gives natural straight lines
// instead of a staircase.
function straightClear(a, b, lockedGateIds) {
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.max(1, Math.ceil(d));
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    if (!canStand(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, lockedGateIds)) return false;
  }
  return true;
}
function simplify(points, lockedGateIds) {
  if (points.length <= 2) return points;
  const out = [points[0]];
  let anchor = 0;
  for (let i = 2; i < points.length; i++) {
    if (!straightClear(points[anchor], points[i], lockedGateIds)) {
      out.push(points[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

// A random standable pixel position inside a room (by room id).
function randomPointInRoom(roomId, rand = Math.random) {
  const r = M.ROOMS.find((rm) => rm.id === roomId);
  if (!r) return null;
  for (let tries = 0; tries < 60; tries++) {
    const px = (r.x + 1 + rand() * (r.w - 2)) * TILE - PLAYER_SIZE / 2;
    const py = (r.y + 1 + rand() * (r.h - 2)) * TILE - PLAYER_SIZE / 2;
    if (canStand(px, py, null)) return { x: px, y: py };
  }
  return null;
}

function roomAtPixel(px, py) {
  const tx = (px + PLAYER_SIZE / 2) / TILE;
  const ty = (py + PLAYER_SIZE / 2) / TILE;
  for (const r of M.ROOMS) if (tx >= r.x && tx < r.x + r.w && ty >= r.y && ty < r.y + r.h) return r;
  return null;
}

module.exports = { tileAt, isWalkableTile, canStand, findPath, randomPointInRoom, roomAtPixel, nearestOpenNode, navFor };
