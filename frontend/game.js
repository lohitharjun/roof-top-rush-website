(() => {
'use strict';

const CFG = window.RR_CONFIG || {};
const API = (CFG.API_URL || '').replace(/\/+$/, '');
const $ = (id) => document.getElementById(id);

/* ============ tuning ============ */
const H = 320;                     // logical height; width adapts to the screen (480..768)
let W = 480;
const PX = 90;                     // runner's fixed screen x
const PW = 10, PH = 18;            // runner hitbox
const M = 10;                      // pixels per metre
const G = 0.6, JUMP = -10.5, CUT = -6;
const COYOTE = 6, BUFFER = 6, STEP = 1000 / 60;
const START_SPEED = 4, MAX_SPEED = 7, RAMP = 0.0004;   // speed starts at 4, climbs slowly, stops at 7
const WORLD_SPEED = 0.8;           // inside a portal world you run at 80% of normal speed
const SAFE_FRAMES = 90;            // protection after a portal flash (60 frames = 1 second)
const REVIVE_SPEED = 0.7;          // after a revive you restart at 70% of your speed
const CAR_TIME = 900, CAR_SPEED = 5.2;          // car challenge: 15 seconds at 60 fps
const EVENT_FIRST = 1000, EVENT_EVERY = 1000;     // car / train / sky / collapse challenges (metres)
const UNLOCK_AT = 5000;                           // distance that unlocks the Rift Warden
const PORTAL_FIRST = 500, PORTAL_EVERY = 1000;   // metres (halved from the design doc)
const WORLD_LEN = [150, 200];                    // metres spent inside a world
const PORTAL_H = 64;               // jump higher than this to skip a portal
const HANG = 46;                   // hanging hazards end this far above the floor
const REVIVE_MAX = 2;
const COIN_R = 6;                  // coin half-size in pixels (was 4)
const COIN_PAD = 4;                // extra pickup forgiveness around the player

const COL = {
  sky: '#a8a8b6', far: '#8e8e9e', mid: '#6e6e7f', near: '#505061',
  wall: '#b6b6c2', roof: '#eeeef4', lip: '#8f8fa0', dot: '#7a7a8a',
  win: '#3a3a47', winLit: '#5f5f6e', ink: '#1b1b24', white: '#f4f4f8', coin: '#ffd23f'
};
const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

const stage = $('stage'), canvas = $('game');
let ctx = canvas.getContext('2d');

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const rand = (a, b) => a + Math.random() * (b - a);
const ri = (r) => Math.floor(rand(r[0], r[1] + 1));
const pick = (list) => {
  let t = 0; for (const e of list) t += e[1];
  let r = Math.random() * t;
  for (const e of list) { if ((r -= e[1]) < 0) return e[0]; }
  return list[0][0];
};

/* ============ storage, wallet, costumes ============ */
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
};
const jget = (k, d) => { try { const v = JSON.parse(store.get(k, 'null')); return v === null ? d : v; } catch (e) { return d; } };

let best = parseInt(store.get('rr_best', '0'), 10) || 0;
let muted = store.get('rr_mute', '0') === '1';
let wallet = parseInt(store.get('rr_coins', '0'), 10) || 0;
let warden = store.get('rr_warden', '0') === '1';
const owned = new Set(jget('rr_owned', []));
owned.add('hat:none'); owned.add('scarf:red'); owned.add('char:runner');
if (warden) owned.add('char:warden');
const equip = Object.assign({ hat: 'none', scarf: 'red', char: 'runner' }, jget('rr_equip', {}));
const saveWallet = () => store.set('rr_coins', String(wallet));
const saveCostumes = () => { store.set('rr_owned', JSON.stringify([...owned])); store.set('rr_equip', JSON.stringify(equip)); };

const HATS = [
  { id: 'none', name: 'No hat', cost: 0 }, { id: 'cap', name: 'Cap', cost: 60 },
  { id: 'beanie', name: 'Beanie', cost: 60 }, { id: 'band', name: 'Headband', cost: 80 },
  { id: 'tophat', name: 'Top hat', cost: 120 }, { id: 'crown', name: 'Crown', cost: 250 }
];
const SCARVES = [
  { id: 'red', name: 'Red', col: '#e8553d', cost: 0 }, { id: 'blue', name: 'Blue', col: '#4aa3ff', cost: 40 },
  { id: 'green', name: 'Green', col: '#59d98e', cost: 40 }, { id: 'yellow', name: 'Yellow', col: '#ffd23f', cost: 40 },
  { id: 'pink', name: 'Pink', col: '#ff7ac8', cost: 60 }, { id: 'white', name: 'White', col: '#f4f4f8', cost: 60 },
  { id: 'purple', name: 'Purple', col: '#a678ff', cost: 60 }, { id: 'rainbow', name: 'Rainbow', col: '#e8553d', cost: 150 }
];
const RAINBOW = ['#e8553d', '#ffa33f', '#ffd23f', '#59d98e', '#4aa3ff', '#a678ff'];
const CHARS = [
  { id: 'runner', name: 'Runner', cost: 0 },
  { id: 'warden', name: 'Rift Warden', cost: 0, lock: 'Survive 5,000 m' }
];
const scarfOf = () => SCARVES.find((s) => s.id === equip.scarf) || SCARVES[0];

/* ============ sound (generated, no files) ============ */
let ac = null;
function unlock() {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    if (ac.state === 'suspended') ac.resume();
  } catch (e) { /* no audio */ }
}
function beep(f1, f2, dur, type = 'square', vol = 0.05) {
  if (muted || !ac) return;
  const t = ac.currentTime, o = ac.createOscillator(), g = ac.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f1, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(1, f2), t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(ac.destination);
  o.start(t); o.stop(t + dur);
}

/* ============ pre-drawn backgrounds ============ */
function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }
const TILE = 768;

function makeLayer(seed, color, minH, maxH, minW, maxW, detail) {
  const c = document.createElement('canvas');
  c.width = TILE; c.height = H;
  const g = c.getContext('2d'), r = rng(seed);
  g.fillStyle = color;
  let x = 0, first = 0;
  while (x < TILE) {
    const bw = Math.min(TILE - x, Math.floor(minW + r() * (maxW - minW)));
    let bh = Math.floor(minH + r() * (maxH - minH));
    if (!first) first = bh;
    if (x + bw >= TILE) bh = first;
    g.fillRect(x, H - bh, bw, bh);
    const d = r();
    if (detail && bw > 36) {
      const cx = x + Math.floor(bw / 2), top = H - bh;
      if (d < 0.22) g.fillRect(cx - 1, top - 16, 2, 16);
      else if (d < 0.4) {
        g.fillRect(cx - 9, top - 16, 18, 3); g.fillRect(cx - 8, top - 14, 16, 10);
        g.fillRect(cx - 7, top - 4, 2, 4); g.fillRect(cx + 5, top - 4, 2, 4);
      }
    }
    x += bw;
  }
  return c;
}
const farLayer = makeLayer(7, COL.far, 110, 200, 40, 90, true);
const midLayer = makeLayer(21, COL.mid, 80, 160, 36, 80, true);
const nearLayer = makeLayer(5, COL.near, 40, 120, 50, 110, false);

function makeTile(seed, paint) {
  const c = document.createElement('canvas');
  c.width = TILE; c.height = H;
  paint(c.getContext('2d'), rng(seed));
  return c;
}
const paintBuilding = (g) => {
  g.fillStyle = '#7b6d78'; g.fillRect(0, 0, TILE, H);
  g.fillStyle = '#716370'; for (let x = 0; x < TILE; x += 24) g.fillRect(x, 0, 12, H);
  g.fillStyle = '#5a4d58'; g.fillRect(0, 200, TILE, H - 200);
  g.fillStyle = '#3f3340'; g.fillRect(0, 198, TILE, 3);
  for (let x = 40; x < TILE; x += 192) {                       // night windows
    g.fillStyle = '#3a2f38'; g.fillRect(x - 3, 66, 50, 72);
    g.fillStyle = '#2c3150'; g.fillRect(x, 70, 44, 64);
    g.fillStyle = '#3a4270'; g.fillRect(x, 70, 44, 3); g.fillRect(x + 21, 70, 2, 64);
    g.fillStyle = '#e9e4c0'; g.fillRect(x + 32, 78, 5, 5);
  }
  for (let x = 136; x < TILE; x += 192) {                      // picture frames
    g.fillStyle = '#3a2f38'; g.fillRect(x, 92, 28, 34);
    g.fillStyle = '#8f8a7a'; g.fillRect(x + 3, 95, 22, 28);
    g.fillStyle = '#6a7d6a'; g.fillRect(x + 3, 110, 22, 13);
  }
};
const paintUnderground = (g, r) => {
  g.fillStyle = '#1c1f2b'; g.fillRect(0, 0, TILE, H);
  for (let i = 0; i < 360; i++) { g.fillStyle = r() < 0.5 ? '#252938' : '#171925'; g.fillRect(Math.floor(r() * TILE), Math.floor(r() * H), 3, 2); }
  g.fillStyle = '#3b4357'; g.fillRect(0, 40, TILE, 8);
  g.fillStyle = '#566179'; g.fillRect(0, 40, TILE, 2);
  g.fillStyle = '#2b3243'; for (let x = 0; x < TILE; x += 96) g.fillRect(x + 8, 38, 6, 12);
  for (let x = 60; x < TILE; x += 192) { g.fillStyle = '#3ad6c0'; g.fillRect(x, 214, 3, 5); g.fillRect(x + 5, 211, 3, 8); g.fillStyle = '#1f6f66'; g.fillRect(x - 1, 219, 10, 2); }
};
const paintTunnel = (g) => {
  g.fillStyle = '#2a3038'; g.fillRect(0, 0, TILE, H);
  g.fillStyle = '#222830'; for (let x = 0; x < TILE; x += 48) g.fillRect(x, 0, 2, H);
  for (let y = 0; y < H; y += 48) g.fillRect(0, y, TILE, 2);
  g.fillStyle = '#566271'; g.fillRect(0, 56, TILE, 9); g.fillRect(0, 80, TILE, 5);
  g.fillStyle = '#7c8a9a'; g.fillRect(0, 56, TILE, 2);
  for (let x = 64; x < TILE; x += 128) { g.fillStyle = '#39414b'; g.fillRect(x - 22, 108, 44, 10); g.fillStyle = '#f6e7a1'; g.fillRect(x - 14, 112, 28, 5); }
  g.fillStyle = '#d9a82a'; for (let x = 0; x < TILE; x += 32) g.fillRect(x, 226, 16, 6);
};

const disc = (g, cx, cy, r, col) => { g.fillStyle = col; for (let dy = -r; dy <= r; dy++) { const h = Math.floor(Math.sqrt(r * r - dy * dy)); g.fillRect(cx - h, cy + dy, h * 2, 1); } };
const fillBg = (g, bands) => bands.forEach((b) => { g.fillStyle = b[0]; g.fillRect(0, b[1], TILE, b[2]); });
const skyline = (g, r, col, minH, maxH, minW, maxW, lit) => {
  let x = 0;
  while (x < TILE) {
    const bw = minW + Math.floor(r() * (maxW - minW)), bh = minH + Math.floor(r() * (maxH - minH));
    g.fillStyle = col; g.fillRect(x, H - bh, bw, bh);
    if (lit) lit(g, r, x, bw, bh);
    x += bw;
  }
};
const paintAlien = (g, r) => {
  fillBg(g, [['#120d2b', 0, H], ['#1a1342', 120, 80], ['#241a5c', 200, 120]]);
  for (let i = 0; i < 90; i++) { g.fillStyle = r() < 0.3 ? '#c9b8ff' : '#6c5bb0'; g.fillRect(Math.floor(r() * TILE), Math.floor(r() * 170), 2, 2); }
  disc(g, 140, 80, 34, '#6a4fc9'); disc(g, 128, 72, 30, '#8468e6'); disc(g, 520, 56, 14, '#3ff2e6'); disc(g, 640, 120, 22, '#d64fa8');
  for (let x = 48; x < TILE; x += 192) { g.fillStyle = '#3ff2e6'; g.fillRect(x, 150, 3, 120); g.fillStyle = '#1c8f88'; g.fillRect(x - 3, 262, 9, 8); }
};
const paintMetro = (g) => {
  fillBg(g, [['#2b3140', 0, H], ['#232938', 0, 60], ['#1a1e29', 262, 58]]);
  g.fillStyle = '#353d50'; for (let x = 0; x < TILE; x += 32) g.fillRect(x, 60, 2, 200);
  for (let x = 96; x < TILE; x += 192) { g.fillStyle = '#3d465c'; g.fillRect(x - 8, 60, 16, 200); g.fillStyle = '#2f6fd6'; g.fillRect(x + 24, 120, 70, 28); g.fillStyle = '#f4f4f8'; g.fillRect(x + 30, 128, 40, 4); g.fillRect(x + 30, 136, 24, 4); }
  g.fillStyle = '#f6e7a1'; for (let x = 0; x < TILE; x += 64) g.fillRect(x + 20, 52, 24, 4);
};
const paintWater = (g, r) => {
  fillBg(g, [['#0c3a5a', 0, H], ['#0a3050', 100, 100], ['#082744', 200, 120]]);
  g.fillStyle = 'rgba(150,220,255,0.08)'; for (let x = 0; x < TILE; x += 96) g.fillRect(x + 20, 0, 22, H);
  for (let i = 0; i < 60; i++) { g.fillStyle = '#7fd0ff'; g.fillRect(Math.floor(r() * TILE), Math.floor(r() * 260), 2, 2); }
  for (let x = 40; x < TILE; x += 192) { g.fillStyle = '#0a2f4a'; g.fillRect(x, 120, 18, 150); g.fillRect(x - 4, 116, 26, 8); g.fillStyle = '#0b3a52'; g.fillRect(x + 60, 170, 14, 100); }
  g.fillStyle = '#1f8f5a'; for (let x = 20; x < TILE; x += 48) { g.fillRect(x, 236, 3, 26); g.fillRect(x + 4, 242, 3, 20); }
};
const paintJungle = (g, r) => {
  fillBg(g, [['#1c3d2a', 0, H], ['#16301f', 160, 160]]);
  for (let x = 30; x < TILE; x += 128) { g.fillStyle = '#3a2a1c'; g.fillRect(x, 0, 18, H); }
  for (let i = 0; i < 26; i++) disc(g, Math.floor(r() * TILE), Math.floor(r() * 110), 14 + Math.floor(r() * 12), r() < 0.5 ? '#2f6b3a' : '#255a31');
  g.fillStyle = '#2a5a30'; for (let x = 70; x < TILE; x += 96) g.fillRect(x, 0, 2, 70 + Math.floor(r() * 60));
  g.fillStyle = 'rgba(255,240,170,0.07)'; for (let x = 0; x < TILE; x += 160) g.fillRect(x + 40, 0, 24, H);
};
const paintFrozen = (g, r) => {
  fillBg(g, [['#a9c7dd', 0, H], ['#c7dcec', 0, 90]]);
  skyline(g, r, '#6f8aa3', 70, 160, 40, 90, (gg, rr, x, bw, bh) => { gg.fillStyle = '#e8f1f8'; gg.fillRect(x, H - bh, bw, 5); });
  for (let i = 0; i < 80; i++) { g.fillStyle = '#ffffff'; g.fillRect(Math.floor(r() * TILE), Math.floor(r() * H), 2, 2); }
};
const paintShip = (g, r) => {
  fillBg(g, [['#7ec3e6', 0, H], ['#a8dcf2', 0, 100], ['#1e6f9f', 200, 120]]);
  g.fillStyle = '#2a86bb'; for (let y = 206; y < H; y += 14) for (let x = 0; x < TILE; x += 48) g.fillRect(x + (y % 28 ? 24 : 0), y, 22, 2);
  const cols = ['#d9482b', '#e0a52b', '#2f78c7', '#3c9a5a'];
  for (let x = 20; x < TILE; x += 96) for (let k = 0; k < 2 + Math.floor(r() * 2); k++) { g.fillStyle = cols[Math.floor(r() * 4)]; g.fillRect(x, 188 - k * 22, 64, 20); g.fillStyle = 'rgba(0,0,0,0.2)'; for (let i = 0; i < 64; i += 8) g.fillRect(x + i, 188 - k * 22, 2, 20); }
  g.fillStyle = '#d9482b'; for (let x = 60; x < TILE; x += 384) { g.fillRect(x, 40, 6, 150); g.fillRect(x - 40, 40, 90, 6); g.fillRect(x + 40, 40, 2, 40); }
};
const paintNeon = (g, r) => {
  fillBg(g, [['#0b0720', 0, H]]);
  skyline(g, r, '#1a1040', 90, 230, 36, 80, (gg, rr, x, bw, bh) => {
    for (let wy = H - bh + 8; wy < H - 10; wy += 12) for (let wx = x + 4; wx < x + bw - 6; wx += 10) if (rr() < 0.45) { gg.fillStyle = rr() < 0.5 ? '#ff3da8' : '#3ff2ff'; gg.fillRect(wx, wy, 5, 6); }
  });
  for (let nx = 70; nx < TILE; nx += 192) { g.fillStyle = '#ff3da8'; g.fillRect(nx, 60, 4, 90); g.fillStyle = '#3ff2ff'; g.fillRect(nx + 14, 80, 4, 70); }
};
const paintTrain = (g) => {
  fillBg(g, [['#10162a', 0, H], ['#182040', 140, 180]]);
  disc(g, 600, 70, 20, '#e9efff');
  g.fillStyle = '#26345c'; for (let x = 0; x < TILE; x += 192) for (let i = 0; i < 90; i++) g.fillRect(x + 96 - i, 150 + i, 2 * i, 1);
  g.fillStyle = '#0a1020'; for (let x = 10; x < TILE; x += 36) { g.fillRect(x, 215, 12, 45); g.fillRect(x - 4, 225, 20, 35); }
  g.fillRect(0, 258, TILE, 62);
};
const paintSky = (g, r) => {
  fillBg(g, [['#2c2a6b', 0, H], ['#6b4a9e', 80, 240], ['#c2607a', 160, 160], ['#e8935a', 230, 90]]);
  g.fillStyle = 'rgba(255,230,210,0.6)'; for (let i = 0; i < 16; i++) g.fillRect(Math.floor(r() * 700), 100 + Math.floor(r() * 120), 50 + Math.floor(r() * 60), 8);
  skyline(g, r, '#2a2350', 120, 260, 30, 70);
};
const paintCollapse = (g, r) => {
  fillBg(g, [['#3a1d1a', 0, H], ['#6e2e1f', 120, 200], ['#c2542a', 220, 100]]);
  skyline(g, r, '#1a0f10', 90, 240, 34, 74, (gg, rr, x, bw, bh) => { gg.fillStyle = '#ff7a2a'; gg.fillRect(x + 4, H - bh - 4, 8, 4); gg.fillStyle = '#ffb347'; gg.fillRect(x + 6, H - bh - 8, 4, 4); });
  g.fillStyle = 'rgba(30,20,20,0.55)'; for (let sx = 40; sx < TILE; sx += 200) g.fillRect(sx, 0, 26, 190);
};

const patTrain = (x, y, w) => { for (let wx = 14; wx < w - 14; wx += 26) rf('#ffd98a', x + wx, y + 14, 14, 10); rf('#c9a227', x, y + 32, w, 3); };
const patShip = (x, y, w) => { ctx.fillStyle = 'rgba(0,0,0,0.2)'; for (let i = 3; i < w; i += 7) ctx.fillRect(x + i, y + 4, 2, H - y); };

const WORLDS = [
  { id: 'building', name: 'Abandoned Apartment', tip: 'Stay low under lamps and fans. Jump the furniture.',
    tile: makeTile(11, paintBuilding), floorY: 250, ceilAbove: [130, 130], pit: 0,
    floorTop: '#9a7a54', floorBody: '#4d3b33', floorLine: '#33261f', ceilBody: '#4d4350', ceilEdge: '#33293a',
    obs: [['sofa', 3], ['table', 3], ['box', 2], ['lamp', 3], ['fan', 2]] },
  { id: 'underground', name: 'Underground Tunnels', tip: 'Low ceilings, pits and stalactites. Do not jump too high.',
    tile: makeTile(23, paintUnderground), floorY: 250, ceilAbove: [70, 135], pit: 0.35,
    floorTop: '#5c5666', floorBody: '#2a2733', floorLine: '#1b1922', ceilBody: '#23212b', ceilEdge: '#14131a',
    obs: [['rock', 4], ['pipe', 2], ['stalac', 3]] },
  { id: 'tunnel', name: 'Industrial Tunnel', tip: 'Pistons change height. Watch hanging fans and cables.',
    tile: makeTile(37, paintTunnel), floorY: 250, ceilAbove: [110, 125], pit: 0.25,
    floorTop: '#8a96a4', floorBody: '#363d47', floorLine: '#22272e', ceilBody: '#323943', ceilEdge: '#20252c',
    obs: [['barrel', 3], ['piston', 4], ['fan', 2], ['cable', 2]] },
  { id: 'alien', name: 'Another World', tip: 'Vanishing platforms and energy barriers. Gravity gets weird.',
    tile: makeTile(41, paintAlien), free: true, open: true, thin: true, yr: [175, 255], rise: [0, 40], drop: [0, 60], gapMul: 0.6, w: [120, 220],
    crumble: 0.28, lowg: true, lead: 150, tail: 50, sep: 90,
    floorTop: '#6df5ff', floorBody: '#2a1f5a', floorLine: '#3b2d86', obs: [['barrier', 4], ['pylon', 3]] },
  { id: 'metro', name: 'Metro Station', tip: 'Trains arrive without warning. Mind the track gaps.',
    tile: makeTile(53, paintMetro), floorY: 250, ceilAbove: [125, 125], pit: 0.3, metro: true,
    floorTop: '#e8d36a', floorBody: '#3a4256', floorLine: '#252b3a', ceilBody: '#2a303f', ceilEdge: '#1a1e29',
    obs: [['bench', 3], ['spark', 3], ['sign', 3]] },
  { id: 'water', name: 'Water Dive', tip: 'Tap to swim up. You sink slowly. Stay clear of floating debris.',
    tile: makeTile(67, paintWater), floorY: 250, ceilAbove: [170, 170], pit: 0, water: true,
    floorTop: '#6a8f8a', floorBody: '#1d4a55', floorLine: '#123642', ceilBody: '#0f4a78', ceilEdge: '#7fd0ff',
    obs: [['pillar', 3], ['rock', 2], ['debris', 3]] },
  { id: 'jungle', name: 'Jungle Canopy', tip: 'Broken bridges and swinging vines. Do not jump under branches.',
    tile: makeTile(71, paintJungle), free: true, open: true, thin: true, yr: [180, 252], rise: [0, 35], drop: [0, 50], gapMul: 0.55, w: [120, 230],
    move: 0.3, lead: 130, tail: 50, sep: 90,
    floorTop: '#9a6b3a', floorBody: '#5c3d22', floorLine: '#3b2615', obs: [['log', 3], ['branch', 3], ['vine', 3]] },
  { id: 'frozen', name: 'Frozen City', tip: 'The ice is slippery. You skid forward when you land.',
    tile: makeTile(83, paintFrozen), floorY: 250, open: true, ceilAbove: [999, 999], pit: 0.2, ice: true, leadMul: 1.3,
    floorTop: '#e8f4ff', floorBody: '#7fa8c4', floorLine: '#5f87a3', obs: [['iceblock', 3], ['icicle', 3], ['snowbox', 2]] },
  { id: 'ship', name: 'Cargo Ship', tip: 'The ship rocks, so platforms shift. Mind the swinging cargo.',
    tile: makeTile(97, paintShip), free: true, open: true, yr: [205, 250], rise: [0, 20], drop: [0, 30], gapMul: 0.5, w: [140, 220], amp: 8,
    lead: 130, tail: 50, sep: 90, pat: patShip,
    floorTop: '#e8e8ef', floorBody: '#c0482e', floorLine: '#8f321f', obs: [['container', 3], ['rope', 2], ['cargo', 3]] },
  { id: 'neon', name: 'Neon City', tip: 'Holo barriers blink on and off. Drones hover low.',
    tile: makeTile(101, paintNeon), free: true, open: true, thin: true, yr: [175, 250], rise: [0, 35], drop: [0, 50], gapMul: 0.55, w: [120, 220],
    move: 0.3, lead: 130, tail: 50, sep: 90,
    floorTop: '#ff3da8', floorBody: '#2a1458', floorLine: '#3ff2ff', obs: [['holo', 4], ['gate', 2], ['drone', 3]] }
];

// challenges at fixed distances (not part of the random portal pool)
const CHALL = {
  train: { id: 'train', challenge: true, name: 'Train Escape', tip: 'Run across the carriages and jump the couplings.', len: 300,
    tile: makeTile(113, paintTrain), free: true, open: true, yr: [218, 248], rise: [0, 10], drop: [0, 10], gap: [22, 40], w: [200, 260],
    lead: 110, tail: 70, sep: 90, pat: patTrain,
    floorTop: '#d8dde6', floorBody: '#27406e', floorLine: '#c9a227', obs: [['rail', 3], ['signal', 3], ['cable', 2]] },
  sky: { id: 'sky', challenge: true, name: 'Sky Challenge', tip: 'Suspended platforms and cranes. Watch the moving ones.', len: 300,
    tile: makeTile(127, paintSky), free: true, open: true, thin: true, yr: [150, 255], rise: [0, 45], drop: [0, 65], gapMul: 0.62, w: [110, 200],
    move: 0.4, lead: 130, tail: 50, sep: 90,
    floorTop: '#cfd4e0', floorBody: '#5a607a', floorLine: '#3a4058', obs: [['crane', 3], ['box', 2]] },
  collapse: { id: 'collapse', challenge: true, name: 'City Collapse', tip: 'Rooftops crumble once you land. Keep moving!', len: 350,
    tile: makeTile(131, paintCollapse), free: true, open: true, yr: [170, 255], rise: [0, 40], drop: [0, 60], gapMul: 0.55, w: [130, 230],
    crumble: 0.45, lead: 130, tail: 50, sep: 90,
    floorTop: '#c9c0b8', floorBody: '#6a5a52', floorLine: '#3a2f2a', obs: [['box', 3], ['rock', 2], ['pipe', 2]] }
};
const EVENTS = ['car', 'train', 'sky', 'collapse'];

/* ============ obstacles ============ */
const OBS = {
  box: { w: [14, 24], h: [12, 18] }, sofa: { w: [30, 34], h: [12, 12] }, table: { w: [20, 24], h: [15, 17] },
  rock: { w: [14, 22], h: [10, 16] }, pipe: { w: [34, 38], h: [8, 10] }, barrel: { w: [12, 16], h: [14, 22] },
  piston: { w: [16, 18], h: [14, 14] },
  lamp: { w: [12, 14], hang: 1 }, fan: { w: [28, 30], hang: 1 }, stalac: { w: [10, 14], hang: 1 }, cable: { w: [5, 6], hang: 1 },
  barrier: { w: [8, 10], h: [20, 24] }, pylon: { w: [8, 10], hang: 1 },
  bench: { w: [26, 30], h: [12, 14] }, spark: { w: [18, 22], h: [14, 16] }, sign: { w: [24, 28], hang: 1 }, train: { w: [56, 56], h: [18, 18] },
  pillar: { w: [14, 18], h: [26, 46] }, debris: { w: [16, 20], h: [12, 14], float: 44 },
  log: { w: [24, 28], h: [12, 14] }, branch: { w: [26, 30], hang: 1 }, vine: { w: [4, 5], hang: 1, sw: 14 },
  iceblock: { w: [16, 22], h: [14, 20] }, icicle: { w: [8, 12], hang: 1 }, snowbox: { w: [18, 24], h: [12, 18] },
  container: { w: [30, 36], h: [18, 22] }, rope: { w: [4, 5], hang: 1, sw: 12 }, cargo: { w: [16, 18], hang: 1, sw: 20 },
  holo: { w: [8, 10], h: [20, 24], blink: 1 }, gate: { w: [8, 10], hang: 1 }, drone: { w: [16, 18], h: [8, 8], float: 56, bob: 10 },
  rail: { w: [22, 26], h: [10, 12] }, signal: { w: [8, 10], hang: 1 }, crane: { w: [12, 14], hang: 1 }
};
const rf = (c, x, y, w, h) => { ctx.fillStyle = c; ctx.fillRect(x, y, w, h); };
let anim = 0;
const blinkOn = (o) => ((simFrames + Math.floor(o.ph * 10)) % 110) < 70;
const DRAW = {
  box(x, y, w, h) { rf(COL.ink, x, y, w, h); rf('#8a8a99', x + 2, y + 2, w - 4, h - 4); rf(COL.ink, x + 2, y + (h >> 1), w - 4, 1); },
  sofa(x, y, w, h) { rf('#4a2f3a', x, y + 2, w, h - 2); rf('#7a4b5b', x + 3, y, w - 6, 6); rf('#5d3a48', x, y + 2, 4, h - 2); rf('#5d3a48', x + w - 4, y + 2, 4, h - 2); },
  table(x, y, w, h) { rf('#8b5e3c', x, y, w, 3); rf('#5a3c26', x + 2, y + 3, 2, h - 3); rf('#5a3c26', x + w - 4, y + 3, 2, h - 3); },
  rock(x, y, w, h) { ctx.fillStyle = '#5a5a69'; for (let r = 0; r < h; r++) { const i = Math.floor((h - 1 - r) * w / (2 * h)); ctx.fillRect(x + i, y + r, w - 2 * i, 1); } },
  pipe(x, y, w, h) { rf('#6f7d8c', x, y, w, h); rf('#9aa8b8', x, y, w, 2); rf('#4c5663', x, y, 3, h); rf('#4c5663', x + w - 3, y, 3, h); },
  barrel(x, y, w, h) { rf('#b5651d', x, y, w, h); rf('#6b3a0e', x, y + 3, w, 1); rf('#6b3a0e', x, y + h - 4, w, 1); },
  piston(x, y, w, h) { rf('#c9a227', x, y, w, h); rf('#3a3a47', x, y, w, 2); rf('#3a3a47', (x + w / 2 - 1) | 0, y + 2, 2, Math.max(0, h - 2)); },
  lamp(x, y, w, h) { rf('#2a2a33', x + (w >> 1), y, 1, h - 8); rf('#e8c56a', x, y + h - 8, w, 8); rf('#fff3b0', x + 2, y + h - 3, w - 4, 3); },
  fan(x, y, w, h) { rf('#2a2a33', x + (w >> 1), y, 2, h - 6); const a = (anim >> 1) & 1; rf('#cfcfd8', a ? x : x + 5, y + h - 5, a ? w : w - 10, 2); rf('#8f8f9b', x + (w >> 1) - 2, y + h - 7, 5, 4); },
  stalac(x, y, w, h) { ctx.fillStyle = '#4a4a5a'; for (let r = 0; r < h; r++) { const i = Math.floor(r * w / (2 * h)); ctx.fillRect(x + i, y + r, w - 2 * i, 1); } },
  cable(x, y, w, h) { rf('#222', x, y, w, h); rf('#ffcf33', x - 1, y + h - 3, w + 2, 3); },
  barrier(x, y, w, h) { rf('rgba(255,61,168,0.3)', x - 3, y, w + 6, h); rf('#ff3da8', x, y, w, h); rf('#fff', x + (w >> 1) - 1, y, 2, h); },
  pylon(x, y, w, h) { rf('#3ff2e6', x + (w >> 1) - 1, y, 2, h - 6); rf('#d8fffb', x, y + h - 8, w, 8); rf('#3ff2e6', x + 2, y + h - 3, w - 4, 3); },
  bench(x, y, w, h) { rf('#7a5a3a', x, y, w, 4); rf('#4a3622', x + 2, y + 4, 3, h - 4); rf('#4a3622', x + w - 5, y + 4, 3, h - 4); },
  spark(x, y, w, h) { rf('#4c5663', x, y + h - 5, w, 5); rf('#f6e7a1', x + 2 + ((anim >> 2) % Math.max(1, w - 4)), y + ((anim >> 1) & 1 ? 0 : 3), 3, h - 6); rf('#6fd0ff', x + w - 6 - ((anim >> 2) % Math.max(1, w - 8)), y + 3, 2, h - 8); },
  sign(x, y, w, h) { rf('#2a2a33', x + (w >> 1), y, 1, h - 10); rf('#2f6fd6', x, y + h - 10, w, 10); rf('#f4f4f8', x + 3, y + h - 7, w - 6, 2); },
  train(x, y, w, h) { rf('#c9d2de', x, y, w, h); rf('#2f6fd6', x, y + h - 5, w, 3); for (let i = 4; i < w - 8; i += 18) rf('#ffd98a', x + i, y + 3, 10, 6); rf('#f6e7a1', x, y + h - 9, 3, 3); },
  pillar(x, y, w, h) { rf('#5f7c80', x, y, w, h); rf('#7f9fa4', x - 2, y, w + 4, 4); rf('#41585c', x + 3, y + 6, 2, Math.max(0, h - 8)); },
  debris(x, y, w, h) { rf('#6b4a2e', x, y, w, h); rf('#8f6a42', x + 2, y + 2, w - 6, 3); rf('#4a321e', x + w - 6, y + h - 4, 6, 4); },
  log(x, y, w, h) { rf('#6b4a2e', x, y, w, h); rf('#8f6a42', x, y, w, 3); rf('#4a321e', x + w - 4, y + 2, 3, h - 4); },
  branch(x, y, w, h) { rf('#4a321e', x + (w >> 1) - 1, y, 3, h); rf('#4a321e', x, y + h - 5, w, 4); rf('#2f6b3a', x + 2, y + h - 9, 8, 5); rf('#2f6b3a', x + w - 10, y + h - 9, 8, 5); },
  vine(x, y, w, h) { rf('#2f7a3a', x, y, w, h); rf('#59d98e', x - 1, y + h - 4, w + 2, 4); },
  iceblock(x, y, w, h) { rf('#9fd8f2', x, y, w, h); rf('#e8f8ff', x + 2, y + 2, w - 6, 3); rf('#6fb4d6', x, y + h - 3, w, 3); },
  icicle(x, y, w, h) { rf('#bfe6f8', x + (w >> 1) - 1, y, 2, h - 14); ctx.fillStyle = '#bfe6f8'; for (let r = 0; r < 14; r++) { const i = Math.floor(r * w / 28); ctx.fillRect(x + i, y + h - 14 + r, w - 2 * i, 1); } },
  snowbox(x, y, w, h) { DRAW.box(x, y, w, h); rf('#fff', x, y, w, 3); },
  container(x, y, w, h) { rf('#2f78c7', x, y, w, h); rf('rgba(0,0,0,0.2)', x + 2, y + 2, 1, h - 4); for (let i = 5; i < w - 2; i += 5) rf('rgba(0,0,0,0.2)', x + i, y + 2, 1, h - 4); rf('#1b4f8a', x, y, w, 2); },
  rope(x, y, w, h) { rf('#c9a76a', x, y, w, h); },
  cargo(x, y, w, h) { rf('#c9a76a', x + (w >> 1), y, 1, h - 12); rf('#a0522d', x, y + h - 12, w, 12); rf('#6b3410', x + 2, y + h - 10, w - 4, 2); },
  holo(x, y, w, h, o) { const on = o && blinkOn(o); rf(on ? '#3ff2ff' : 'rgba(63,242,255,0.18)', x, y, w, h); if (on) rf('#fff', x + (w >> 1), y, 1, h); },
  gate(x, y, w, h) { rf('#2a2a33', x + (w >> 1), y, 2, h - 10); rf('#9fa6bb', x, y + h - 10, w, 10); rf('#3ff2ff', x + 2, y + h - 6, w - 4, 3); if ((anim >> 1) & 1) rf('#fff', x + (w >> 1), y + h, 1, 6); },
  drone(x, y, w, h) { rf('#2a2a33', x, y + 3, w, 5); rf('#ff3da8', x + (w >> 1) - 1, y + 4, 3, 2); rf('#9fa6bb', x - 3, y + 1, 6, 2); rf('#9fa6bb', x + w - 3, y + 1, 6, 2); },
  rail(x, y, w, h) { for (let i = 0; i < w; i += 8) rf((i >> 3) & 1 ? '#f4f4f8' : '#e8553d', x + i, y, 8, h); rf(COL.ink, x, y + h - 2, w, 2); },
  signal(x, y, w, h) { rf('#2a2a33', x + (w >> 1) - 1, y, 2, h - 10); rf('#14141b', x, y + h - 10, w, 10); rf('#e8553d', x + 2, y + h - 8, w - 4, 4); },
  crane(x, y, w, h) { rf('#e0a52b', x + (w >> 1) - 2, y, 4, h - 8); rf('#2a2a33', x + (w >> 1), y + h - 8, 1, 6); rf('#9fa6bb', x + (w >> 1) - 3, y + h - 3, 7, 3); }
};

/* ============ game state ============ */
let state = 'ready';               // ready | play | paused | dead | carintro
let frames = 0, simFrames = 0, bgScroll = 0;
let speed = START_SPEED, baseSpeed = START_SPEED, speedScale = 1, rampFrames = 0, iceBoost = 0, dist = 0, lastMile = 0;
let plats = [], obs = [], birds = [], parts = [], coins = [], portals = [];
let gen = { world: null, car: false, wStart: 0, wLen: 1, endDist: 0, exitPlaced: false, history: [] };
let viewWorld = null, trans = null, nextPortal = PORTAL_FIRST, nextEvent = EVENT_FIRST, evIdx = 0, toastT = 0;
let py = 0, vy = 0, grounded = true, coyote = 0, jumpBuf = 0, airFrames = 0, held = false, strokeCd = 0;
let ex = PX, rot = 0, dvx = 0, shake = 0, deadT = 0, invuln = 0, lowG = false, lowGPrev = false, metroT = 200;
let finalDist = 0, runMs = 0, isBest = false, runCoins = 0, revives = 0, overToken = 0;
let car = null, kLeft = false, kRight = false, kJump = false;
const CX = PX + 10;                // the car's screen x

const mkPlat = (o) => {
  const p = Object.assign({ world: null, ceil: null, ceilAbove: 999, gb: 0, special: false, ramp: 0, rh: 0, crumble: false, cs: 0, ct: 0, fv: 0, amp: 0, per: 1, ph: 0 }, o);
  if (p.by === undefined) p.by = p.y;
  p.py = p.y;
  return p;
};
const lastEnd = () => { const p = plats[plats.length - 1]; return p.x + p.w; };

function reset() {
  plats = [mkPlat({ x: -60, w: 520, y: 230 })];
  obs = []; birds = []; parts = []; coins = []; portals = [];
  gen = { world: null, car: false, wStart: 0, wLen: 1, endDist: 0, exitPlaced: false, history: [] };
  nextPortal = PORTAL_FIRST; nextEvent = EVENT_FIRST; evIdx = 0;
  viewWorld = null; trans = null; toastT = 0; car = null; kLeft = kRight = kJump = false;
  spawnBirds(230, 440, 4, 230);
  py = 230; vy = 0; grounded = true; coyote = 0; jumpBuf = 0; airFrames = 0; held = false; strokeCd = 0;
  speed = baseSpeed = START_SPEED; speedScale = 1; rampFrames = 0; iceBoost = 0; dist = 0; lastMile = 0; simFrames = 0;
  ex = PX; rot = 0; dvx = 0; shake = 0; deadT = 0; invuln = 0; lowG = false; lowGPrev = false; metroT = 200;
  isBest = false; runCoins = 0; revives = 0;
  $('toast').hidden = true;
  while (lastEnd() < W + 260) addPlatform();
}

function spawnBirds(from, to, n, y) {
  for (let i = 0; i < n; i++) birds.push({ x: rand(from, to), y, fly: false, vx: 0, vy: 0, t: 0 });
}

function pickWorld() {
  const n = Math.min(gen.history.length, Math.floor(WORLDS.length / 3));
  const recent = n ? gen.history.slice(-n) : [];
  const pool = WORLDS.filter((w) => !recent.includes(w.id));
  return pool[Math.floor(Math.random() * pool.length)];
}

const ROOF = { yr: [165, 262], rise: [0, 45], drop: [0, 70], gapMul: 0.68 };

function addPlatform() {
  const last = plats[plats.length - 1];
  const lb = last.by;
  const wd = gen.world;
  const v = Math.min(MAX_SPEED, baseSpeed * (wd ? WORLD_SPEED : 1) + 0.8);   // worlds run slower, so gaps shrink with them
  const predicted = (x) => dist + (x - PX) / M;
  let ny, gap, w, ceil = null, ceilAbove = 999, ramp = 0, crumble = false, amp = 0;

  if (gen.car) {                                                    // stunt car terrain: roofs with ramps
    ny = clamp(lb + rand(-18, 18), 190, 250); gap = ri([70, 110]); w = ri([260, 340]); ramp = 70;
    if (car && !car.endPlaced && car.t >= CAR_TIME - 120) { car.endPlaced = true; ramp = 0; w = 640; }   // flat runway to climb out of the car
  } else if (!wd || wd.free) {                                      // rooftops and open-air worlds
    const P = wd || ROOF;
    const up = Math.random() < 0.5 ? rand(P.rise[0], P.rise[1]) : -rand(P.drop[0], P.drop[1]);   // + = next roof is higher
    ny = clamp(lb - up, P.yr[0], P.yr[1]);
    const prog = clamp((dist - gen.wStart) / gen.wLen, 0, 1);
    crumble = !!(wd && wd.crumble) && Math.random() < wd.crumble * (0.5 + prog);
    amp = wd && wd.amp ? wd.amp : (wd && wd.move && !crumble && !last.amp && !last.special && Math.random() < wd.move ? 12 : 0);
    const dh = lb - ny + (amp || last.amp ? 24 : 0);
    const t = (-JUMP + Math.sqrt(JUMP * JUMP - 2 * G * dh)) / G;    // air time back to the new roof's height
    const minGap = 24 + v * 4, maxGap = v * t * P.gapMul;           // always inside a full jump
    gap = P.gap ? ri(P.gap) : minGap + Math.random() * Math.max(0, maxGap - minGap) * (crumble ? 0.4 : 1);
    w = crumble ? ri([110, 150]) : P.w ? ri(P.w) : Math.floor(110 + Math.random() * 170 + v * 20);
    if (amp && !(wd && wd.amp)) w = ri([110, 150]);
  } else {                                                          // closed, flat worlds (rooms, tunnels, water)
    ny = wd.floorY;
    if (!wd.open) { ceilAbove = ri(wd.ceilAbove); ceil = ny - ceilAbove; }
    const minGap = 24 + v * 4, maxGap = v * 35 * 0.5;
    const canPit = wd.pit > 0 && ceilAbove >= 110 && last.ceilAbove >= 110 && !last.special;
    gap = canPit && Math.random() < wd.pit ? minGap + Math.random() * Math.max(0, maxGap - minGap) : 0;
    w = Math.floor(200 + Math.random() * 160 + v * 10);
  }

  const x = gap ? last.x + last.w + gap : last.x + last.w - 1;
  let special = null;
  if (!gen.car) {
    if (!wd && predicted(x + 160) >= nextPortal) special = 'enter';
    else if (!wd && predicted(x + 160) >= nextEvent) special = 'event';
    else if (wd && !gen.exitPlaced && predicted(x + 160) >= gen.endDist) special = 'exit';
    if (special) { w = Math.max(w, Math.ceil(240 + 40 * v)); crumble = false; amp = 0; }   // room to see the flash and react
  }

  const p = mkPlat({ x, w, y: ny, world: wd, ceil, ceilAbove, gb: gap, special: !!special, ramp, rh: ramp ? 26 : 0, crumble, amp,
    per: wd && wd.amp ? rand(40, 60) : rand(70, 120), ph: rand(0, 6.28) });
  plats.push(p);

  if (special === 'enter') {
    portals.push({ kind: 'enter', x: x + 160, top: ny, h: PORTAL_H, def: pickWorld() });
    nextPortal += PORTAL_EVERY;
  } else if (special === 'event') {
    const ev = EVENTS[evIdx % EVENTS.length]; evIdx++;
    nextEvent += EVENT_EVERY; if (nextEvent % 5000 === 0) nextEvent += EVENT_EVERY;
    portals.push({ kind: 'event', ev, x: x + 160, top: ny, h: 70, w: ev === 'car' ? 30 : 12 });
  } else if (special === 'exit') {
    portals.push({ kind: 'exit', x: x + 160, top: ny, h: ceil === null ? 110 : Math.max(60, Math.min(110, ny - ceil - 6)), def: null });
    gen.exitPlaced = true; gen.world = null;                        // everything after this is rooftops again
  } else if (!gen.car && !p.crumble && (!p.amp || (wd && wd.amp))) {
    placeObstacles(p, gap, v, wd);
  }
  placeCoins(p, gap, last, wd);
  if (!wd && !gen.car) spawnBirds(p.x + 24, p.x + w - 24, Math.floor(Math.random() * 5), ny);
}

// how far past the platform start a full-length jump can land, plus time to react
const jumpLead = (gap, v) => (gap > 0 ? Math.max(60, 44 * v - gap + 10) : 60);

function placeObstacles(p, gap, v, wd) {
  if (!wd) {                                                       // rooftop crates
    const big = Math.random() < 0.4, ow = big ? 24 : 14, oh = big ? 12 : 18;
    const lead = jumpLead(gap, v), tail = 40 + v * 12;
    if (dist > 30 && p.w >= lead + ow + tail && Math.random() < 0.6) {
      obs.push({ kind: 'box', x: p.x + lead + Math.random() * (p.w - lead - ow - tail), y: p.y - oh, w: ow, h: oh, base: p.y, pl: p, ph: 0 });
    }
    return;
  }
  let cx = p.x + (wd.lead !== undefined ? wd.lead : jumpLead(gap, v) * (wd.leadMul || 1));
  const end = p.x + p.w - (wd.tail !== undefined ? wd.tail : 40 + v * 12);
  const sep = wd.sep !== undefined ? wd.sep : 100 + v * 14;
  for (let n = 0; n < 3; n++) {
    let kind = pick(wd.obs);
    if (OBS[kind].hang && !wd.open && p.ceilAbove < 80) kind = wd.obs.find((e) => !OBS[e[0]].hang)[0];
    const d = OBS[kind], ow = ri(d.w);
    if (cx + ow > end) break;
    const o = { kind, x: cx, w: ow, base: p.y, pl: p, ph: rand(0, 6.28) };
    if (d.hang) { o.y = p.ceil !== null ? p.ceil : 0; o.h = (p.y - HANG) - o.y; }
    else { o.h = ri(d.h); o.y = p.y - o.h - (d.float || 0); if (d.float) o.fy = o.y; }
    obs.push(o);
    cx += ow + sep + rand(0, 70);
  }
}

function placeCoins(p, gap, last, wd) {
  if (gap > 30) {                                                  // an arc to reward the jump
    const n = gap > 80 ? 5 : 3;
    for (let i = 0; i < n; i++) {
      const t = (i + 1) / (n + 1);
      coins.push({ x: last.x + last.w + gap * t, y: last.y + (p.y - last.y) * t - 14 - Math.sin(Math.PI * t) * 46 });
    }
  }
  if (p.special || gen.car || Math.random() > (wd ? 0.95 : 0.7)) return;
  const n = wd ? ri([5, 9]) : ri([3, 6]), air = Math.random() < 0.3;
  const sx = p.x + rand(40, Math.max(41, p.w - 40 - n * 14));
  for (let i = 0; i < n; i++) {
    const cx = sx + i * 14;
    if (obs.some((o) => o.x - 18 < cx + 4 && cx - 4 < o.x + o.w + 18)) continue;
    coins.push({ x: cx, y: p.y - (air && !(wd && wd.water) ? 52 : 12) });
  }
}

/* ============ portals, worlds and challenges ============ */
function showToast(title, sub, frames) {
  $('toast-title').textContent = title; $('toast-sub').textContent = sub || '';
  $('toast').hidden = false; toastT = frames || 150;
}
function enterWorld(def) {
  const cur = plats.find((p) => p.x <= PX && p.x + p.w >= PX) || plats[0];
  plats = plats.filter((p) => p.x <= cur.x);                       // drop everything ahead
  obs = obs.filter((o) => o.x < PX - 30); coins = coins.filter((c) => c.x < PX - 30);
  birds = []; portals = [];
  cur.world = def; cur.special = true; cur.cs = 0;
  if (def.free) { cur.ceil = null; cur.ceilAbove = 999; }
  else { cur.y = def.floorY; cur.by = def.floorY; cur.ceilAbove = def.open ? 999 : def.ceilAbove[0]; cur.ceil = def.open ? null : def.floorY - cur.ceilAbove; }
  if (def.amp) { cur.amp = def.amp; cur.per = rand(40, 60); cur.ph = rand(0, 6.28); }
  py = cur.y; vy = 0; grounded = true;
  gen.world = def; if (!def.challenge) gen.history.push(def.id);
  gen.wStart = dist; gen.wLen = def.len || ri(WORLD_LEN); gen.endDist = dist + gen.wLen; gen.exitPlaced = false;
  viewWorld = def; metroT = 200; strokeCd = 0;
  showToast(def.name, def.tip);
  while (lastEnd() < W + 260) addPlatform();
  obs = obs.filter((o) => o.x > PX + 320);                         // calm start: nothing in the first stretch
}
function exitWorld() {
  const was = viewWorld;
  plats.forEach((p) => { p.world = null; p.ceil = null; p.ceilAbove = 999; });
  viewWorld = null; iceBoost = 0; lowG = false; lowGPrev = false;
  if (was && was.challenge) { runCoins += 25; wallet += 25; showToast('Escaped!', '+25 coins'); beep(500, 1100, 0.25, 'triangle', 0.07); }
  else showToast('Back on the rooftops', '');
}
function unlockWarden() {
  warden = true; store.set('rr_warden', '1'); owned.add('char:warden'); saveCostumes();
  showToast('Rift Warden unlocked!', 'Equip it in Costumes > Runner', 240);
  beep(500, 800, 0.15, 'triangle', 0.08); setTimeout(() => beep(800, 1300, 0.25, 'triangle', 0.08), 160);
}
function spawnTrain() {
  const P = plats.find((p) => p.x <= PX && p.x + p.w >= PX);
  if (!P || P.crumble || P.x + P.w < W + 90 || obs.some((o) => o.x > PX - 10 && o.x < W + 90)) { metroT = 40; return; }
  obs.push({ kind: 'train', x: W + 30, y: P.y - 18, w: 56, h: 18, base: P.y, vx: -2.2, ph: 0 });
  metroT = 260 + Math.floor(rand(0, 140));
  showToast('Train incoming', '', 50); beep(160, 120, 0.4, 'sawtooth', 0.05);
}

/* ============ stunt car challenge ============ */
function startCar() {
  const cur = plats.find((p) => p.x <= PX && p.x + p.w >= PX) || plats[0];
  plats = plats.filter((p) => p.x <= cur.x);
  obs = obs.filter((o) => o.x < PX - 30); coins = coins.filter((c) => c.x < PX - 30);
  birds = []; portals = [];
  cur.ramp = 70; cur.rh = 26; cur.special = true;
  gen.car = true;
  car = { y: cur.y, vy: 0, ang: 0, av: 0, rot: 0, air: false, t: 0, pts: 0, combo: 0, boost: false, endPlaced: false };
  kLeft = kRight = kJump = false; held = false;
  state = 'carintro'; show('car');
  while (lastEnd() < W + 260) addPlatform();
}
function beginCar() {
  if (state !== 'carintro') return;
  state = 'play'; show(null); kLeft = kRight = kJump = false;
}
function groundAt(x) {
  for (const p of plats) {
    if (x >= p.x && x <= p.x + p.w) {
      let h = 0, slope = 0;
      if (p.ramp && x > p.x + p.w - p.ramp) { h = p.rh * (x - (p.x + p.w - p.ramp)) / p.ramp; slope = Math.atan2(p.rh, p.ramp); }
      return { p, y: p.y - h, slope };
    }
  }
  return null;
}
function landCar(g) {
  const TAU = Math.PI * 2;
  car.y = g.y;
  // Judge only how far the car spun. The old check also counted the nose-up tilt from the ramp,
  // which made a frontflip need ~0.7 rad more spin than a backflip.
  const a = (((car.rot + Math.PI) % TAU) + TAU) % TAU - Math.PI;
  const flips = Math.floor((Math.abs(car.rot) + 1.0) / TAU);
  const ok = Math.abs(a) < 1.0;
  const dir = car.rot < 0 ? 'Backflip' : 'Frontflip';
  car.air = false; car.vy = 0; car.av = 0;
  if (ok) {
    const pts = Math.round((50 + flips * 200) * (1 + (flips ? Math.min(car.combo, 8) * 0.5 : 0)));
    car.combo = flips ? car.combo + 1 : 0; car.pts += pts;
    showToast(flips ? dir + (flips > 1 ? ' x' + flips : '') + (car.combo > 1 ? '  combo x' + car.combo : '') : 'Clean landing', '+' + pts, 70);
    beep(500, 900, 0.12, 'triangle', 0.07);
  } else {
    car.combo = 0; shake = reduceMotion ? 0 : 9;
    showToast('Rough landing', '', 60); beep(150, 60, 0.2, 'sawtooth', 0.07);
  }
  car.ang = -g.slope; car.rot = 0;
}
function exitCar(p) {
  const bonus = Math.floor(car.pts / 25);
  runCoins += bonus; wallet += bonus;
  car = null; gen.car = false; kLeft = kRight = kJump = false;
  plats = plats.filter((q) => q.x <= p.x); p.ramp = 0; p.rh = 0; p.special = true;
  obs = obs.filter((o) => o.x < PX - 30); coins = coins.filter((c) => c.x < CX); portals = [];
  py = p.y; vy = 0; grounded = true; coyote = COYOTE; invuln = SAFE_FRAMES;
  trans = { t: 0, kind: 'flash', def: null };
  showToast('Stunts done', '+' + bonus + ' coins', 120); beep(500, 1100, 0.25, 'triangle', 0.07);
  while (lastEnd() < W + 260) addPlatform();
}
function carUpdate() {
  car.t++;
  const g = groundAt(CX);
  if (!car.air) {
    if (!g) {                                                       // drove off the end of a ramp
      car.air = true; car.rot = 0; car.av = 0;
      car.vy = -(speed * 26 / 70 + 4.6 + (car.boost ? 3.4 : 0)); car.boost = false;
      beep(250, 600, 0.18, 'square', 0.05);
    } else {
      car.y = g.y;
      if (g.slope && kJump) car.boost = true;                       // hold space on the ramp to launch higher
      car.ang += (-g.slope - car.ang) * 0.35;
    }
  } else {
    car.vy += 0.42; car.y += car.vy;
    car.av = kLeft ? -0.16 : kRight ? 0.16 : car.av * 0.8;
    car.ang += car.av; car.rot += car.av;
    if (g && car.vy > 0 && car.y >= g.y) landCar(g);
  }
  collectCoins(CX - 12, CX + 12, car.y - 16, car.y + 2);
  if (car.y > H + 40) { die('fall'); return; }
  if (car.t >= CAR_TIME && !car.air && g && !g.p.ramp && g.p.x + g.p.w - CX > 220) exitCar(g.p);
}

function collectCoins(l, r, top, bottom) {
  for (const c of coins) {
    const reach = COIN_R + COIN_PAD;
    if (!c.got && c.x + reach > l && c.x - reach < r && c.y + reach > top && c.y - reach < bottom) {
      c.got = true; runCoins++; wallet++;
      beep(900, 1300, 0.05, 'square', 0.03);
    }
  }
  coins = coins.filter((c) => !c.got);
}

/* ============ revive ============ */
function reviveCost() {
  const density = runCoins / Math.max(finalDist, 100);              // coins per metre this run
  return Math.min(150, Math.max(10, Math.ceil(density * 300))) * (revives + 1);
}
function revive() {
  const cost = reviveCost();
  if (state !== 'dead' || revives >= REVIVE_MAX || wallet < cost) return;
  wallet -= cost; revives++; saveWallet();
  const L = PX - 120, R = PX + 200;
  const ref = plats.find((p) => p.x + p.w > PX - 40) || plats[plats.length - 1];
  const keep = plats.filter((p) => p.x + p.w < L || p.x > R);
  const ahead = keep.filter((p) => p.x > R).sort((a, b) => a.x - b.x)[0];
  const src = ahead || ref;
  const np = mkPlat({ x: L, w: ahead ? ahead.x - 40 - L : 420, y: src.by, world: gen.car ? null : src.world, ceil: src.ceil, ceilAbove: src.ceilAbove, special: true });
  plats = keep.concat([np]).sort((a, b) => a.x - b.x);
  obs = obs.filter((o) => o.x < L - 10 || o.x > R); coins = coins.filter((c) => c.x < L - 10 || c.x > R);
  portals = portals.filter((q) => q.x > R); birds = [];
  viewWorld = np.world; trans = null; car = null; gen.car = false; kLeft = kRight = kJump = false; strokeCd = 0; iceBoost = 0;
  py = np.y; vy = 0; grounded = true; ex = PX; rot = 0; dvx = 0; shake = 0;
  baseSpeed = Math.max(START_SPEED, baseSpeed * REVIVE_SPEED);        // restart slower
  rampFrames = Math.max(0, Math.round((baseSpeed - START_SPEED) / RAMP));
  invuln = 90; held = false; jumpBuf = 0; state = 'play';
  while (lastEnd() < W + 260) addPlatform();
  overToken++; show(null);
  beep(400, 900, 0.25, 'triangle', 0.08);
}

/* ============ simulation ============ */
function die(kind) {
  if (state !== 'play') return false;
  if (invuln > 0 && kind !== 'fall') return false;
  state = 'dead'; deadT = 0; held = false; trans = null; car = null;
  shake = reduceMotion ? 0 : 12;
  finalDist = Math.floor(dist);
  runMs = Math.round(simFrames * STEP);
  if (kind === 'wall') { dvx = -3.2; vy = -4; } else { dvx = -0.6; }
  isBest = finalDist > best;
  if (isBest) { best = finalDist; store.set('rr_best', String(best)); }
  saveWallet();
  beep(220, 40, 0.45, 'sawtooth', 0.08);
  return true;
}

function updateBirds(scroll) {
  for (const b of birds) {
    b.x -= scroll;
    if (!b.fly && b.x < ex + 55 && b.x > ex - 30 && state !== 'ready') { b.fly = true; b.vx = -rand(0.4, 1.4); b.vy = -rand(1.6, 3); }
    if (b.fly) { b.x += b.vx; b.y += b.vy; b.t++; }
  }
  birds = birds.filter((b) => b.x > -30 && b.y > -20);
}
function updateParts() {
  for (const p of parts) { p.x += p.vx; p.y += p.vy; p.vy += 0.1; p.l--; }
  parts = parts.filter((p) => p.l > 0);
}

function update() {
  if (state === 'paused') return;
  if (state === 'ready' || state === 'carintro') { bgScroll += 0.8; anim++; return; }
  if (state === 'dead') {
    deadT++; vy += G; py += vy; ex += dvx; rot += 0.22;
    shake = shake > 0.5 ? shake * 0.88 : 0;
    updateBirds(0); updateParts();
    if (deadT === 40) showOver();
    return;
  }

  // --- playing ---
  simFrames++; anim++; rampFrames++;
  shake = shake > 0.5 ? shake * 0.88 : 0;                         // let the screen shake fade out during play
  baseSpeed = Math.min(MAX_SPEED, START_SPEED + rampFrames * RAMP);
  speedScale += ((viewWorld ? WORLD_SPEED : 1) - speedScale) * 0.03;   // ease in and out of worlds
  iceBoost *= 0.97;
  speed = car ? CAR_SPEED : baseSpeed * speedScale * (1 + iceBoost);
  bgScroll += speed;
  dist += speed / M;
  const wid = viewWorld ? viewWorld.id : '';

  for (const p of plats) {
    p.x -= speed; p.py = p.y;
    if (p.amp) p.y = p.by + p.amp * Math.sin(simFrames / p.per + p.ph);
    if (p.cs === 1) { if (++p.ct >= 30) { p.cs = 2; p.fv = 0; } }
    else if (p.cs === 2) { p.fv += 0.5; p.y += p.fv; }
  }
  for (const o of obs) {
    const od = OBS[o.kind];
    o.x -= speed; if (o.vx) o.x += o.vx;
    if (o.kind === 'piston') { o.h = Math.round(14 + 8 * Math.sin(simFrames * 0.1 + o.ph)); o.y = o.pl.y - o.h; }
    else if (od.bob) o.y = o.fy + od.bob * Math.sin(simFrames * 0.08 + o.ph);
    else if (o.pl && o.pl.amp && !od.hang) o.y = o.pl.y - o.h - (od.float || 0);
    if (od.sw) o.dx = od.sw * Math.sin(simFrames * 0.06 + o.ph);
  }
  for (const c of coins) c.x -= speed;
  for (const q of portals) q.x -= speed;
  plats = plats.filter((p) => p.x + p.w > -40 && p.y < H + 80);
  obs = obs.filter((o) => o.x + o.w > -40);
  coins = coins.filter((c) => c.x > -20);
  portals = portals.filter((q) => q.x > -40);
  while (lastEnd() < W + 260) addPlatform();
  updateBirds(speed); updateParts();
  if (invuln > 0) invuln--;
  if (toastT > 0 && --toastT === 0) $('toast').hidden = true;

  const dm = Math.floor(dist);
  if (dm >= lastMile + 100) { lastMile = dm - (dm % 100); beep(600, 900, 0.1); }
  if (!warden && dm >= UNLOCK_AT) unlockWarden();

  if (viewWorld && viewWorld.lowg) {                                // low gravity in the middle of Another World
    const prog = (dist - gen.wStart) / gen.wLen;
    lowG = prog > 0.3 && prog < 0.7;
    if (lowG && !lowGPrev) showToast('Low gravity', 'Jumps float for a while', 110);
    lowGPrev = lowG;
  } else { lowG = false; lowGPrev = false; }
  if (wid === 'metro' && !trans && --metroT <= 0) spawnTrain();

  if (trans) {
    trans.t++; invuln = Math.max(invuln, 2);
    if (trans.t === 12) { if (trans.kind === 'enter') enterWorld(trans.def); else if (trans.kind === 'exit') exitWorld(); }
    if (trans.t >= 30) { trans = null; invuln = Math.max(invuln, SAFE_FRAMES); }
  }
  if (car) { carUpdate(); return; }

  // jump (or swim)
  const water = wid === 'water';
  const gEff = water ? 0.16 : lowG ? G * 0.6 : G;
  const jumpV = lowG ? JUMP * 0.8 : JUMP, cutV = lowG ? CUT * 0.8 : CUT;
  if (strokeCd > 0) strokeCd--;
  if (grounded) coyote = COYOTE; else if (coyote > 0) coyote--;
  if (jumpBuf > 0) jumpBuf--;
  if (water) {
    if (jumpBuf > 0 && strokeCd === 0) { vy = -4.2; grounded = false; strokeCd = 9; jumpBuf = 0; beep(300, 520, 0.08, 'sine', 0.06); }
  } else {
    if (jumpBuf > 0 && (grounded || coyote > 0)) { vy = jumpV; grounded = false; coyote = 0; jumpBuf = 0; beep(280, 520, 0.12); }
    if (!held && vy < cutV) vy = cutV;
  }

  // move
  const prev = py;
  vy = Math.min(vy + gEff, water ? 3 : 14);
  py += vy;
  const wasGrounded = grounded;
  grounded = false;
  const l = PX - PW / 2, r = PX + PW / 2;
  for (const p of plats) {
    if (p.cs === 2) continue;
    if (r > p.x && l < p.x + p.w) {
      if (vy >= 0 && prev <= Math.max(p.y, p.py) + 0.5 && py >= p.y) {
        py = p.y; vy = 0; grounded = true;
        if (p.crumble && !p.cs) { p.cs = 1; p.ct = 0; beep(110, 60, 0.1, 'triangle', 0.05); }
      } else if (py > p.y + 6) { if (die('wall')) return; }
    }
    if (p.ceil !== null && r > p.x - p.gb && l < p.x + p.w && py - PH < p.ceil) {      // bonk your head
      py = p.ceil + PH; if (vy < 0) vy = 0;
    }
  }
  if (grounded) {
    if (!wasGrounded) {
      if (wid === 'frozen') iceBoost = 0.3;                         // skid on the ice
      if (airFrames > 8) {
        beep(120, 70, 0.06, 'triangle', 0.08);
        const pulse = equip.char === 'warden' ? '#5ff3ff' : null;
        for (let i = 0; i < (pulse ? 7 : 4); i++) parts.push({ x: PX + rand(-3, 3), y: py, vx: rand(-2.2, -0.4), vy: -rand(0, 1.4), l: 14, c: pulse });
      }
    }
    airFrames = 0;
  } else airFrames++;

  // hazards, coins, portals
  const bl = l + 1, br = r - 1, bt = py - PH + 2;
  for (const o of obs) {
    if (o.blink && !blinkOn(o)) continue;
    const ox = o.x + (o.dx || 0);
    if (br > ox && bl < ox + o.w && py > o.y + 1 && bt < o.y + o.h) { if (die('wall')) return; }
  }
  collectCoins(l, r, py - PH, py);
  if (!trans) {
    for (const q of portals) {
      if (r > q.x && l < q.x + (q.w || 12) && (q.kind !== 'enter' || py > q.top - PORTAL_H)) {
        portals = portals.filter((z) => z !== q);
        if (q.kind === 'event' && q.ev === 'car') { beep(200, 900, 0.3, 'sawtooth', 0.05); startCar(); return; }
        trans = { t: 0, kind: q.kind === 'event' ? 'enter' : q.kind, def: q.kind === 'event' ? CHALL[q.ev] : q.def };
        beep(200, 1400, 0.35, 'sawtooth', 0.05);
        break;
      }
    }
  }
  if (py > H + 10) die('fall');
}

/* ============ drawing ============ */
function drawTile(c, f) {
  const off = Math.floor((bgScroll * f) % TILE);
  ctx.drawImage(c, -off, 0);
  ctx.drawImage(c, TILE - off, 0);
}

function drawRoofPlatform(p) {
  const x = Math.round(p.x), y = Math.round(p.y), w = p.w;
  rf(COL.wall, x, y, w, H - y + 20);
  rf(COL.roof, x, y, w, 3);
  rf(COL.lip, x, y + 3, w, 3);
  ctx.fillStyle = COL.dot;
  for (let dx = 4; dx < w - 2; dx += 8) ctx.fillRect(x + dx, y + 9, 3, 2);
  let row = 0;
  for (let ry = y + 26; ry < H - 6; ry += 28, row++) {
    for (let wx = 10, i = 0; wx < w - 16; wx += 14, i++) {
      ctx.fillStyle = (i * 7 + row * 3) % 5 === 0 ? COL.winLit : COL.win;
      ctx.fillRect(x + wx, ry, 11, 7);
    }
  }
}
function drawWorldPlatform(p) {
  const d = p.world, x = Math.round(p.x) + (p.cs === 1 ? (Math.random() < 0.5 ? -1 : 1) : 0), y = Math.round(p.y), w = p.w;
  if (d.thin) {                                                    // floating girder / plank
    rf(d.floorBody, x, y, w, 8); rf(d.floorTop, x, y, w, 3); rf(d.floorLine, x, y + 8, w, 2);
    ctx.fillStyle = d.floorLine; for (let i = 6; i < w - 4; i += 14) ctx.fillRect(x + i, y + 4, 2, 4);
  } else {
    rf(d.floorBody, x, y, w, H - y + 20);
    rf(d.floorTop, x, y, w, 4);
    rf(d.floorLine, x, y + 4, w, 2);
    if (d.pat) d.pat(x, y, w);
  }
  if (p.cs === 1) rf('rgba(255,80,40,0.4)', x, y, w, d.thin ? 8 : 10);
  if (p.ceil !== null) {
    const cx = Math.round(p.x - p.gb), cw = w + p.gb;               // the ceiling also covers pits
    rf(d.ceilBody, cx, -10, cw, p.ceil + 10);
    rf(d.ceilEdge, cx, p.ceil - 3, cw, 3);
  }
}
function drawPlatform(p) {
  if (p.x > W || p.x + p.w < 0) return;
  if (p.world) drawWorldPlatform(p); else drawRoofPlatform(p);
  if (p.ramp) {                                                    // stunt ramp at the end of the roof
    const x = Math.round(p.x + p.w - p.ramp), y = Math.round(p.y);
    for (let i = 0; i < p.ramp; i += 2) { const h = Math.round(p.rh * i / p.ramp); rf('#d9d9e3', x + i, y - h, 2, h + 1); }
    rf('#8f8fa0', x + p.ramp - 2, y - p.rh, 2, p.rh);
  }
}

function drawBird(b) {
  const x = Math.round(b.x), y = Math.round(b.y);
  ctx.fillStyle = COL.white;
  if (!b.fly) { ctx.fillRect(x, y - 3, 3, 3); ctx.fillRect(x + 2, y - 5, 2, 2); }
  else { const up = Math.floor(b.t / 3) % 2 === 0; ctx.fillRect(x, y - 2, 4, 2); ctx.fillRect(x + (up ? 0 : 1), y - (up ? 5 : 1), 2, 3); }
}

function drawCoin(c) {
  const x = Math.round(c.x), y = Math.round(c.y);
  const w = (anim >> 3) % 4;                                        // slow spin
  const cw = w === 0 || w === 2 ? 12 : (w === 1 ? 9 : 6);
  rf('#a8801a', x - (cw >> 1), y - COIN_R, cw, COIN_R * 2);
  rf(COL.coin, x - (cw >> 1) + 1, y - COIN_R + 1, Math.max(1, cw - 2), COIN_R * 2 - 2);
}

function drawCarSprite(cx, y, ang) {
  ctx.save();
  ctx.translate(Math.round(cx), Math.round(y - 7));
  ctx.rotate(ang);
  rf('#d94a3a', -14, -4, 28, 8); rf('#b3382b', -7, -9, 14, 6); rf('#bfe9ff', -5, -8, 10, 3); rf('#ffd23f', 13, -3, 2, 3);
  rf(COL.white, -2, -11, 4, 3);
  rf('#14141b', -11, 2, 6, 6); rf('#14141b', 6, 2, 6, 6); rf('#8f8fa0', -9, 4, 2, 2); rf('#8f8fa0', 8, 4, 2, 2);
  ctx.restore();
}
function drawPortal(q) {
  const x = Math.round(q.x), top = Math.round(q.top), h = q.h;
  if (q.kind === 'event' && q.ev === 'car') { drawCarSprite(x + 15, top, 0); return; }
  const hw = q.kind === 'enter' ? 8 : 9;
  const c1 = q.kind === 'enter' ? '#7af0ff' : q.kind === 'exit' ? '#ffd27a' : '#ffb04a';
  const c2 = q.kind === 'enter' ? '#b388ff' : q.kind === 'exit' ? '#ff8a4a' : '#ff4a4a';
  for (let r = 0; r < h; r++) {
    const t = (r - h / 2) / (h / 2);
    const half = Math.max(1, Math.round(hw * Math.sqrt(1 - t * t)));
    const inner = Math.max(0, half - 3);
    ctx.fillStyle = ((r + anim) >> 2) & 1 ? c1 : c2;
    ctx.fillRect(x + 6 - half, top - h + r, half * 2, 1);
    ctx.fillStyle = '#10112a';
    ctx.fillRect(x + 6 - inner, top - h + r, inner * 2, 1);
  }
}

function drawHat(id, x, y) {
  if (id === 'cap') { rf('#2b4c8f', x - 3, y - 21, 7, 3); rf('#1f376b', x + 2, y - 19, 5, 1); }
  else if (id === 'beanie') { rf('#59a86b', x - 3, y - 22, 7, 4); rf('#f4f4f8', x - 1, y - 24, 3, 2); }
  else if (id === 'band') { rf('#e8553d', x - 3, y - 18, 7, 2); }
  else if (id === 'tophat') { rf('#14141b', x - 4, y - 20, 9, 2); rf('#14141b', x - 2, y - 28, 5, 8); rf('#e8553d', x - 2, y - 22, 5, 1); }
  else if (id === 'crown') { rf('#ffd23f', x - 3, y - 23, 7, 4); rf('#ffd23f', x - 3, y - 25, 1, 2); rf('#ffd23f', x, y - 26, 1, 3); rf('#ffd23f', x + 3, y - 25, 1, 2); rf('#c0392b', x, y - 21, 1, 1); }
}

function drawRunner(cx, fy, air, tick, lift) {
  const f = Math.floor(tick / 5) % 4;
  const x = Math.round(cx), y = Math.round(fy);
  const wob = [0, 1, 0, -1], sc = scarfOf(), wd = equip.char === 'warden';
  const suit = wd ? '#d9dfeb' : COL.white, leg1 = wd ? '#7c8798' : COL.ink, leg2 = wd ? '#5d677a' : '#3a3a47';
  for (let i = 0; i < 4; i++) {
    ctx.fillStyle = sc.id === 'rainbow' ? RAINBOW[(i + f) % RAINBOW.length] : sc.col;
    ctx.fillRect(x - 4 - i * 3, y - 14 + wob[(f + i) % 4] - Math.round(lift * i / 3), 3, 2);
  }
  rf(suit, x - 3, y - 14, 6, 7);
  rf(suit, x - 2, y - 19, 5, 5);
  rf(wd ? '#5ff3ff' : COL.ink, x - 2, y - 19, 5, 2);
  if (wd) { rf('#5ff3ff', x - 1, y - 12, 2, 2); rf('#5ff3ff', x - 3, y - 8, 6, 1); }
  ctx.fillStyle = leg1;
  if (air) {
    ctx.fillRect(x - 5, y - 7, 4, 3); ctx.fillRect(x - 6, y - 5, 3, 3);
    ctx.fillStyle = leg2;
    ctx.fillRect(x + 1, y - 8, 5, 3); ctx.fillRect(x + 4, y - 6, 3, 4);
  } else {
    const a = [-3, -1, 2, 0][f], b = [2, 0, -3, -1][f];
    ctx.fillRect(x - 2 + a, y - 7, 3, 7);
    ctx.fillStyle = leg2;
    ctx.fillRect(x - 1 + b, y - 7, 3, 7);
  }
  ctx.fillStyle = suit;
  if (air) { ctx.fillRect(x + 3, y - 16, 4, 2); ctx.fillRect(x - 6, y - 12, 3, 2); }
  else ctx.fillRect(x + 2 + (f % 2 ? 2 : -1), y - 12, 3, 2);
  drawHat(equip.hat, x, y);
}
const liftNow = () => Math.max(-5, Math.min(6, Math.round(vy * 0.35)));

function drawAmbient() {
  const id = viewWorld ? viewWorld.id : '';
  if (id === 'frozen') { ctx.fillStyle = '#fff'; for (let i = 0; i < 36; i++) ctx.fillRect(Math.round((i * 67 + anim * 1.3) % W), Math.round((i * 41 + anim * 0.8) % H), 2, 2); }
  else if (id === 'water') {
    rf('rgba(30,120,200,0.16)', 0, 0, W, H);
    ctx.fillStyle = '#bfe9ff'; for (let i = 0; i < 14; i++) ctx.fillRect(Math.round((i * 83 + 20) % W), Math.round(H - ((anim * 0.7 + i * 37) % H)), 2, 2);
  } else if (id === 'collapse') { ctx.fillStyle = '#ff9a3a'; for (let i = 0; i < 20; i++) ctx.fillRect(Math.round((i * 59 + anim * 0.6) % W), Math.round(H - ((anim * 1.1 + i * 29) % H)), 2, 2); }
  if (lowG) rf('rgba(150,100,255,0.10)', 0, 0, W, H);
}

const carHud = document.createElement('div'); carHud.id = 'car-hud'; carHud.hidden = true;
const carBtns = document.createElement('div'); carBtns.id = 'car-btns'; carBtns.hidden = true;

function draw() {
  ctx.save();
  if (shake > 0) ctx.translate(Math.round((Math.random() - 0.5) * shake), Math.round((Math.random() - 0.5) * shake));
  if (viewWorld) {
    drawTile(viewWorld.tile, 0.5);
  } else {
    rf(COL.sky, -12, -12, W + 24, H + 24);
    drawTile(farLayer, 0.12); drawTile(midLayer, 0.25); drawTile(nearLayer, 0.45);
  }
  plats.forEach(drawPlatform);
  for (const o of obs) { if (o.x < W + 40) DRAW[o.kind](Math.round(o.x + (o.dx || 0)), Math.round(o.y), o.w, o.h, o); }
  coins.forEach((c) => { if (c.x < W + 20) drawCoin(c); });
  portals.forEach((q) => { if (q.x < W + 40) drawPortal(q); });
  birds.forEach(drawBird);
  parts.forEach((p) => rf(p.c || COL.roof, Math.round(p.x), Math.round(p.y), 2, 2));

  if (state === 'dead') {
    ctx.save();
    ctx.translate(Math.round(ex), Math.round(py - 9));
    ctx.rotate(rot);
    drawRunner(0, 9, true, 0, liftNow());
    ctx.restore();
  } else if (car) {
    drawCarSprite(CX, car.y, car.ang);
  } else if (!(invuln > 0 && (invuln >> 2) % 2)) {
    drawRunner(PX, py, !grounded, state === 'paused' ? 0 : anim, liftNow());
  }
  drawAmbient();
  if (viewWorld && viewWorld.id === 'tunnel' && !reduceMotion && frames % 97 < 4) rf('rgba(0,0,0,0.2)', 0, 0, W, H);
  if (trans) {
    const a = trans.t < 12 ? trans.t / 12 : (30 - trans.t) / 18;
    rf('rgba(190,245,255,' + Math.max(0, Math.min(1, a)).toFixed(2) + ')', -12, -12, W + 24, H + 24);
  }
  ctx.restore();

  const dEl = $('dist'), d = Math.floor(dist) + 'm';
  if (dEl.dataset.v !== d) { dEl.dataset.v = d; dEl.textContent = d; }
  const cEl = $('hud-coins'), cv = String(runCoins);
  if (cEl.dataset.v !== cv) { cEl.dataset.v = cv; cEl.textContent = cv; }
  const showCar = !!car && state !== 'dead';
  if (carHud.hidden === showCar) { carHud.hidden = !showCar; carBtns.hidden = !showCar; }
  if (showCar) {
    const tx = 'CAR ' + Math.max(0, Math.ceil((CAR_TIME - car.t) / 60)) + 's  ·  Stunts ' + car.pts;
    if (carHud.dataset.v !== tx) { carHud.dataset.v = tx; carHud.textContent = tx; }
  }
}

/* ============ sizing & fullscreen ============ */
function fit() {
  const r = stage.getBoundingClientRect();
  const cw = r.width || 960, ch = r.height || 540;
  const nw = clamp(Math.round((H * cw / ch) / 2) * 2, 480, TILE);
  if (nw !== W || canvas.width !== W) {
    W = nw; canvas.width = W; canvas.height = H;
    ctx.imageSmoothingEnabled = false;
  }
  const s = Math.min(cw / W, ch / H);
  canvas.style.width = Math.round(W * s) + 'px';
  canvas.style.height = Math.round(H * s) + 'px';
}
function goFullscreen() {
  try {
    const f = stage.requestFullscreen || stage.webkitRequestFullscreen;
    if (f) { const p = f.call(stage); if (p && p.catch) p.catch(() => {}); }
  } catch (e) { /* not allowed */ }
}
function leaveFullscreen() {
  try {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      const f = document.exitFullscreen || document.webkitExitFullscreen;
      if (f) { const p = f.call(document); if (p && p.catch) p.catch(() => {}); }
    }
  } catch (e) { /* ignore */ }
}
window.addEventListener('resize', fit);
window.addEventListener('orientationchange', fit);
document.addEventListener('fullscreenchange', () => {
  fit();
  if (!document.fullscreenElement && state === 'play') togglePause();
});

/* ============ input ============ */
function press() {
  unlock();
  if (state === 'play' && !car) { held = true; jumpBuf = BUFFER; }
}
function release() { held = false; kLeft = kRight = kJump = false; }      // everything off (window lost focus)
function releaseTap() { held = false; }                                  // one finger or button lifted: the car buttons release themselves
const typing = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');

stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('button, input, a, label')) return;
  press();
});
stage.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('pointerup', releaseTap);
window.addEventListener('pointercancel', releaseTap);
window.addEventListener('blur', release);

window.addEventListener('keydown', (e) => {
  if (typing(e.target)) return;
  const c = e.code;
  if (state === 'carintro') { if (c === 'Space' || c === 'Enter') { e.preventDefault(); beginCar(); } return; }
  if (car && state === 'play') {
    if (c === 'KeyA' || c === 'ArrowLeft') { kLeft = true; e.preventDefault(); return; }
    if (c === 'KeyD' || c === 'ArrowRight') { kRight = true; e.preventDefault(); return; }
    if (c === 'Space' || c === 'ArrowUp' || c === 'KeyW') { kJump = true; e.preventDefault(); return; }
  }
  const jumpKey = c === 'Space' || c === 'ArrowUp' || c === 'KeyW';
  if (jumpKey) {
    if (state === 'play' || state === 'dead') e.preventDefault();
    if (state === 'dead') { if (c === 'Space' && !e.repeat && deadT > 50) restart(); return; }
    if (!e.repeat) press();
  } else if (c === 'Enter' && state === 'dead' && deadT > 50) {
    restart();
  } else if (c === 'KeyP' || c === 'Escape') {
    togglePause();
  } else if (c === 'KeyM') {
    toggleMute();
  }
});
window.addEventListener('keyup', (e) => {
  const c = e.code;
  if (c === 'Space' || c === 'ArrowUp' || c === 'KeyW') { held = false; kJump = false; }
  if (c === 'KeyA' || c === 'ArrowLeft') kLeft = false;
  if (c === 'KeyD' || c === 'ArrowRight') kRight = false;
});
document.addEventListener('visibilitychange', () => { if (document.hidden && state === 'play') togglePause(); });
window.addEventListener('pagehide', saveWallet);

/* ============ screens & buttons ============ */
const screens = { start: $('scr-start'), shop: $('scr-shop'), board: $('scr-board'), pause: $('scr-pause'), over: $('scr-over') };
function show(name) { for (const k in screens) screens[k].hidden = k !== name; }
const click = (id, fn) => $(id).addEventListener('click', (e) => { e.currentTarget.blur(); fn(); });

const NAME_RE = /^[A-Za-z0-9 _.\-]{1,12}$/;
const cleanName = (v) => v.replace(/\s+/g, ' ').trim();
let myName = cleanName(store.get('rr_name', ''));

function refreshStart() {
  $('best-start').textContent = best;
  $('wallet-start').textContent = wallet;
  if (!$('name').value) $('name').value = myName;       // keep what the player already typed
}

// stunt-car intro screen, touch buttons and styles (created here so no HTML changes are needed)
const css = document.createElement('style');
css.textContent = `
#car-hud{position:absolute;top:max(7cqmin,48px);left:50%;transform:translateX(-50%);padding:.4em .9em;color:#ffd23f;background:rgba(20,20,27,.72);font:700 clamp(12px,2.4cqmin,22px) Silkscreen,monospace;pointer-events:none;white-space:nowrap}
#car-hud[hidden],#car-btns[hidden]{display:none}
#car-btns{position:absolute;left:0;right:0;bottom:max(2cqmin,env(safe-area-inset-bottom));display:flex;justify-content:space-between;gap:2cqmin;padding:0 3cqmin;pointer-events:none}
#car-btns .btn{pointer-events:auto;flex:1;max-width:28cqmin;padding:1.2em .6em;touch-action:none;opacity:.88}
.keys{display:grid;grid-template-columns:1fr 1fr;gap:1.2cqmin;width:min(100%,34em)}
.keys div{display:flex;flex-direction:column;gap:.3em;padding:.7em;background:#2a2a37}
.keys b{font:700 1.1em Silkscreen,monospace;color:#ffd23f}
.keys span{color:#c4c4cf;font-size:.9em}`;
document.head.appendChild(css);

const carScr = document.createElement('section');
carScr.className = 'screen'; carScr.hidden = true;
carScr.innerHTML = '<h2>Stunt car!</h2><p>You have 15 seconds. Hit the ramps and land flips for points. A rough landing never ends your run.</p>' +
  '<div class="keys"><div><b>A or Left</b><span>Backflip</span></div><div><b>D or Right</b><span>Frontflip</span></div>' +
  '<div><b>SPACE</b><span>Hold on a ramp to launch higher</span></div><div><b>15s</b><span>Challenge timer</span></div></div>' +
  '<p class="muted">On touch screens, buttons appear at the bottom.</p>';
const carGo = document.createElement('button');
carGo.type = 'button'; carGo.className = 'btn primary'; carGo.textContent = 'Go!';
carGo.addEventListener('click', () => { carGo.blur(); beginCar(); });
carScr.appendChild(carGo);
stage.appendChild(carScr); stage.appendChild(carHud); stage.appendChild(carBtns);
screens.car = carScr;

[['L', 'Backflip'], ['J', 'Launch'], ['R', 'Frontflip']].forEach(([k, label]) => {
  const b = document.createElement('button');
  b.type = 'button'; b.className = 'btn'; b.textContent = label;
  const set = (on) => { if (k === 'L') kLeft = on; else if (k === 'R') kRight = on; else kJump = on; };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); unlock(); set(true); });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach((t) => b.addEventListener(t, () => set(false)));
  carBtns.appendChild(b);
});

function play() {
  const n = cleanName($('name').value);
  if (!NAME_RE.test(n)) {
    $('play-msg').textContent = 'Pick a name with 1 to 12 letters, numbers, spaces, _ . or -';
    $('name').focus();
    return;
  }
  myName = n; store.set('rr_name', n);
  $('play-msg').textContent = '';
  unlock();
  document.body.classList.add('playing');
  window.scrollTo(0, 0);
  goFullscreen();
  restart();
}
function restart() {
  overToken++;
  fit(); reset();
  state = 'play'; show(null); $('hud').hidden = false;
  fetchRunToken();
}
function toMenu() {
  overToken++;
  leaveFullscreen();
  document.body.classList.remove('playing');
  saveWallet();
  fit(); reset();
  state = 'ready'; $('hud').hidden = true;
  refreshStart(); show('start');
}
function togglePause() {
  if (state === 'play') { state = 'paused'; held = false; saveWallet(); show('pause'); }
  else if (state === 'paused') { state = 'play'; show(null); }
}
function toggleMute() { muted = !muted; store.set('rr_mute', muted ? '1' : '0'); syncMute(); }
function syncMute() {
  const b = $('btn-mute');
  b.textContent = muted ? 'Sound off' : 'Sound on';
  b.setAttribute('aria-pressed', String(muted));
}

$('form-play').addEventListener('submit', (e) => { e.preventDefault(); play(); });
click('btn-shop', () => { openShop(); });
click('btn-shop-back', () => { shopOpen = false; refreshStart(); show('start'); });
click('btn-board', () => { openBoard(); });
click('btn-board-back', () => { boardToken++; show('start'); });
['day', 'week', 'all'].forEach((per) => click('tab-' + per, () => { boardPeriod = per; loadScoreboard(); }));
click('tab-hat', () => { shopTab = 'hat'; renderShop(); });
click('tab-scarf', () => { shopTab = 'scarf'; renderShop(); });
const tabChar = document.createElement('button');
tabChar.type = 'button'; tabChar.className = 'btn'; tabChar.id = 'tab-char'; tabChar.textContent = 'Runner'; tabChar.setAttribute('aria-pressed', 'false');
$('tab-scarf').parentNode.appendChild(tabChar);
tabChar.addEventListener('click', () => { tabChar.blur(); shopTab = 'char'; renderShop(); });
click('btn-resume', togglePause);
click('btn-pause', togglePause);
click('btn-mute', toggleMute);
click('btn-menu-pause', toMenu);
click('btn-menu-over', toMenu);
click('btn-again', () => { unlock(); restart(); });
click('btn-revive', revive);

/* ============ costume shop ============ */
let shopTab = 'hat', shopOpen = false;
function openShop() { shopOpen = true; $('shop-msg').textContent = ''; renderShop(); show('shop'); }
function renderShop() {
  $('wallet-shop').textContent = wallet;
  $('tab-hat').setAttribute('aria-pressed', String(shopTab === 'hat'));
  $('tab-scarf').setAttribute('aria-pressed', String(shopTab === 'scarf'));
  tabChar.setAttribute('aria-pressed', String(shopTab === 'char'));
  const list = shopTab === 'hat' ? HATS : shopTab === 'scarf' ? SCARVES : CHARS, box = $('shop-grid');
  box.textContent = '';
  list.forEach((it) => {
    const key = shopTab + ':' + it.id, own = owned.has(key);
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'item' + (equip[shopTab] === it.id ? ' on' : '');
    if (shopTab === 'scarf') {
      const sw = document.createElement('span'); sw.className = 'sw';
      sw.style.background = it.id === 'rainbow' ? 'linear-gradient(90deg,' + RAINBOW.join(',') + ')' : it.col;
      b.appendChild(sw);
    }
    const nm = document.createElement('b'); nm.textContent = it.name;
    const st = document.createElement('small');
    st.textContent = equip[shopTab] === it.id ? 'Wearing' : own ? 'Owned' : it.lock ? it.lock : it.cost + ' coins';
    b.append(nm, st);
    b.addEventListener('click', () => {
      if (!own) {
        if (it.lock) { $('shop-msg').textContent = it.name + ' unlocks when you survive 5,000 m in one run.'; return; }
        if (wallet < it.cost) { $('shop-msg').textContent = 'You need ' + (it.cost - wallet) + ' more coins for the ' + it.name.toLowerCase() + '.'; return; }
        wallet -= it.cost; owned.add(key); saveWallet();
      }
      equip[shopTab] = it.id; saveCostumes();
      $('shop-msg').textContent = '';
      renderShop();
    });
    box.appendChild(b);
  });
}
const previewCanvas = $('shop-preview'), previewCtx = previewCanvas.getContext('2d');
function drawPreview() {
  const saved = ctx;
  ctx = previewCtx;
  rf('#2a2a37', 0, 0, 64, 64);
  rf('#505061', 0, 54, 64, 10);
  rf(COL.roof, 0, 54, 64, 2);
  drawRunner(34, 54, false, frames, 0);
  ctx = saved;
}

/* ============ device secret + run token (anti-cheat, name ownership) ============ */
let secret = store.get('rr_secret', '');          // random text only this browser knows; it keeps your leaderboard name yours
if (!/^[a-f0-9]{32}$/.test(secret)) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  secret = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  store.set('rr_secret', secret);
}
let runToken = '', tokenSeq = 0;
async function fetchRunToken() {                  // asks the server to start the clock for this run
  const mine = ++tokenSeq; runToken = '';
  try {
    const r = await api('/api/run/start', { method: 'POST' }, 20000);
    if (mine === tokenSeq) runToken = r.token || '';
  } catch (e) { /* offline: the score just will not post */ }
}

/* ============ game over + leaderboard (FastAPI backend) ============ */
async function api(path, opts = {}, timeout = 65000) {
  if (!API) throw new Error('The leaderboard server is not set up yet.');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(API + path, { ...opts, signal: ctl.signal, headers: { 'Content-Type': 'application/json' } });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      const d = j.detail;
      throw new Error(typeof d === 'string' ? d : (d && d[0] && d[0].msg) || 'Server error');
    }
    return await res.json();
  } finally { clearTimeout(timer); }
}

function renderBoard(ol, rows) {
  ol.textContent = '';
  rows.forEach((r) => {
    const li = document.createElement('li');
    if (r.name.toLowerCase() === myName.toLowerCase()) li.className = 'me';
    const who = document.createElement('span'); who.className = 'who'; who.textContent = r.name;
    const far = document.createElement('span'); far.className = 'far'; far.textContent = r.distance + 'm';
    li.append(who, far); ol.appendChild(li);
  });
}

// one score per day is enough for the daily board: post again only when you beat today's best
const utcDay = () => new Date().toISOString().slice(0, 10);
function postedToday() {
  try { const v = JSON.parse(store.get('rr_posted', 'null')); return v && v.day === utcDay() ? v.best : 0; } catch (e) { return 0; }
}

async function postAndLoad(token) {
  const status = $('over-status'), ol = $('over-board');
  status.textContent = 'Loading the leaderboard…'; ol.textContent = '';
  let note = '';
  if (finalDist >= 20 && finalDist > postedToday()) {
    try {
      const r = await api('/api/scores', { method: 'POST', body: JSON.stringify({ name: myName, distance: finalDist, duration_ms: runMs, token: runToken, secret }) });
      if (token !== overToken) return;
      store.set('rr_posted', JSON.stringify({ day: utcDay(), best: finalDist }));
      note = 'Score posted. You are #' + r.rank + ' all time' + (r.rank_week ? ' and #' + r.rank_week + ' this week' : '') + '.';
    } catch (err) {
      if (token !== overToken) return;
      note = err instanceof TypeError || err.name === 'AbortError' ? '' : err.message;     // e.g. a name that is not allowed
    }
  }
  try {
    const rows = await api('/api/leaderboard?limit=10&period=all');
    if (token !== overToken) return;
    renderBoard(ol, rows);
    status.textContent = note || (rows.length ? '' : 'No scores yet. Be the first.');
  } catch (err) {
    if (token !== overToken) return;
    status.textContent = err.name === 'AbortError' ? 'The leaderboard took too long to wake up.' : 'Leaderboard offline. Your run still counts locally.';
  }
}

/* ============ scoreboard screen (Today / This week / All time) ============ */
let boardPeriod = 'all', boardToken = 0;
function openBoard() { show('board'); loadScoreboard(); }
async function loadScoreboard() {
  ['day', 'week', 'all'].forEach((per) => $('tab-' + per).setAttribute('aria-pressed', String(per === boardPeriod)));
  const st = $('board-status'), ol = $('board-list'), token = ++boardToken;
  st.textContent = 'Loading… the first load can take a minute while the server wakes up.'; ol.textContent = '';
  try {
    const rows = await api('/api/leaderboard?limit=10&period=' + boardPeriod);
    if (token !== boardToken) return;
    renderBoard(ol, rows);
    st.textContent = rows.length ? '' : 'No scores yet for this period. Be the first.';
  } catch (err) {
    if (token !== boardToken) return;
    st.textContent = err.name === 'AbortError' ? 'The leaderboard took too long to wake up. Try again in a moment.' : 'Leaderboard offline. Try again later.';
  }
}

function showOver() {
  $('over-title').textContent = isBest ? 'New best!' : 'Game over';
  $('over-dist').textContent = finalDist;
  $('over-coins').textContent = 'Coins this run: ' + runCoins + '  ·  Wallet: ' + wallet;
  const rb = $('btn-revive');
  if (revives < REVIVE_MAX) {
    const cost = reviveCost();
    rb.hidden = false; rb.textContent = 'Revive for ' + cost + ' coins'; rb.disabled = wallet < cost;
    $('revive-note').textContent = wallet < cost ? 'You need ' + (cost - wallet) + ' more coins to revive.' : '';
  } else { rb.hidden = true; $('revive-note').textContent = ''; }
  show('over');
  postAndLoad(++overToken);
}

/* ============ main loop ============ */
let last = 0, acc = 0;
function loop(t) {
  requestAnimationFrame(loop);
  if (!last) last = t;
  acc += Math.min(100, t - last); last = t;
  while (acc >= STEP) { acc -= STEP; frames++; update(); }
  draw();
  if (shopOpen) drawPreview();
}

fit(); reset(); syncMute(); refreshStart(); show('start');
if (API) api('/health', {}, 65000).catch(() => {});                 // wakes a sleeping free server
requestAnimationFrame(loop);
})();
