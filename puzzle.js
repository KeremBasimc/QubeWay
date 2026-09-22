/* =========================================
   QubeWay — Puzzle model & level generator
   =========================================
   The cube surface is a lattice in "doubled" integer coordinates:
   the cube spans [0, 2N] on every axis, and each surface cell centre has
   one coordinate equal to 0 or 2N (its face) and the other two odd.
   A cell is { p: [x,y,z], n: [nx,ny,nz] } where n is the outward normal.

   An arrow is a chain of adjacent surface cells (tail → head). Paths may
   wrap over cube edges onto neighbouring faces. The head points in `dir`;
   when tapped, the arrow slides forward along its own path and leaves the
   cube over the edge of the head's face — but only if every cell between
   the head and that edge is empty. Otherwise it bumps into the blocker.
*/

export function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const key = (p) => p[0] + ',' + p[1] + ',' + p[2];

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const neg = (a) => [-a[0], -a[1], -a[2]];
const axisOf = (d) => (d[0] !== 0 ? 0 : d[1] !== 0 ? 1 : 2);

const AXES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// The four in-plane directions for a face with normal n
export function tangents(n) {
    return AXES.filter((d) => axisOf(d) !== axisOf(n));
}

// Move one cell in direction d, wrapping over cube edges.
// Returns the new cell plus the travel direction at that cell.
export function stepWrap(cell, d, N) {
    const q = add(cell.p, scale(d, 2));
    const a = axisOf(d);
    if (q[a] > 0 && q[a] < 2 * N) return { p: q, n: cell.n, d, wrapped: false };
    // Crossed an edge: land on the neighbouring face
    return { p: add(add(cell.p, d), neg(cell.n)), n: d, d: neg(cell.n), wrapped: true };
}

// Cells from the head (exclusive) to the edge of the head's face, in dir d
export function rayCells(cell, d, N) {
    const out = [];
    let cur = cell;
    for (;;) {
        const s = stepWrap(cur, d, N);
        if (s.wrapped) return out;
        out.push(s);
        cur = s;
    }
}

export function allCells(N) {
    const cells = [];
    for (let a = 0; a < 3; a++) {
        for (const side of [0, 2 * N]) {
            const n = [0, 0, 0];
            n[a] = side === 0 ? -1 : 1;
            for (let u = 1; u < 2 * N; u += 2) {
                for (let v = 1; v < 2 * N; v += 2) {
                    const p = [0, 0, 0];
                    p[a] = side;
                    p[(a + 1) % 3] = u;
                    p[(a + 2) % 3] = v;
                    cells.push({ p, n });
                }
            }
        }
    }
    return cells;
}

function shuffle(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// ── Difficulty curve ──
export function levelConfig(level) {
    const tier = level % 10 === 0 ? 2 : level % 5 === 0 ? 1 : 0;
    const base = Math.min(3 + Math.floor((level - 1) / 4), 8);
    const N = Math.min(base + tier, 10);
    return {
        level,
        N,
        tier,                                       // 0 normal, 1 hard, 2 super hard
        label: ['', 'HARD', 'SUPER HARD'][tier],
        minLen: 2,
        maxLen: 3 + Math.floor(N * 0.9) + tier * 2,
        turnChance: 0.35 + Math.min(level, 40) * 0.006,
        longRayBias: Math.min(0.15 + level * 0.02 + tier * 0.15, 0.85),
    };
}

// Build a level. Arrows are placed one by one so that each new arrow's exit
// ray is clear of every arrow placed before it; removing them in reverse
// placement order is therefore always possible → every level is solvable.
export function generateLevel(level) {
    const cfg = levelConfig(level);
    const { N } = cfg;
    const rng = mulberry32(level * 7919 + 1234567);
    const occ = new Map();          // cell key → arrow id
    const arrows = [];
    const surface = allCells(N);

    const isFree = (c) => !occ.has(key(c.p));

    function tryArrow(head) {
        let dirs = shuffle(tangents(head.n).slice(), rng);
        // Harder levels prefer heads that point across the face (long exit
        // rays) so more arrows end up blocking each other.
        if (rng() < cfg.longRayBias) {
            dirs = dirs.sort((a, b) => rayCells(head, b, N).length - rayCells(head, a, N).length);
        }
        for (const d of dirs) {
            const ray = rayCells(head, d, N);
            if (!ray.every(isFree)) continue;
            const banned = new Set(ray.map((c) => key(c.p)));
            const targetLen = cfg.minLen + Math.floor(rng() * (cfg.maxLen - cfg.minLen + 1));

            // Grow the body backwards from the head
            const path = [{ p: head.p, n: head.n }];
            const used = new Set([key(head.p)]);
            let cur = head;
            let back = neg(d);               // direction we walk (away from head)
            while (path.length < targetLen) {
                const options = [];
                const straight = back;
                const turns = tangents(cur.n).filter((t) => axisOf(t) !== axisOf(back));
                // First step must go straight back so the head direction reads clearly
                const order = path.length === 1 ? [straight]
                    : rng() < cfg.turnChance ? shuffle(turns.slice(), rng).concat([straight])
                        : [straight].concat(shuffle(turns.slice(), rng));
                for (const t of order) {
                    const s = stepWrap(cur, t, N);
                    const k = key(s.p);
                    if (occ.has(k) || used.has(k) || banned.has(k)) continue;
                    options.push(s);
                    break;
                }
                if (!options.length) break;
                const s = options[0];
                path.push({ p: s.p, n: s.n });
                used.add(key(s.p));
                cur = s;
                back = s.d;
            }
            if (path.length < cfg.minLen) continue;

            const id = arrows.length;
            path.reverse();                  // tail → head
            for (const c of path) occ.set(key(c.p), id);
            arrows.push({ id, cells: path, dir: d });
            return true;
        }
        return false;
    }

    let placed = true;
    while (placed) {
        placed = false;
        for (const c of shuffle(surface.filter(isFree), rng)) {
            if (isFree(c) && tryArrow(c)) placed = true;
        }
    }
    return { cfg, N, arrows };
}

// ── Runtime board ──
export class Board {
    constructor(level) {
        const { cfg, N, arrows } = generateLevel(level);
        this.cfg = cfg;
        this.N = N;
        this.arrows = arrows;
        this.removed = new Set();
        this.occ = new Map();
        for (const a of arrows) for (const c of a.cells) this.occ.set(key(c.p), a.id);
    }

    get remaining() { return this.arrows.length - this.removed.size; }

    arrowAt(p) {
        const id = this.occ.get(key(p));
        return id === undefined ? null : this.arrows[id];
    }

    // First blocking arrow in front of `arrow`, or null if the way is clear.
    blocker(arrow) {
        const head = arrow.cells[arrow.cells.length - 1];
        const ray = rayCells(head, arrow.dir, this.N);
        for (let i = 0; i < ray.length; i++) {
            const id = this.occ.get(key(ray[i].p));
            if (id !== undefined && id !== arrow.id) return { arrow: this.arrows[id], index: i };
        }
        return null;
    }

    remove(arrow) {
        this.removed.add(arrow.id);
        for (const c of arrow.cells) this.occ.delete(key(c.p));
    }

    freeArrows() {
        return this.arrows.filter((a) => !this.removed.has(a.id) && !this.blocker(a));
    }
}
