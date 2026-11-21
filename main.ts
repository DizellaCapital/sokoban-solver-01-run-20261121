// Push-optimal Sokoban solver: room decomposition + push-optimal A* per room.
//
// Strategy
// --------
// The generator lays a 1-wide hallway across the board with 1-4 rooms off
// it, each room holding 3-4 boxes and as many goals, reachable through a
// single door. A box pushed out of its room can never return, so every room
// is an independent sub-problem: solve each room push-optimally from its
// door, then walk the player between doors through the hallway and
// concatenate the moves.
//
// Per room, a push-only A* runs over canonical states (sorted box positions
// + the representative of the player's walk-reachable region, which collapses
// walk-equivalent states). The heuristic is the minimum-cost matching of
// boxes to goals under exact single-box push distances (computed once per
// room by a reverse 0-1 search from each goal). That heuristic is admissible
// (each push moves one box, and no box can reach its goal in fewer pushes
// than its single-box distance), so the first solution A* pops is
// push-optimal for the room. Deadlock pruning: static dead squares (no goal
// reachable by reverse push) plus a greatest-fixed-point freeze test (a box
// whose every push is blocked by a wall or a frozen box can never move
// again). A deterministic expansion budget (counts, never the clock) bounds
// the search; if it is spent, a weighted search falls back to any valid
// solution, which still scores partial points instead of zero. No
// randomness, no wall clock: two runs write byte-identical output.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Directions: 0 up, 1 down, 2 left, 3 right.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

// Deterministic budgets, counted in state expansions (never wall-clock).
const ASTAR_CAP = 300000;
const GREEDY_CAP = 150000;
const INSTANCE_BUDGET = 500000;

type Level = {
  w: number;
  h: number;
  wall: Uint8Array;
  goal: Uint8Array;
  boxes: number[];
  player: number;
};

type Room = {
  cells: number[];
  door: number;
  entry: number;
  boxes: number[];
  goals: number[];
};

type RoomCtx = {
  w: number;
  h: number;
  goal: Uint8Array;
  inRoom: Uint8Array; // room cells + the entry hallway cell
  door: number; // -1 when the room is the whole board (no exit needed)
  entry: number;
  goals: number[];
  dist: Float64Array; // dist[cell * goals.length + g]: exact single-box push distance
  dead: Uint8Array; // dead[c]: non-goal cell no box can ever leave towards a goal
};

type Push = { box: number; dir: number };

type Budget = { used: number; cap: number };

function stepTo(c: number, d: number, w: number, h: number): number {
  const x = (c % w) + DX[d];
  const y = Math.floor(c / w) + DY[d];
  if (x < 0 || y < 0 || x >= w || y >= h) return -1;
  return y * w + x;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goal[i] = 1;
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  return { w, h, wall, goal, boxes, player };
}

// --- Decomposition ---------------------------------------------------------

function tryDecompose(lv: Level, horizontal: boolean): { rooms: Room[]; hall: Uint8Array } | null {
  const { w, h, wall, goal, boxes, player } = lv;
  const inHall = (i: number): boolean =>
    horizontal ? Math.floor(i / w) === Math.floor(player / w) : i % w === player % w;
  for (const b of boxes) if (inHall(b)) return null;
  for (let i = 0; i < w * h; i++) if (goal[i] && inHall(i)) return null;
  const boxSet = new Set(boxes);
  const hall = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) if (inHall(i) && !wall[i]) hall[i] = 1;
  const seen = new Uint8Array(w * h);
  const rooms: Room[] = [];
  for (let s = 0; s < w * h; s++) {
    if (wall[s] || inHall(s) || seen[s]) continue;
    const cells: number[] = [];
    const stack = [s];
    seen[s] = 1;
    while (stack.length > 0) {
      const c = stack.pop() as number;
      cells.push(c);
      for (let d = 0; d < 4; d++) {
        const n = stepTo(c, d, w, h);
        if (n < 0 || wall[n] || inHall(n) || seen[n]) continue;
        seen[n] = 1;
        stack.push(n);
      }
    }
    const doors = cells.filter((c) => {
      for (let d = 0; d < 4; d++) {
        const n = stepTo(c, d, w, h);
        if (n >= 0 && hall[n]) return true;
      }
      return false;
    });
    if (doors.length !== 1) return null;
    const door = doors[0];
    let entry = -1;
    for (let d = 0; d < 4; d++) {
      const n = stepTo(door, d, w, h);
      if (n >= 0 && hall[n]) {
        entry = n;
        break;
      }
    }
    if (entry < 0) return null;
    const rboxes = cells.filter((c) => boxSet.has(c));
    const rgoals = cells.filter((c) => goal[c] === 1);
    if (rboxes.length === 0 || rboxes.length !== rgoals.length) return null;
    rooms.push({ cells, door, entry, boxes: rboxes, goals: rgoals });
  }
  if (rooms.length === 0) return null;
  let total = 0;
  for (const r of rooms) total += r.boxes.length;
  if (total !== boxes.length) return null;
  // Every door's hallway cell must be walkable from the player along the hall.
  const reach = new Uint8Array(w * h);
  const q = [player];
  reach[player] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const n = stepTo(c, d, w, h);
      if (n < 0 || !hall[n] || reach[n]) continue;
      reach[n] = 1;
      q.push(n);
    }
  }
  for (const r of rooms) if (!reach[r.entry]) return null;
  return { rooms, hall };
}

function fallbackRoom(lv: Level): Room {
  const cells: number[] = [];
  for (let i = 0; i < lv.w * lv.h; i++) if (!lv.wall[i]) cells.push(i);
  return { cells, door: -1, entry: lv.player, boxes: lv.boxes.slice(), goals: cells.filter((c) => lv.goal[c] === 1) };
}

// --- Binary heap (lowest f, then lowest h, then lowest seq: deterministic) --

type HeapItem = {
  f: number;
  h: number;
  g: number;
  seq: number;
  key: string;
  boxes: number[] | null;
  rep: number;
  a: number;
  b: number;
};

class Heap {
  items: HeapItem[] = [];
  get size(): number {
    return this.items.length;
  }
  private less(x: HeapItem, y: HeapItem): boolean {
    if (x.f !== y.f) return x.f < y.f;
    if (x.h !== y.h) return x.h < y.h;
    return x.seq < y.seq;
  }
  push(it: HeapItem): void {
    const a = this.items;
    a.push(it);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      const t = a[i];
      a[i] = a[p];
      a[p] = t;
      i = p;
    }
  }
  pop(): HeapItem | undefined {
    const a = this.items;
    if (a.length === 0) return undefined;
    const top = a[0];
    const last = a.pop() as HeapItem;
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        const t = a[i];
        a[i] = a[m];
        a[m] = t;
        i = m;
      }
    }
    return top;
  }
}

// --- Single-box push distances (reverse 0-1 search from each goal) ---------

function buildDist(ctx: RoomCtx): Float64Array {
  const { w, h, inRoom, goals } = ctx;
  const n = w * h;
  const nG = goals.length;
  const dist = new Float64Array(n * nG).fill(Infinity);
  for (let g = 0; g < nG; g++) {
    const goalCell = goals[g];
    const d1 = new Float64Array(n * n).fill(Infinity);
    const heap = new Heap();
    let seq = 0;
    for (let pl = 0; pl < n; pl++) {
      if (!inRoom[pl] || pl === goalCell) continue;
      const s = goalCell * n + pl;
      d1[s] = 0;
      heap.push({ f: 0, h: 0, g: 0, seq: seq++, key: '', boxes: null, rep: 0, a: goalCell, b: pl });
    }
    while (heap.size > 0) {
      const cur = heap.pop() as HeapItem;
      const q = cur.a;
      const pl = cur.b;
      const dcur = d1[q * n + pl];
      if (cur.f !== dcur) continue;
      // Reverse walk (0 cost): the player could have come from any adjacent free cell.
      for (let dd = 0; dd < 4; dd++) {
        const pl2 = stepTo(pl, dd, w, h);
        if (pl2 < 0 || !inRoom[pl2] || pl2 === q) continue;
        const s2 = q * n + pl2;
        if (d1[s2] > dcur) {
          d1[s2] = dcur;
          heap.push({ f: dcur, h: 0, g: 0, seq: seq++, key: '', boxes: null, rep: 0, a: q, b: pl2 });
        }
      }
      // Reverse push (1 cost): the player just pushed the box into q, so the
      // player stands at the cell behind q and the box came from there.
      for (let dd = 0; dd < 4; dd++) {
        const back = stepTo(q, dd ^ 1, w, h);
        if (back !== pl) continue;
        const prevPl = stepTo(pl, dd ^ 1, w, h);
        if (prevPl < 0 || !inRoom[prevPl]) continue;
        const s2 = pl * n + prevPl;
        if (d1[s2] > dcur + 1) {
          d1[s2] = dcur + 1;
          heap.push({ f: dcur + 1, h: 0, g: 0, seq: seq++, key: '', boxes: null, rep: 0, a: pl, b: prevPl });
        }
      }
    }
    for (let b = 0; b < n; b++) {
      let best = Infinity;
      for (let pl = 0; pl < n; pl++) {
        const v = d1[b * n + pl];
        if (v < best) best = v;
      }
      dist[b * nG + g] = best;
    }
  }
  return dist;
}

function buildRoomCtx(lv: Level, room: Room): RoomCtx {
  const n = lv.w * lv.h;
  const inRoom = new Uint8Array(n);
  for (const c of room.cells) inRoom[c] = 1;
  inRoom[room.entry] = 1;
  const goals = room.goals.slice().sort((a, b) => a - b);
  const ctx: RoomCtx = {
    w: lv.w,
    h: lv.h,
    goal: lv.goal,
    inRoom,
    door: room.door,
    entry: room.entry,
    goals,
    dist: new Float64Array(0),
    dead: new Uint8Array(n),
  };
  ctx.dist = buildDist(ctx);
  for (let c = 0; c < n; c++) {
    if (!inRoom[c] || ctx.goal[c]) continue;
    let ok = false;
    for (let g = 0; g < goals.length; g++) {
      if (ctx.dist[c * goals.length + g] < Infinity) {
        ok = true;
        break;
      }
    }
    if (!ok) ctx.dead[c] = 1;
  }
  return ctx;
}

// --- Regions, heuristic, deadlock ------------------------------------------

function computeRegion(start: number, boxes: number[], ctx: RoomCtx): { mask: Uint8Array; rep: number } {
  const { w, h, inRoom } = ctx;
  const occ = new Uint8Array(w * h);
  for (const b of boxes) occ[b] = 1;
  const mask = new Uint8Array(w * h);
  let rep = start;
  if (occ[start]) return { mask, rep };
  const q = [start];
  mask[start] = 1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c < rep) rep = c;
    for (let d = 0; d < 4; d++) {
      const nn = stepTo(c, d, w, h);
      if (nn < 0 || !inRoom[nn] || occ[nn] || mask[nn]) continue;
      mask[nn] = 1;
      q.push(nn);
    }
  }
  return { mask, rep };
}

function nextPerm(a: number[]): boolean {
  let i = a.length - 2;
  while (i >= 0 && a[i] >= a[i + 1]) i--;
  if (i < 0) return false;
  let j = a.length - 1;
  while (a[j] <= a[i]) j--;
  const t = a[i];
  a[i] = a[j];
  a[j] = t;
  for (let l = i + 1, r = a.length - 1; l < r; l++, r--) {
    const u = a[l];
    a[l] = a[r];
    a[r] = u;
  }
  return true;
}

// Minimum-cost matching of boxes to goals under single-box push distances.
// Admissible: each push moves one box, and no box can reach its assigned
// goal in fewer pushes than its single-box distance.
function heuristic(boxes: number[], ctx: RoomCtx): number {
  const n = boxes.length;
  const nG = ctx.goals.length;
  if (n !== nG) return Infinity;
  if (n <= 6) {
    const perm: number[] = [];
    for (let i = 0; i < n; i++) perm.push(i);
    let best = Infinity;
    for (;;) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = ctx.dist[boxes[i] * nG + perm[i]];
        if (d === Infinity) {
          s = Infinity;
          break;
        }
        s += d;
      }
      if (s < best) best = s;
      if (best === 0) return 0;
      if (!nextPerm(perm)) break;
    }
    return best;
  }
  let s = 0;
  for (let i = 0; i < n; i++) {
    let m = Infinity;
    for (let g = 0; g < nG; g++) {
      const d = ctx.dist[boxes[i] * nG + g];
      if (d < m) m = d;
    }
    if (m === Infinity) return Infinity;
    s += m;
  }
  return s;
}

// Greatest-fixed-point freeze test: start by assuming every box frozen, then
// unfreeze any box with a push that is not blocked by a wall or a frozen
// box (a push whose destination or required player cell holds a movable box
// may become possible later, so it does not count as blocked). A box left
// frozen can never move in any future state: consider the first frozen box
// that ever moves -- its push would need a destination and a player cell
// free of walls and frozen boxes, which its frozen status rules out.
// Returns true when a frozen box sits off a goal: a dead state.
function frozenOffGoal(boxes: number[], ctx: RoomCtx): boolean {
  const { w, h, inRoom, goal } = ctx;
  const n = boxes.length;
  const at = new Map<number, number>();
  for (let i = 0; i < n; i++) at.set(boxes[i], i);
  const frozen = new Uint8Array(n).fill(1);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < n; i++) {
      if (!frozen[i]) continue;
      const b = boxes[i];
      let canMove = false;
      for (let d = 0; d < 4 && !canMove; d++) {
        const dest = stepTo(b, d, w, h);
        const pc = stepTo(b, d ^ 1, w, h);
        const destBlocked =
          dest < 0 || !inRoom[dest] || (at.has(dest) && frozen[at.get(dest) as number] === 1);
        const pcBlocked =
          pc < 0 || !inRoom[pc] || (at.has(pc) && frozen[at.get(pc) as number] === 1);
        if (!destBlocked && !pcBlocked) canMove = true;
      }
      if (canMove) {
        frozen[i] = 0;
        changed = true;
      }
    }
  }
  for (let i = 0; i < n; i++) if (frozen[i] && !goal[boxes[i]]) return true;
  return false;
}

// --- Push-optimal A* per room ----------------------------------------------

function stateKey(boxes: number[], rep: number): string {
  return boxes.join(',') + '|' + rep;
}

function allOnGoals(boxes: number[], ctx: RoomCtx): boolean {
  for (const b of boxes) if (!ctx.goal[b]) return false;
  return true;
}

type SearchResult = { status: 'solved' | 'exhausted' | 'capped'; pushes: Push[] | null };

function searchRoom(
  ctx: RoomCtx,
  startBoxes: number[],
  startRep: number,
  requireExit: boolean,
  weight: number,
  cap: number,
  budget: Budget,
): SearchResult {
  const { w, h, inRoom } = ctx;
  const startKey = stateKey(startBoxes, startRep);
  const startH = heuristic(startBoxes, ctx);
  if (startH === Infinity) return { status: 'exhausted', pushes: null };
  if (allOnGoals(startBoxes, ctx)) {
    if (!requireExit || ctx.door < 0) return { status: 'solved', pushes: [] };
    const reg = computeRegion(startRep, startBoxes, ctx);
    if (reg.mask[ctx.door]) return { status: 'solved', pushes: [] };
  }
  const bestG = new Map<string, number>();
  const parent = new Map<string, { prev: string; box: number; dir: number }>();
  const heap = new Heap();
  let seq = 0;
  bestG.set(startKey, 0);
  heap.push({ f: weight * startH, h: startH, g: 0, seq: seq++, key: startKey, boxes: startBoxes, rep: startRep, a: 0, b: 0 });
  let expanded = 0;
  while (heap.size > 0) {
    const cur = heap.pop() as HeapItem;
    const curG = bestG.get(cur.key);
    if (curG === undefined || cur.g !== curG) continue;
    if (expanded >= cap || budget.used >= budget.cap) return { status: 'capped', pushes: null };
    expanded++;
    budget.used++;
    const boxes = cur.boxes as number[];
    if (allOnGoals(boxes, ctx)) {
      if (!requireExit || ctx.door < 0) {
        return { status: 'solved', pushes: reconstruct(cur.key, parent) };
      }
      const reg = computeRegion(cur.rep, boxes, ctx);
      if (reg.mask[ctx.door]) return { status: 'solved', pushes: reconstruct(cur.key, parent) };
      // Solved but the player cannot leave: keep searching (a box may have
      // to move off a goal and back to open the way out). Do not expand
      // further here only if no push can help -- expansion is still correct,
      // so fall through to it.
    }
    const region = computeRegion(cur.rep, boxes, ctx).mask;
    const occ = new Uint8Array(w * h);
    for (const b of boxes) occ[b] = 1;
    for (let i = 0; i < boxes.length; i++) {
      const b = boxes[i];
      for (let d = 0; d < 4; d++) {
        const dest = stepTo(b, d, w, h);
        const pp = stepTo(b, d ^ 1, w, h);
        if (dest < 0 || !inRoom[dest] || occ[dest]) continue;
        if (pp < 0 || !region[pp]) continue;
        const nb = boxes.slice();
        nb[i] = dest;
        nb.sort((x, y) => x - y);
        let deadBox = false;
        for (const c of nb) if (ctx.dead[c]) {
          deadBox = true;
          break;
        }
        if (deadBox) continue;
        if (frozenOffGoal(nb, ctx)) continue;
        const hh = heuristic(nb, ctx);
        if (hh === Infinity) continue;
        const nrep = computeRegion(b, nb, ctx).rep;
        const nk = stateKey(nb, nrep);
        const ng = curG + 1;
        const prevG = bestG.get(nk);
        if (prevG !== undefined && ng >= prevG) continue;
        bestG.set(nk, ng);
        parent.set(nk, { prev: cur.key, box: b, dir: d });
        heap.push({ f: ng + weight * hh, h: hh, g: ng, seq: seq++, key: nk, boxes: nb, rep: nrep, a: 0, b: 0 });
      }
    }
  }
  return { status: 'exhausted', pushes: null };
}

function reconstruct(endKey: string, parent: Map<string, { prev: string; box: number; dir: number }>): Push[] {
  const out: Push[] = [];
  let k = endKey;
  while (parent.has(k)) {
    const p = parent.get(k) as { prev: string; box: number; dir: number };
    out.push({ box: p.box, dir: p.dir });
    k = p.prev;
  }
  out.reverse();
  return out;
}

// Solve one room both ways: with the player able to leave through the door
// afterwards (needed for every room but the last one solved), and without
// that requirement. The optimal searches run first; a capped search falls
// back to a weighted search that still returns a valid solution. Returns
// null when the room cannot be solved at all.
function solveOneRoom(
  ctx: RoomCtx,
  startBoxes: number[],
  startRep: number,
  needExit: boolean,
  budget: Budget,
): { exitPushes: Push[] | null; unPushes: Push[] } | null {
  let exitPushes: Push[] | null = null;
  if (needExit) {
    let r = searchRoom(ctx, startBoxes, startRep, true, 1, ASTAR_CAP, budget);
    if (r.status === 'solved') exitPushes = r.pushes;
    else if (r.status === 'capped') {
      r = searchRoom(ctx, startBoxes, startRep, true, 8, GREEDY_CAP, budget);
      if (r.status === 'solved') exitPushes = r.pushes;
    }
  }
  let r = searchRoom(ctx, startBoxes, startRep, false, 1, ASTAR_CAP, budget);
  if (r.status === 'solved') return { exitPushes, unPushes: r.pushes as Push[] };
  if (r.status === 'capped') {
    r = searchRoom(ctx, startBoxes, startRep, false, 8, GREEDY_CAP, budget);
    if (r.status === 'solved') return { exitPushes, unPushes: r.pushes as Push[] };
  }
  return null;
}

// --- Walking ----------------------------------------------------------------

function walkPath(from: number, to: number, allowed: Uint8Array, occ: Uint8Array, w: number, h: number): string | null {
  if (from === to) return '';
  const n = w * h;
  const prev = new Int32Array(n).fill(-2);
  const prevDir = new Int8Array(n);
  const q = [from];
  prev[from] = -1;
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    for (let d = 0; d < 4; d++) {
      const nn = stepTo(c, d, w, h);
      if (nn < 0 || !allowed[nn] || occ[nn] || prev[nn] !== -2) continue;
      prev[nn] = c;
      prevDir[nn] = d;
      if (nn === to) {
        let s = '';
        let k = to;
        while (k !== from) {
          s = CH[prevDir[k]] + s;
          k = prev[k];
        }
        return s;
      }
      q.push(nn);
    }
  }
  return null;
}

function dirChar(from: number, to: number, w: number): string {
  const dx = (to % w) - (from % w);
  const dy = Math.floor(to / w) - Math.floor(from / w);
  if (dx === 1) return 'r';
  if (dx === -1) return 'l';
  if (dy === 1) return 'd';
  return 'u';
}

// --- Whole level --------------------------------------------------------------

function solveLevel(lv: Level, budget: Budget): string {
  if (lv.boxes.length === 0) return '';
  const decomp = tryDecompose(lv, true) ?? tryDecompose(lv, false);
  const rooms: Room[] = decomp ? decomp.rooms : [fallbackRoom(lv)];
  const hall: Uint8Array | null = decomp ? decomp.hall : null;
  type SolvedRoom = { room: Room; ctx: RoomCtx; exitPushes: Push[] | null; unPushes: Push[]; mustLast: boolean };
  const solved: SolvedRoom[] = [];
  const needExit = rooms.length > 1;
  for (const room of rooms) {
    const ctx = buildRoomCtx(lv, room);
    const startBoxes = room.boxes.slice().sort((a, b) => a - b);
    const startRep = computeRegion(room.entry, startBoxes, ctx).rep;
    const one = solveOneRoom(ctx, startBoxes, startRep, needExit, budget);
    if (one === null) return '';
    solved.push({ room, ctx, exitPushes: one.exitPushes, unPushes: one.unPushes, mustLast: needExit && one.exitPushes === null });
  }
  // The last room solved needs no exit, so it goes to the room where leaving
  // costs the most pushes (or the one that cannot leave at all). Two rooms
  // that cannot leave cannot both be last: the level is not decomposable.
  if (solved.filter((s) => s.mustLast).length > 1) return '';
  let lastIdx = 0;
  let lastGap = -1;
  for (let i = 0; i < solved.length; i++) {
    const gap = solved[i].mustLast
      ? Infinity
      : solved[i].exitPushes === null
        ? 0
        : (solved[i].exitPushes as Push[]).length - solved[i].unPushes.length;
    if (gap > lastGap) {
      lastGap = gap;
      lastIdx = i;
    }
  }
  const ordered: { room: Room; ctx: RoomCtx; pushes: Push[] }[] = [];
  for (let i = 0; i < solved.length; i++) {
    if (i === lastIdx) continue;
    ordered.push({ room: solved[i].room, ctx: solved[i].ctx, pushes: solved[i].exitPushes as Push[] });
  }
  ordered.push({ room: solved[lastIdx].room, ctx: solved[lastIdx].ctx, pushes: solved[lastIdx].unPushes });
  let moves = '';
  let playerPos = lv.player;
  const occ = new Uint8Array(lv.w * lv.h);
  for (const b of lv.boxes) occ[b] = 1;
  for (let ri = 0; ri < ordered.length; ri++) {
    const s = ordered[ri];
    const last = ri === ordered.length - 1;
    const walkMask = hall ?? s.ctx.inRoom;
    const toEntry = walkPath(playerPos, s.room.entry, walkMask, occ, lv.w, lv.h);
    if (toEntry === null) return '';
    moves += toEntry;
    playerPos = s.room.entry;
    for (const p of s.pushes) {
      // The player must stand behind the box, opposite the push direction.
      const pushPos = stepTo(p.box, p.dir ^ 1, lv.w, lv.h);
      const w2 = walkPath(playerPos, pushPos, s.ctx.inRoom, occ, lv.w, lv.h);
      if (w2 === null) return '';
      moves += w2 + CH[p.dir];
      occ[p.box] = 0;
      const dest = stepTo(p.box, p.dir, lv.w, lv.h);
      occ[dest] = 1;
      playerPos = p.box;
    }
    if (!last && s.room.door >= 0) {
      const out = walkPath(playerPos, s.room.door, s.ctx.inRoom, occ, lv.w, lv.h);
      if (out === null) return '';
      moves += out;
      playerPos = s.room.door;
      moves += dirChar(s.room.door, s.room.entry, lv.w);
      playerPos = s.room.entry;
    }
  }
  return moves;
}

// --- Driver -------------------------------------------------------------------

for (const id of readdirSync(INPUT_DIR).sort()) {
  const level = parseLevel(readFileSync(join(INPUT_DIR, id, 'level.txt'), 'utf8'));
  const budget: Budget = { used: 0, cap: INSTANCE_BUDGET };
  const moves = solveLevel(level, budget);
  mkdirSync(join(OUTPUT_DIR, id), { recursive: true });
  writeFileSync(join(OUTPUT_DIR, id, 'solution.txt'), moves + '\n');
}
