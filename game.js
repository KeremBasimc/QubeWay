/* =========================================
   Qube Way — Game Engine (Three.js renderer + UI flow)
   ========================================= */

import * as THREE from './lib/three.module.min.js';
import { Board, stepWrap, GEN_VERSION } from './puzzle.js';

// ── Constants ──────────────────────────────
const MAX_STARS = 3;
const SAVE_KEY = 'qw_savegame';
const HINT_COST = 20;
const REVIVE_COST = 50;
const DAILY_REWARD = 50;
const LEVEL_REWARD = 10;
const STAR_REWARD = 5;

const LINE_W = 0.56;          // ribbon width, in doubled-cell units (cell = 2)
const HEAD_LEN = 0.95;
const HEAD_HALF = 0.62;
const LIFT = 0.006;           // world-space gap above the cube surface
const FLY_SPEED = 40;         // doubled units / second (initial)
const FLY_ACCEL = 160;

const COLOR_IDLE = new THREE.Color('#1f2433');
const COLOR_FLY = new THREE.Color('#2f80ff');
const COLOR_BAD = new THREE.Color('#ff3b4a');
const COLOR_HINT = new THREE.Color('#2f80ff');

const PRAISE_WORDS = ['NICE!', 'GREAT!', 'SUPER!', 'AWESOME!', 'FANTASTIC!', 'INCREDIBLE!'];

// ── Settings / persistence ─────────────────
const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} },
    del(k) { try { localStorage.removeItem(k); } catch (_) {} },
};

const settings = {
    sfx: store.get('qw_sfx', 'true') !== 'false',
    haptic: store.get('qw_haptic', 'true') !== 'false',
};

let coins = parseInt(store.get('qw_coins', '0'), 10) || 0;
let currentLevel = parseInt(store.get('qw_level', '1'), 10) || 1;
let totalStars = parseInt(store.get('qw_total_stars', '0'), 10) || 0;

// ── Audio (Web Audio, no files) ────────────
const Audio = {
    _ctx: null,
    get ctx() {
        if (!this._ctx) this._ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this._ctx.state === 'suspended') this._ctx.resume();
        return this._ctx;
    },
    _tone(freq, type, dur, vol = 0.2, delay = 0, slideTo = null) {
        if (!settings.sfx) return;
        try {
            const ctx = this.ctx;
            const t = ctx.currentTime + delay;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain); gain.connect(ctx.destination);
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t);
            if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(vol, t + 0.01);
            gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
            osc.start(t); osc.stop(t + dur + 0.05);
        } catch (_) {}
    },
    swoosh(pitch = 1) { this._tone(320 * pitch, 'sine', 0.22, 0.16, 0, 900 * pitch); this._tone(640 * pitch, 'triangle', 0.12, 0.05, 0.02, 1400 * pitch); },
    bump() { this._tone(140, 'square', 0.14, 0.12, 0, 70); this._tone(90, 'sine', 0.2, 0.2); },
    win() { [523, 659, 784, 1047, 1319].forEach((f, i) => this._tone(f, 'sine', 0.5, 0.18, i * 0.08)); },
    fail() { [440, 370, 310, 220].forEach((f, i) => this._tone(f, 'sawtooth', 0.28, 0.1, i * 0.13)); },
    click() { this._tone(520, 'sine', 0.06, 0.1); },
    hint() { this._tone(880, 'sine', 0.15, 0.12); this._tone(1320, 'sine', 0.2, 0.1, 0.08); },
};

function vibrate(p) { if (settings.haptic && navigator.vibrate) navigator.vibrate(p); }

// ── DOM ────────────────────────────────────
const $ = (id) => document.getElementById(id);
const canvas = $('scene');
const mainMenu = $('main-menu');
const hud = $('hud');
const hudBar = $('hud-bar');
const hudStars = [...$('hud-stars').children];
const hudLevel = $('hud-level');
const hudBadge = $('hud-badge');
const hudCounter = $('hud-counter');
const arrowsLeftEl = $('arrows-left');
const hudCoins = $('hud-coins');
const hintBtn = $('hint-btn');
const tutorial = $('tutorial');
const praise = $('praise');
const praiseText = $('praise-text');
const winOverlay = $('win-overlay');
const failOverlay = $('fail-overlay');
const reviveBtn = $('revive-btn');
const settingsPanel = $('settings-panel');
const settingsDrawer = $('settings-drawer');
const settingsBackdrop = $('settings-backdrop');
const dailyPopup = $('daily-popup');

$('hint-cost').textContent = HINT_COST;

// ── Three.js scene ─────────────────────────
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
scene.add(new THREE.HemisphereLight(0xffffff, 0xc9d5ea, 1.4));
const sun = new THREE.DirectionalLight(0xffffff, 0.9);
sun.position.set(3, 5, 4);
scene.add(sun);

const cubeGroup = new THREE.Group();
scene.add(cubeGroup);
const HOME_ROT = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.42, -0.62, 0, 'XYZ'));
cubeGroup.quaternion.copy(HOME_ROT);

let cubeMesh = null;
let cubeEdges = null;
let zoom = 1;
const pan = new THREE.Vector2();       // camera offset in world units (for zoomed-in play)

function faceTexture(N) {
    const px = N > 10 ? 1024 : 512;
    const c = document.createElement('canvas');
    c.width = c.height = px;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, px, px);
    grad.addColorStop(0, '#fbfdff');
    grad.addColorStop(1, '#eef3fb');
    g.fillStyle = grad;
    g.fillRect(0, 0, px, px);
    const step = px / N;
    g.strokeStyle = 'rgba(120, 140, 190, 0.10)';
    g.lineWidth = 2;
    for (let i = 1; i < N; i++) {
        g.beginPath(); g.moveTo(i * step, 0); g.lineTo(i * step, px); g.stroke();
        g.beginPath(); g.moveTo(0, i * step); g.lineTo(px, i * step); g.stroke();
    }
    g.fillStyle = 'rgba(120, 140, 190, 0.28)';
    for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        g.beginPath(); g.arc((i + 0.5) * step, (j + 0.5) * step, Math.max(2, step * 0.035), 0, Math.PI * 2); g.fill();
    }
    g.strokeStyle = 'rgba(150, 165, 205, 0.55)';
    g.lineWidth = 6;
    g.strokeRect(0, 0, px, px);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
}

function buildCube(N) {
    if (cubeMesh) { cubeGroup.remove(cubeMesh); cubeMesh.geometry.dispose(); cubeMesh.material.map.dispose(); cubeMesh.material.dispose(); }
    if (cubeEdges) { cubeGroup.remove(cubeEdges); cubeEdges.geometry.dispose(); }
    const mat = new THREE.MeshStandardMaterial({
        map: faceTexture(N), roughness: 0.9, metalness: 0,
        emissive: 0xffffff, emissiveIntensity: 0.38,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    });
    cubeMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
    cubeGroup.add(cubeMesh);
    cubeEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(2.004, 2.004, 2.004)),
        new THREE.LineBasicMaterial({ color: 0xaab8d6 }));
    cubeGroup.add(cubeEdges);
}

// ── Arrow tracks & geometry ────────────────
// A track is a list of straight segments (in doubled cube coords) that the
// arrow slides along: its own body, then the exit ray, then out into the air.
const vAdd = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const vSub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const vScale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const vLen = (a) => Math.hypot(a[0], a[1], a[2]);
const vEq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
const vCross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function buildTrack(arrow, N) {
    const segs = [];
    const push = (a, b, n) => {
        const len = vLen(vSub(b, a));
        const start = segs.length ? segs[segs.length - 1].end : 0;
        segs.push({ a, b, n, len, start, end: start + len, dir: vScale(vSub(b, a), 1 / len) });
    };
    const cells = arrow.cells;
    for (let i = 0; i + 1 < cells.length; i++) {
        const c = cells[i], d = cells[i + 1];
        if (vEq(c.n, d.n)) push(c.p, d.p, c.n);
        else {
            const edge = vAdd(c.p, d.n);           // crossing point on the cube edge
            push(c.p, edge, c.n);
            push(edge, d.p, d.n);
        }
    }
    const bodyLen = segs.length ? segs[segs.length - 1].end : 0;
    // Exit ray on the head's face, then fly off tangentially
    let cur = cells[cells.length - 1];
    for (;;) {
        const s = stepWrap(cur, arrow.dir, N);
        if (s.wrapped) {
            const edge = vAdd(cur.p, arrow.dir);
            push(cur.p, edge, cur.n);
            push(edge, vAdd(edge, vScale(arrow.dir, 4 * N + bodyLen + 6)), cur.n);
            break;
        }
        push(cur.p, s.p, cur.n);
        cur = s;
    }
    return { segs, bodyLen, total: segs[segs.length - 1].end };
}

function pointAt(track, s) {
    for (const g of track.segs) {
        if (s <= g.end + 1e-9) return { p: vAdd(g.a, vScale(g.dir, s - g.start)), seg: g };
    }
    const g = track.segs[track.segs.length - 1];
    return { p: vAdd(g.a, vScale(g.dir, s - g.start)), seg: g };
}

// Build a triangle list for the part of the track in [s0, s0 + bodyLen]
function arrowGeometry(track, s0, N) {
    const s1 = s0 + track.bodyLen;
    const k = 1 / N;                          // doubled units → world
    const pos = [];
    const toWorld = (p, off) => [p[0] * k - 1 + off[0], p[1] * k - 1 + off[1], p[2] * k - 1 + off[2]];
    const quad = (A, B, C, D) => pos.push(...A, ...B, ...C, ...A, ...C, ...D);

    const segs = track.segs;
    for (let i = 0; i < segs.length; i++) {
        const g = segs[i];
        const a = Math.max(s0, g.start), b = Math.min(s1, g.end);
        if (b <= a + 1e-6) continue;
        // Extend into joints on the same face so corners look solid
        const prev = segs[i - 1], next = segs[i + 1];
        const extA = (a > g.start + 1e-6 || !prev || vEq(prev.n, g.n)) ? LINE_W / 2 : 0;
        const extB = (b < g.end - 1e-6 || !next || vEq(next.n, g.n)) ? LINE_W / 2 : 0;
        let pa = vAdd(g.a, vScale(g.dir, a - g.start - extA));
        let pb = vAdd(g.a, vScale(g.dir, b - g.start + extB));
        // Lift: on an edge endpoint use the averaged normal so faces meet cleanly
        const offA = (a <= g.start + 1e-6 && prev && !vEq(prev.n, g.n)) ? vAdd(prev.n, g.n) : g.n;
        const offB = (b >= g.end - 1e-6 && next && !vEq(next.n, g.n)) ? vAdd(next.n, g.n) : g.n;
        const side = vScale(vCross(g.n, g.dir), LINE_W / 2);
        const oa = vScale(offA, LIFT), ob = vScale(offB, LIFT);
        quad(toWorld(vSub(pa, side), oa), toWorld(vSub(pb, side), ob),
             toWorld(vAdd(pb, side), ob), toWorld(vAdd(pa, side), oa));
    }

    // Arrow head at the front end
    const front = pointAt(track, s1);
    const g = front.seg;
    const side = vScale(vCross(g.n, g.dir), HEAD_HALF);
    const base = vSub(front.p, vScale(g.dir, 0.15));
    const tip = vAdd(front.p, vScale(g.dir, HEAD_LEN));
    const o = vScale(g.n, LIFT * 1.5);
    pos.push(...toWorld(vSub(base, side), o), ...toWorld(tip, o), ...toWorld(vAdd(base, side), o));

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    return geo;
}

// ── Game state ─────────────────────────────
let board = null;
let arrowViews = [];          // per arrow id: { mesh, track, busy }
let anims = [];
let stars = MAX_STARS;
let reviveUsed = false;
let levelDone = false;
let streak = 0;               // consecutive clean removals, for praise words
let hintTimer = null;
let hintArrowId = null;

function clearArrows() {
    for (const v of arrowViews) {
        if (!v) continue;
        cubeGroup.remove(v.mesh);
        v.mesh.geometry.dispose();
        v.mesh.material.dispose();
    }
    arrowViews = [];
    anims = [];
}

function loadLevel(level, saved = null) {
    clearArrows();
    board = new Board(level);
    buildCube(board.N);
    stars = MAX_STARS;
    reviveUsed = false;
    levelDone = false;
    streak = 0;
    stopHint();

    if (saved && saved.level === level) {
        for (const id of saved.removed || []) if (board.arrows[id]) board.remove(board.arrows[id]);
        stars = Math.max(1, Math.min(MAX_STARS, saved.stars || MAX_STARS));
        reviveUsed = !!saved.reviveUsed;
    }

    for (const a of board.arrows) {
        if (board.removed.has(a.id)) { arrowViews[a.id] = null; continue; }
        const track = buildTrack(a, board.N);
        const mat = new THREE.MeshBasicMaterial({ color: COLOR_IDLE.clone(), side: THREE.DoubleSide, transparent: true });
        const mesh = new THREE.Mesh(arrowGeometry(track, 0, board.N), mat);
        mesh.renderOrder = 1;
        cubeGroup.add(mesh);
        arrowViews[a.id] = { mesh, track, busy: false };
    }

    cubeGroup.quaternion.copy(HOME_ROT);
    spin.set(0, 0);
    zoom = 1;
    pan.set(0, 0);
    fitCamera();

    hudLevel.textContent = `Level ${level}`;
    hudBar.classList.remove('tier-1', 'tier-2');
    if (board.cfg.tier) hudBar.classList.add(`tier-${board.cfg.tier}`);
    hudBadge.textContent = board.cfg.label;
    hudBadge.className = `hud-badge tier-${board.cfg.tier}`;
    hudBadge.classList.toggle('hidden', !board.cfg.tier);
    tutorial.classList.toggle('hidden', level > 2);
    updateHud();
}

function persist() {
    if (!board || levelDone) return;
    store.set(SAVE_KEY, JSON.stringify({
        v: GEN_VERSION, level: currentLevel, removed: [...board.removed], stars, reviveUsed,
    }));
}

function getSave() {
    try {
        const s = JSON.parse(store.get(SAVE_KEY, 'null'));
        return s && s.v === GEN_VERSION && s.level === currentLevel ? s : null;
    } catch (_) { return null; }
}

function updateHud() {
    arrowsLeftEl.textContent = board ? board.remaining : 0;
    hudStars.forEach((el, i) => el.classList.toggle('lost', i >= stars));
    hudCoins.textContent = coins;
    hintBtn.classList.toggle('disabled', coins < HINT_COST);
}

function saveCoins() {
    store.set('qw_coins', coins);
    hudCoins.textContent = coins;
    $('menu-coins').textContent = coins;
    hintBtn.classList.toggle('disabled', coins < HINT_COST);
}

// ── Interaction: tapping arrows ────────────
function tapArrow(arrow) {
    if (!arrow || levelDone || stars <= 0) return;
    const view = arrowViews[arrow.id];
    if (!view || view.busy) return;
    tutorial.classList.add('hidden');

    const block = board.blocker(arrow);
    if (!block) {
        // Clear path — slide off the cube
        board.remove(arrow);
        view.busy = true;
        view.mesh.material.color.copy(COLOR_FLY);
        const travel = view.track.total - view.track.bodyLen;
        anims.push({ type: 'fly', id: arrow.id, t: 0, travel });
        if (hintArrowId === arrow.id) stopHint();
        streak++;
        Audio.swoosh(1 + Math.min(streak, 10) * 0.04);
        vibrate(10);
        arrowsLeftEl.textContent = board.remaining;
        hudCounter.classList.remove('bump'); void hudCounter.offsetWidth; hudCounter.classList.add('bump');
        if (streak >= 5 && streak % 5 === 0) showPraise(PRAISE_WORDS[Math.min(streak / 5 - 1, PRAISE_WORDS.length - 1)]);
        persist();
        if (board.remaining === 0) onLevelComplete();
    } else {
        // Blocked — bump into the blocker and lose a star
        view.busy = true;
        view.mesh.material.color.copy(COLOR_BAD);
        const dist = Math.max(0.3, 2 * block.index + 0.2);
        anims.push({ type: 'bump', id: arrow.id, t: 0, dist, blocker: block.arrow.id });
        streak = 0;
        loseStar();
    }
}

function loseStar() {
    stars--;
    const el = hudStars[stars];
    if (el) { el.classList.add('lost', 'breaking'); setTimeout(() => el.classList.remove('breaking'), 600); }
    Audio.bump();
    vibrate([40, 30, 60]);
    persist();
    if (stars <= 0) setTimeout(onOutOfStars, 650);
}

// ── Hints ──────────────────────────────────
function useHint() {
    if (levelDone || !board) return;
    if (coins < HINT_COST) { vibrate(30); flash(hintBtn); return; }
    const free = board.freeArrows().filter((a) => arrowViews[a.id] && !arrowViews[a.id].busy);
    if (!free.length) return;
    // Prefer the free arrow that is most visible (head facing the camera)
    const camDir = new THREE.Vector3(0, 0, 1).applyQuaternion(cubeGroup.quaternion.clone().invert());
    free.sort((a, b) => score(b) - score(a));
    function score(a) { const n = a.cells[a.cells.length - 1].n; return n[0] * camDir.x + n[1] * camDir.y + n[2] * camDir.z; }
    coins -= HINT_COST;
    saveCoins();
    stopHint();
    hintArrowId = free[0].id;
    Audio.hint();
    hintTimer = setTimeout(stopHint, 6000);
}

function stopHint() {
    clearTimeout(hintTimer);
    if (hintArrowId !== null && arrowViews[hintArrowId] && !arrowViews[hintArrowId].busy) {
        arrowViews[hintArrowId].mesh.material.color.copy(COLOR_IDLE);
    }
    hintArrowId = null;
}

function flash(el) { el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(0)' }], { duration: 250 }); }

// ── Level end ──────────────────────────────
function onLevelComplete() {
    levelDone = true;
    store.del(SAVE_KEY);
    const bonus = board.cfg.tier === 2 ? 2 : 1;
    const earned = (LEVEL_REWARD + stars * STAR_REWARD) * bonus;
    coins += earned;
    saveCoins();
    totalStars += stars;
    store.set('qw_total_stars', totalStars);
    const finished = currentLevel;
    currentLevel++;
    store.set('qw_level', currentLevel);

    setTimeout(() => {
        const winStars = [...$('win-stars').children];
        winStars.forEach((el, i) => el.classList.toggle('lost', i >= stars));
        $('win-level').textContent = `Level ${finished}${board.cfg.label ? ' · ' + board.cfg.label : ''}`;
        $('win-coins').textContent = `+${earned} coins`;
        winOverlay.classList.remove('hidden');
        Audio.win();
        vibrate([60, 30, 60, 30, 120]);
        confettiBurst();
    }, 900);
}

function onOutOfStars() {
    if (levelDone) return;
    $('fail-left').textContent = `${board.remaining} arrow${board.remaining === 1 ? '' : 's'} left`;
    reviveBtn.textContent = `♥ Continue +1★ – ${REVIVE_COST} coins`;
    reviveBtn.classList.toggle('hidden', reviveUsed || coins < REVIVE_COST);
    failOverlay.classList.remove('hidden');
    store.del(SAVE_KEY);
    Audio.fail();
    vibrate([80, 40, 160]);
}

function revive() {
    if (reviveUsed || coins < REVIVE_COST) return;
    coins -= REVIVE_COST;
    saveCoins();
    reviveUsed = true;
    stars = 1;
    failOverlay.classList.add('hidden');
    Audio.click();
    updateHud();
    persist();
}

function confettiBurst() {
    const colors = ['#6a6cf0', '#2f80ff', '#ffc93c', '#ff5a6e', '#2ed573', '#a55cf0'];
    for (let i = 0; i < 70; i++) {
        setTimeout(() => {
            const p = document.createElement('div');
            p.className = 'confetti-piece';
            const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 140;
            const s = 6 + Math.random() * 8;
            p.style.cssText = `left:${Math.random() * innerWidth}px;top:${Math.random() * innerHeight * 0.5}px;` +
                `width:${s}px;height:${s}px;background:${colors[i % colors.length]};` +
                `border-radius:${Math.random() > 0.5 ? '50%' : '2px'};--tx:${Math.cos(a) * d}px;` +
                `--ty:${Math.sin(a) * d - 80}px;--rot:${(Math.random() - 0.5) * 720}deg`;
            document.body.appendChild(p);
            setTimeout(() => p.remove(), 1700);
        }, i * 18);
    }
}

function showPraise(word) {
    praiseText.textContent = word;
    praise.classList.remove('hidden');
    praiseText.style.animation = 'none'; void praiseText.offsetHeight; praiseText.style.animation = '';
    clearTimeout(showPraise._t);
    showPraise._t = setTimeout(() => praise.classList.add('hidden'), 950);
}

// ── Pointer input: rotate, zoom, pan, tap ──
// 1 finger / left mouse: rotate (or tap)   2 fingers: pinch-zoom + pan
// right mouse or shift+drag: pan           wheel: zoom
const pointers = new Map();
let dragStart = null;
let pinch = null;                       // { dist, mid }
const spin = new THREE.Vector2();       // angular velocity for inertia
const raycaster = new THREE.Raycaster();

function rotateBy(dx, dy) {
    const speed = 0.0085 / Math.sqrt(zoom);
    const qx = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), dx * speed);
    const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), dy * speed);
    cubeGroup.quaternion.premultiply(qx).premultiply(qy);
}

function maxZoom() { return board ? Math.max(2.4, board.N / 3.2) : 2.4; }

function panBy(dx, dy) {
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const perPx = (2 * camera.position.z * Math.tan(vFov / 2)) / (zoom * window.innerHeight);
    const lim = 1.25;
    pan.x = Math.min(lim, Math.max(-lim, pan.x - dx * perPx));
    pan.y = Math.min(lim, Math.max(-lim, pan.y + dy * perPx));
    fitCamera();
}

function twoFingerState() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    spin.set(0, 0);
    if (pointers.size === 1) {
        dragStart = {
            x: e.clientX, y: e.clientY, t: performance.now(), moved: false,
            pan: e.button === 2 || e.shiftKey,
        };
    } else if (pointers.size === 2) {
        dragStart = null;
        pinch = twoFingerState();
    }
});

canvas.addEventListener('pointermove', (e) => {
    const prev = pointers.get(e.pointerId);
    if (!prev) return;
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
        const now = twoFingerState();
        if (pinch) {
            if (pinch.dist > 0) setZoom(zoom * (now.dist / pinch.dist));
            panBy(now.mid.x - pinch.mid.x, now.mid.y - pinch.mid.y);
        }
        pinch = now;
        return;
    }
    if (dragStart) {
        if (!dragStart.moved && Math.hypot(e.clientX - dragStart.x, e.clientY - dragStart.y) > 8) dragStart.moved = true;
        if (dragStart.moved) {
            if (dragStart.pan) panBy(dx, dy);
            else { rotateBy(dx, dy); spin.set(dx, dy); }
        }
    }
});

function endPointer(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.delete(e.pointerId);
    if (pointers.size === 0 && dragStart) {
        if (!dragStart.moved && !dragStart.pan && performance.now() - dragStart.t < 600) pick(e.clientX, e.clientY);
        dragStart = null;
    }
    if (pointers.size < 2) pinch = null;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', (e) => { pointers.delete(e.pointerId); dragStart = null; pinch = null; });

canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(zoom * Math.exp(-e.deltaY * 0.0012));
}, { passive: false });

function setZoom(z) {
    zoom = Math.min(maxZoom(), Math.max(0.7, z));
    // Drift back to centre as the player zooms out
    if (zoom <= 1) pan.multiplyScalar(Math.max(0, zoom - 0.7) / 0.3);
    fitCamera();
}

// Map a screen tap to the arrow under it (nearest cell on the hit face)
function pick(x, y) {
    if (!board || !cubeMesh) return;
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((x - rect.left) / rect.width) * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObject(cubeMesh, false)[0];
    if (!hit) return;
    const local = cubeGroup.worldToLocal(hit.point.clone());
    const N = board.N;
    const q = [(local.x + 1) * N, (local.y + 1) * N, (local.z + 1) * N];   // doubled coords
    const n = hit.face.normal;
    const na = [Math.round(n.x), Math.round(n.y), Math.round(n.z)];
    const axis = na[0] ? 0 : na[1] ? 1 : 2;

    let best = null, bestD = Infinity;
    const cx = Math.floor(q[(axis + 1) % 3] / 2), cy = Math.floor(q[(axis + 2) % 3] / 2);
    for (let du = -1; du <= 1; du++) for (let dv = -1; dv <= 1; dv++) {
        const u = cx + du, v = cy + dv;
        if (u < 0 || v < 0 || u >= N || v >= N) continue;
        const p = [0, 0, 0];
        p[axis] = na[axis] > 0 ? 2 * N : 0;
        p[(axis + 1) % 3] = 2 * u + 1;
        p[(axis + 2) % 3] = 2 * v + 1;
        const a = board.arrowAt(p);
        if (!a) continue;
        const d = Math.hypot(p[(axis + 1) % 3] - q[(axis + 1) % 3], p[(axis + 2) % 3] - q[(axis + 2) % 3]);
        if (d < bestD) { bestD = d; best = a; }
    }
    if (best && bestD < 1.9) tapArrow(best);
}

// ── Camera fit ─────────────────────────────
function fitCamera() {
    const w = window.innerWidth, h = window.innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    const radius = 1.7;                    // bounding sphere of the cube (+ margin)
    const vFov = THREE.MathUtils.degToRad(camera.fov);
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
    const dist = radius / Math.sin(Math.min(vFov, hFov) / 2);
    // Zoom narrows the lens instead of moving the camera, so it never clips into the cube
    camera.zoom = zoom;
    camera.position.set(pan.x, pan.y - 0.08, dist);
    camera.lookAt(pan.x, pan.y - 0.08, 0);
    camera.updateProjectionMatrix();
}
window.addEventListener('resize', fitCamera);

// ── Main loop ──────────────────────────────
let last = performance.now();
function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // Inertia after a drag
    if (!dragStart && pointers.size === 0 && spin.lengthSq() > 0.01) {
        rotateBy(spin.x, spin.y);
        spin.multiplyScalar(Math.pow(0.02, dt));
    }

    for (let i = anims.length - 1; i >= 0; i--) {
        const an = anims[i];
        const view = arrowViews[an.id];
        if (!view) { anims.splice(i, 1); continue; }
        an.t += dt;
        let offset;
        if (an.type === 'fly') {
            offset = FLY_SPEED * an.t + 0.5 * FLY_ACCEL * an.t * an.t;
            if (offset >= an.travel - view.track.bodyLen * 0.2) view.mesh.material.opacity = Math.max(0, 1 - (offset - an.travel + view.track.bodyLen * 0.2) / 6);
            if (offset >= an.travel) {
                cubeGroup.remove(view.mesh);
                view.mesh.geometry.dispose();
                view.mesh.material.dispose();
                arrowViews[an.id] = null;
                anims.splice(i, 1);
                continue;
            }
        } else {
            const DUR = 0.32;
            const k = Math.min(1, an.t / DUR);
            offset = an.dist * Math.sin(k * Math.PI);
            const bv = arrowViews[an.blocker];
            if (bv) bv.mesh.material.color.copy(k < 1 ? COLOR_BAD : COLOR_IDLE);
            if (k >= 1) {
                view.busy = false;
                view.mesh.material.color.copy(an.id === hintArrowId ? COLOR_HINT : COLOR_IDLE);
                offset = 0;
                anims.splice(i, 1);
            }
        }
        view.mesh.geometry.dispose();
        view.mesh.geometry = arrowGeometry(view.track, offset, board.N);
    }

    // Hint pulse
    if (hintArrowId !== null) {
        const v = arrowViews[hintArrowId];
        if (v && !v.busy) {
            const k = 0.5 + 0.5 * Math.sin(now / 140);
            v.mesh.material.color.copy(COLOR_IDLE).lerp(COLOR_HINT, k);
        }
    }

    renderer.render(scene, camera);
    requestAnimationFrame(frame);
}

// ── Navigation / UI ────────────────────────
function refreshMenu() {
    $('menu-level').textContent = currentLevel;
    $('menu-coins').textContent = coins;
    $('menu-stars').textContent = totalStars ? `★ ${totalStars} stars collected` : '';
    const resume = !!getSave();
    $('play-btn').innerHTML = resume ? '▶&nbsp;&nbsp;CONTINUE' : `▶&nbsp;&nbsp;LEVEL ${currentLevel}`;
    $('restart-level-link').classList.toggle('hidden', !resume);
}

function showMainMenu() {
    hud.classList.add('hidden');
    winOverlay.classList.add('hidden');
    failOverlay.classList.add('hidden');
    mainMenu.classList.remove('hidden', 'hiding');
    refreshMenu();
}

function startPlaying(fresh) {
    Audio.click();
    vibrate(15);
    if (fresh) store.del(SAVE_KEY);
    loadLevel(currentLevel, fresh ? null : getSave());
    mainMenu.classList.add('hiding');
    setTimeout(() => {
        mainMenu.classList.add('hidden');
        hud.classList.remove('hidden');
    }, 380);
}

function openSettings() {
    settingsDrawer.style.animation = '';
    settingsBackdrop.style.animation = '';
    settingsPanel.classList.remove('hidden');
    Audio.click();
}

function closeSettings() {
    settingsDrawer.style.animation = 'drawerSlideDown 0.32s ease forwards';
    settingsBackdrop.style.animation = 'backdropOut 0.32s ease forwards';
    setTimeout(() => {
        settingsPanel.classList.add('hidden');
        settingsDrawer.style.animation = '';
        settingsBackdrop.style.animation = '';
    }, 300);
}

function dayString(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function checkDailyReward() {
    const today = dayString(Date.now());
    const lastDay = store.get('qw_daily_last', null);
    if (lastDay === today) return;
    const yesterday = dayString(Date.now() - 86400000);
    let s = parseInt(store.get('qw_daily_streak', '0'), 10) || 0;
    s = lastDay === yesterday ? s + 1 : 1;
    coins += DAILY_REWARD;
    saveCoins();
    store.set('qw_daily_streak', s);
    store.set('qw_daily_last', today);
    $('daily-streak').textContent = `Day ${s} streak`;
    $('daily-reward-amt').textContent = `+${DAILY_REWARD} coins`;
    dailyPopup.classList.remove('hidden');
}

function init() {
    $('play-btn').addEventListener('click', () => startPlaying(false));
    $('restart-level-link').addEventListener('click', () => startPlaying(true));
    $('next-btn').addEventListener('click', () => {
        winOverlay.classList.add('hidden');
        Audio.click();
        loadLevel(currentLevel);
    });
    $('win-menu-btn').addEventListener('click', showMainMenu);
    $('retry-btn').addEventListener('click', () => {
        failOverlay.classList.add('hidden');
        Audio.click();
        loadLevel(currentLevel);
    });
    $('fail-menu-btn').addEventListener('click', showMainMenu);
    reviveBtn.addEventListener('click', revive);
    hintBtn.addEventListener('click', useHint);
    $('reset-view-btn').addEventListener('click', () => {
        Audio.click();
        spin.set(0, 0);
        const from = cubeGroup.quaternion.clone();
        const t0 = performance.now();
        (function ease() {
            const k = Math.min(1, (performance.now() - t0) / 350);
            cubeGroup.quaternion.slerpQuaternions(from, HOME_ROT, 1 - Math.pow(1 - k, 3));
            if (k < 1) requestAnimationFrame(ease);
        })();
        pan.set(0, 0);
        setZoom(1);
    });

    $('settings-btn').addEventListener('click', openSettings);
    $('menu-settings-btn').addEventListener('click', openSettings);
    $('settings-close').addEventListener('click', closeSettings);
    settingsBackdrop.addEventListener('click', closeSettings);
    $('settings-menu-btn').addEventListener('click', () => { Audio.click(); showMainMenu(); closeSettings(); });
    $('settings-restart-btn').addEventListener('click', () => {
        Audio.click();
        closeSettings();
        if (!hud.classList.contains('hidden')) {
            winOverlay.classList.add('hidden');
            failOverlay.classList.add('hidden');
            store.del(SAVE_KEY);
            loadLevel(currentLevel);
        }
    });

    const toggleSfx = $('toggle-sfx'), toggleHaptic = $('toggle-haptic');
    toggleSfx.checked = settings.sfx;
    toggleHaptic.checked = settings.haptic;
    toggleSfx.addEventListener('change', () => { settings.sfx = toggleSfx.checked; store.set('qw_sfx', settings.sfx); });
    toggleHaptic.addEventListener('change', () => { settings.haptic = toggleHaptic.checked; store.set('qw_haptic', settings.haptic); });

    $('daily-close').addEventListener('click', () => { dailyPopup.classList.add('hidden'); Audio.click(); });
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    // Prepare the current level (resuming any saved progress) behind the menu
    loadLevel(currentLevel, getSave());
    fitCamera();
    showMainMenu();
    checkDailyReward();
    requestAnimationFrame(frame);
}

// Debug / testing hook
window.__qw = {
    get board() { return board; },
    tap: (id) => tapArrow(board.arrows[id]),
    camera, cubeGroup,
};

init();
