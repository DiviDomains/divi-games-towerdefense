// Tower defense on Divi Games testnet. Plain ES module, no build step, no requests except to the chain API
// and the sibling .wasm.
//
// The simulation (crates/dg-td, built as dg_td_wasm.wasm) is the same code the node replays on `submit`, so the
// score you see locally is the score the chain records. A run is the seed from the chain plus the list of
// placements you made; nothing else is sent. Until you submit, the run is also kept in this browser (resume.js), so a
// reload or a trip to the /play hub picks it up where you left it.
//
//   ?chain=http://127.0.0.1:7410        use another chain API root (default: <this origin>/chain; only on localhost, or this site's own origin)

import { Chain, Key, NETWORK, formatAmount, localTime, timeLeft, readableError, setTextWithLinks, faucetFastNote } from '../../sdk/divigames.js';
import { mountWallets } from '../../sdk/connect.js';
import { runDeadline } from '../deadlines.js';
import { readSave, writeSave, clearSave, resumable, rebuild, parseFrame } from './resume.js';
import { goldShortText, cannotAfford } from './gold.js';

const GAME = 'towerdefense';
const KEY_STORE = 'dg.playkey.wif';
const CELL_PX = 48;
const TOWER_NAMES = ['Arrow', 'Cannon', 'Frost', 'Sniper'];
const TOWER_COLORS = ['#f97316', '#a855f7', '#22d3ee', '#22c55e'];
const CREEP_COLORS = ['#fbbf24', '#60a5fa', '#E94560', '#e2e8f0'];
const CREEP_RADIUS = [9, 7, 13, 17];
const SPEEDS = [1, 4, 16];
const TICKS_PER_FRAME = 3;

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

const chain = Chain.fromPage();

const state = {
  /** @type {Key} */ key: loadKey(),
  /** The address that plays: the connected wallet's, or the guest key's. */
  me: '',
  decimals: 2,
  tdDecimals: 2,
  /** @type {any} */ wasm: null,
  /** @type {{id: string, seed: string, rules?: number, player?: string}|null} */ run: null,
  /** @type {{tick: number, x: number, y: number, kind: number}[]} */ placements: [],
  playing: false,
  paused: false,
  over: false,
  submitted: false,
  speed: 0,
  kind: 0,
  /** @type {{x: number, y: number}|null} */ hover: null,
  /** The hovered cell came from the arrow keys, so outline it. */
  keyCursor: false,
  /** @type {number|null} */ week: null,
  runExpiryBlocks: 3600,
  runExpiryMs: 2 * 60 * 60 * 1000,
  /** Block time from which weeks and run expiry run on the clock instead of on block height. */
  clockFrom: Infinity,
  /** @type {number|null} */ currentWeek: null,
  /** @type {any} */ frame: null,
  /** The last save of this run to the browser was written (false when storage is blocked). */
  saved: false,
};

// ---------- small helpers (same shapes as the tic-tac-toe page) ----------

/** Create an element. Text children use textContent, so chain data is never parsed as HTML. */
function el(/** @type {string} */ tag, props = {}, /** @type {(Node|string|null|undefined|false)[]} */ ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children) if (c != null && c !== false) n.append(c);
  return n;
}

const short = (/** @type {string|null|undefined} */ a) => (a ? (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a) : '');
const who = (/** @type {string|null|undefined} */ a) => (a && a === state.me ? 'you' : short(a));
const money = (/** @type {any} */ base, decimals = state.decimals) => {
  try {
    return formatAmount(String(base ?? '0'), decimals);
  } catch {
    return String(base);
  }
};
const errText = (/** @type {any} */ e) => (e && e.message) || String(e);

const clearTimers = new WeakMap();

/** Show a status line. Success notes fade after a few seconds; errors stay until replaced. */
function say(/** @type {HTMLElement} */ node, text = '', kind = 'info') {
  clearTimeout(clearTimers.get(node));
  text = readableError(text);
  setTextWithLinks(node, text);
  node.dataset.kind = kind;
  node.hidden = !text;
  if (text && kind === 'ok') {
    clearTimers.set(node, setTimeout(() => { if (node.textContent === text) say(node, ''); }, 5000));
  }
}

// ---------- the play key ----------

function storageGet() {
  try {
    return localStorage.getItem(KEY_STORE);
  } catch {
    return null;
  }
}
function storageSet(/** @type {string} */ wif) {
  try {
    localStorage.setItem(KEY_STORE, wif);
    return true;
  } catch {
    return false;
  }
}

/** This browser's localStorage, or null where it is blocked (reading the property can throw in a private window). */
function store() {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** Keep the run in this browser: the seed, rules, placements and the tick now. */
function persist() {
  const r = state.run;
  if (!r || state.submitted || !state.frame) return;
  state.saved = writeSave(store(), r.player ?? state.me, {
    run: r.id, seed: r.seed, rules: Number(r.rules ?? 1), placements: state.placements, tick: state.frame.tick, over: state.over,
  });
}

function loadKey() {
  const wif = storageGet();
  if (wif) {
    try {
      const k = Key.fromWif(wif);
      if (k.network === NETWORK) return k;
    } catch {
      /* unreadable: replace it */
    }
  }
  const k = Key.generate(NETWORK);
  storageSet(k.toWif());
  return k;
}

function balanceOf(/** @type {any} */ account, token) {
  const b = account?.balances ?? account?.balance;
  if (Array.isArray(b)) {
    const row = b.find((r) => (r.token ?? r.symbol) === token);
    return String(row?.amount ?? row?.balance ?? '0');
  }
  if (b && typeof b === 'object') return String(b[token] ?? '0');
  return '0';
}

// ---------- sending actions ----------

let queue = Promise.resolve();

/**
 * Sign and submit an action, wait for its block, and report failures inline. One at a time, so nonces line up.
 * @returns {Promise<any|null>} the receipt when ok, else null
 */
function run(/** @type {any} */ action, /** @type {HTMLElement} */ msg, /** @type {HTMLButtonElement[]} */ buttons = []) {
  const job = async () => {
    buttons.forEach((b) => (b.disabled = true));
    try {
      say(msg, 'Signing and sending…');
      const txid = await chain.send(state.key, action);
      say(msg, 'Sent. Waiting for the next block…');
      const receipt = await chain.waitForReceipt(txid);
      if (!receipt.ok) {
        say(msg, receipt.error || 'The transaction failed.', 'error');
        return null;
      }
      say(msg, '');
      return receipt;
    } catch (e) {
      say(msg, errText(e), 'error');
      return null;
    } finally {
      buttons.forEach((b) => (b.disabled = false));
      refreshAccount();
    }
  };
  const p = queue.then(job, job);
  queue = p.then(() => {}, () => {});
  return p;
}

const gameAction = (/** @type {any} */ op) => ({ type: 'game', game: GAME, op });

// ---------- wallet ----------

async function refreshAccount() {
  try {
    wallets.refresh();
    const acct = await chain.account(state.me);
    $('balance').textContent = money(balanceOf(acct, 'GOLD'));
    $('balance-td').textContent = money(balanceOf(acct, 'TDGOLD'), state.tdDecimals);
  } catch (e) {
    $('balance').textContent = '?';
    $('balance-td').textContent = '?';
    say($('wallet-msg'), `Could not reach the chain: ${errText(e)}`, 'error');
  }
}

function showKey() {
  $('me').textContent = state.me;
  $('me').title = state.me;
  const wif = $('wif');
  wif.hidden = true;
  wif.textContent = '';
  $('export').textContent = 'Show WIF';
}

$('copy-addr').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(state.me);
    say($('wallet-msg'), 'Address copied.', 'ok');
  } catch {
    say($('wallet-msg'), `Your address: ${state.me}`, 'info');
  }
});

$('faucet').addEventListener('click', async (ev) => {
  const r = await run({ type: 'faucet', token: 'GOLD' }, $('wallet-msg'), [/** @type {HTMLButtonElement} */ (ev.currentTarget)]);
  if (r) say($('wallet-msg'), 'GOLD received.', 'ok');
});

$('export').addEventListener('click', () => {
  const wif = $('wif');
  if (wif.hidden) {
    wif.textContent = state.key.toWif();
    wif.hidden = false;
    $('export').textContent = 'Hide WIF';
  } else showKey();
});

let armedAt = 0;
$('import').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const input = /** @type {HTMLInputElement} */ ($('import-wif'));
  const msg = $('key-msg');
  try {
    const k = Key.fromWif(input.value.trim());
    if (k.network !== NETWORK) throw new Error('That is a mainnet key. Import a testnet WIF (it starts with c).');
    if (k.address === state.me) {
      say(msg, 'That key is already in use.', 'info');
      return;
    }
    // Two-step: the first press warns, a second within 10 s replaces the key.
    if (Date.now() - armedAt >= 10000) {
      armedAt = Date.now();
      say(msg, 'This replaces the current play key. Export it first if it holds anything you want. Press Import again to continue.', 'info');
      return;
    }
    armedAt = 0;
    state.key = k;
    state.me = k.address;
    wallets.setGuestKey(k);
    const saved = storageSet(k.toWif());
    input.value = '';
    showKey();
    say(msg, saved ? 'Key imported.' : 'Key imported for this visit only: this browser would not save it.', saved ? 'ok' : 'info');
    resetRun();
    refreshAll();
  } catch (e) {
    say(msg, `Not a valid WIF: ${errText(e)}`, 'error');
  }
});

// ---------- the simulation (wasm) ----------

async function loadWasm() {
  // Always revalidate: a cached wasm from before a deploy would not match this script's exports.
  const res = await fetch(new URL('dg_td_wasm.wasm', import.meta.url), { cache: 'no-cache' });
  const { instance } = await WebAssembly.instantiate(await res.arrayBuffer(), {});
  const x = /** @type {any} */ (instance.exports);
  const mem = () => /** @type {WebAssembly.Memory} */ (x.memory).buffer;
  const c = (/** @type {number} */ i) => x.td_const(i);
  return {
    x,
    W: c(0), H: c(1), maxTicks: c(2), waves: c(3), startGold: c(4), startLives: c(5), maxPlacements: c(6),
    /** Views are rebuilt on every call because the wasm memory may have grown. */
    seed: (/** @type {Uint8Array} */ b) => new Uint8Array(mem(), x.td_seed_ptr(), 32).set(b),
    path() {
      const n = x.td_path();
      const w = new Uint32Array(mem(), x.td_path_ptr(), n * 2);
      return Array.from({ length: n }, (_, i) => [w[2 * i], w[2 * i + 1]]);
    },
    frame() {
      const n = x.td_frame();
      return n ? new Int32Array(mem(), x.td_frame_ptr(), n).slice() : null;
    },
    tower: (/** @type {number} */ k, /** @type {number} */ f) => x.td_tower_stat(k, f),
    /** Replay placements against the seed buffer exactly as the node will; null if one is refused. */
    simulate(/** @type {{tick: number, x: number, y: number, kind: number}[]} */ ps) {
      new Uint32Array(mem(), x.td_input_ptr(), ps.length * 4).set(ps.flatMap((p) => [p.tick, p.x, p.y, p.kind]));
      if (x.td_simulate(ps.length)) return null;
      const [score, wavesCleared, lives] = new Uint32Array(mem(), x.td_result_ptr(), 4);
      return { score, wavesCleared, lives };
    },
  };
}

const PLACE_ERRORS = {
  1: 'Too many towers for one run.',
  3: 'The run is over.',
  4: 'That cell is off the board.',
  5: 'That cell is on the path.',
  6: 'There is already a tower there.',
  7: 'Unknown tower.',
  8: 'Not enough gold.',
};

// ---------- drawing ----------

const canvas = /** @type {HTMLCanvasElement} */ ($('board'));
const ctx2d = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const css = (/** @type {string} */ v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const px = (/** @type {number} */ world) => (world / 256) * CELL_PX;

function draw() {
  const w = state.wasm;
  if (!w) return;
  const g = ctx2d;
  canvas.width = w.W * CELL_PX;
  canvas.height = w.H * CELL_PX;
  // the IronDivi night field: deep indigo ground, a faint grid, and a lighter lane for the creeps
  g.fillStyle = '#13132a';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = 'rgba(165,180,252,0.07)';
  for (let i = 0; i <= w.W; i++) { g.beginPath(); g.moveTo(i * CELL_PX, 0); g.lineTo(i * CELL_PX, canvas.height); g.stroke(); }
  for (let j = 0; j <= w.H; j++) { g.beginPath(); g.moveTo(0, j * CELL_PX); g.lineTo(canvas.width, j * CELL_PX); g.stroke(); }

  g.fillStyle = '#2a2b52';
  for (const [x, y] of w.path()) g.fillRect(x * CELL_PX, y * CELL_PX, CELL_PX, CELL_PX);

  const f = state.frame;
  if (state.hover && state.keyCursor && document.activeElement === canvas) {
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.strokeRect(state.hover.x * CELL_PX + 1, state.hover.y * CELL_PX + 1, CELL_PX - 2, CELL_PX - 2);
    g.lineWidth = 1;
  }
  if (state.hover && !state.over) {
    const { x, y } = state.hover;
    const range = px(w.tower(state.kind, 1));
    g.strokeStyle = TOWER_COLORS[state.kind];
    g.fillStyle = `${TOWER_COLORS[state.kind]}22`;
    g.beginPath();
    g.arc((x + 0.5) * CELL_PX, (y + 0.5) * CELL_PX, range, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  if (!f) return;
  for (const t of f.towers) {
    g.fillStyle = TOWER_COLORS[t.kind];
    g.fillRect(t.x * CELL_PX + 8, t.y * CELL_PX + 8, CELL_PX - 16, CELL_PX - 16);
  }
  for (const s of f.shots) {
    g.strokeStyle = TOWER_COLORS[s.kind];
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(px(s.fx), px(s.fy));
    g.lineTo(px(s.tx), px(s.ty));
    g.stroke();
    g.lineWidth = 1;
  }
  for (const c of f.creeps) {
    const cx = px(c.x);
    const cy = px(c.y);
    g.fillStyle = c.slow ? '#38bdf8' : CREEP_COLORS[c.kind] ?? '#444';
    g.beginPath();
    g.arc(cx, cy, CREEP_RADIUS[c.kind] ?? 8, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#22c55e';
    g.fillRect(cx - 12, cy - 22, (24 * c.hp) / Math.max(1, c.max), 3);
  }
}

function renderHud() {
  const f = state.frame;
  const w = state.wasm;
  $('h-gold').textContent = f ? String(f.gold) : '–';
  $('h-lives').textContent = f ? String(f.lives) : '–';
  $('h-wave').textContent = f ? `${f.wave} / ${w.waves}` : '–';
  $('h-score').textContent = f ? String(f.score) : '–';
  // Dim the towers this run can't pay for yet.
  [...$('towers').children].forEach((b, k) => b.classList.toggle('short', !!w && cannotAfford(w.tower(k, 0), f ? f.gold : null)));
}

// ---------- playing a run ----------

function buildTowerButtons() {
  const w = state.wasm;
  const box = $('towers');
  box.replaceChildren(
    ...TOWER_NAMES.map((name, k) => {
      const b = el(
        'button',
        { type: 'button', role: 'radio', 'aria-checked': String(k === state.kind), onclick: () => selectTower(k) },
        el('span', { class: 'sw', style: `background:${TOWER_COLORS[k]}` }),
        `${name} · ${w.tower(k, 0)}g`,
        el('small', {}, `range ${(w.tower(k, 1) / 256).toFixed(1)} · dmg ${w.tower(k, 2)}${w.tower(k, 4) ? ' · splash' : ''}${w.tower(k, 5) ? ' · slows' : ''}`),
      );
      return b;
    }),
  );
}

function selectTower(/** @type {number} */ k) {
  state.kind = k;
  [...$('towers').children].forEach((b, i) => b.setAttribute('aria-checked', String(i === k)));
  draw();
}

function resetRun() {
  state.run = null;
  state.saved = false;
  state.placements = [];
  state.playing = false;
  state.over = false;
  state.submitted = false;
  state.frame = null;
  $('seed-line').hidden = true;
  $('result').hidden = true;
  $('submit').hidden = true;
  $('start').disabled = false;
  syncButtons();
  renderHud();
  draw();
}

function syncButtons() {
  $('pause').disabled = !state.playing || state.over;
  $('pause').textContent = state.paused ? 'Resume' : 'Pause';
  $('faster').disabled = !state.playing || state.over;
  $('faster').textContent = `Speed ×${SPEEDS[state.speed]}`;
}

const hexBytes = (/** @type {string} */ h) => Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));

/** Start playing locally with a run that already exists on chain. */
function beginLocal(/** @type {{id: string, seed: string, rules?: number}} */ r) {
  const w = state.wasm;
  // A run plays and is scored under the tower stats it was started with; a run with no `rules` is from the first set.
  if (w.x.td_set_rules(Number(r.rules ?? 1))) {
    say($('play-msg'), `This run uses tower rules ${r.rules}, which this copy of the page does not know. Reload the page.`, 'error');
    return;
  }
  buildTowerButtons();
  state.run = { ...r, player: state.me };
  state.placements = [];
  state.playing = true;
  state.paused = false;
  state.over = false;
  state.submitted = false;
  state.saved = false;
  w.seed(hexBytes(r.seed));
  w.x.td_init();
  state.frame = parseFrame(w.frame());
  showRun(r);
  say($('play-msg'), 'Pick a tower, then click a grass cell (on a touch screen, tap it twice: once to see the range, again to build). The run ends when lives hit 0 or every wave has gone by.', 'info');
  renderHud();
  draw();
  requestAnimationFrame(tick);
}

/** The run line and the buttons for a run in play. */
function showRun(/** @type {{id: string, seed: string}} */ r) {
  $('run-id').textContent = r.id;
  $('seed').textContent = short(r.seed);
  $('seed-line').hidden = false;
  $('result').hidden = true;
  $('submit').hidden = true;
  $('start').disabled = true;
  syncButtons();
}

/**
 * Pick up `r`, the chain's open run, from this browser's save: rebuild it and wait, paused, for Resume (or show a
 * finished run's result and Submit score). False when there is no save for it or the sim refuses the save, which is
 * then dropped; the caller replays the run from the top.
 * @param {{id: string, seed: string, rules?: number}} r @param {any} saved
 */
function resumeLocal(r, saved) {
  const w = state.wasm;
  if (!saved || saved.run !== r.id || saved.seed !== r.seed) return false;
  const f = rebuild(w.x, { ...saved, rules: Number(r.rules ?? 1) });
  if (!f) {
    clearSave(store(), state.me);
    say($('play-msg'), `The towers saved in this browser for run ${r.id.slice(0, 8)} could not be rebuilt. Press Start to replay it from the top.`, 'error');
    return false;
  }
  buildTowerButtons();
  state.run = { ...r, player: state.me };
  state.placements = saved.placements;
  state.playing = true;
  state.over = false;
  state.submitted = false;
  state.saved = true;
  state.frame = parseFrame(f);
  showRun(r);
  if (state.frame.done) {
    finishLocal();
  } else {
    state.paused = true;
    syncButtons();
    const n = state.placements.length;
    const at = state.frame.wave ? `at wave ${state.frame.wave}` : 'before the first wave';
    const towers = n ? `with your ${n} tower${n === 1 ? '' : 's'}` : 'with no towers yet';
    say($('play-msg'), `Resumed run ${r.id.slice(0, 8)} ${at} ${towers}. Press Resume.`, 'info');
    requestAnimationFrame(tick);
  }
  renderHud();
  draw();
  return true;
}

function tick() {
  if (!state.playing || state.over) return;
  if (!state.paused) {
    const w = state.wasm;
    w.x.td_step(TICKS_PER_FRAME * SPEEDS[state.speed]);
    state.frame = parseFrame(w.frame());
    if (state.frame.done) finishLocal();
    renderHud();
    draw();
  }
  if (!state.over) requestAnimationFrame(tick);
}

function finishLocal() {
  state.over = true;
  const f = state.frame;
  persist();
  syncButtons();
  const banner = $('result');
  const o = state.wasm.simulate(state.placements);
  banner.textContent = o
    ? `Run over: score ${o.score}, ${o.wavesCleared} of ${state.wasm.waves} waves cleared, ${o.lives} lives left. Submit it to put it on the board.`
    : `Run over: score ${f.score}, ${f.lives} lives left. Submit it to put it on the board.`;
  banner.hidden = false;
  $('submit').hidden = false;
  $('submit').textContent = 'Submit score';
  say($('play-msg'), '');
}

canvas.addEventListener('pointermove', (ev) => {
  if (ev.pointerType === 'touch') return;
  state.keyCursor = false;
  state.hover = cellAt(ev);
  if (!state.playing || state.paused) draw();
});
canvas.addEventListener('pointerleave', (ev) => {
  if (ev.pointerType === 'touch') return;
  state.hover = null;
  if (!state.playing || state.paused) draw();
});
let lastPointer = 'mouse';
canvas.addEventListener('pointerdown', (ev) => { lastPointer = ev.pointerType; });
// A touch has no hover, so the first tap on a cell shows the tower's range and a second tap on it builds.
canvas.addEventListener('click', (ev) => {
  const c = cellAt(ev);
  if (!c) return;
  if (lastPointer === 'touch' && !(state.hover && state.hover.x === c.x && state.hover.y === c.y)) {
    state.keyCursor = false;
    state.hover = c;
    draw();
    if (state.playing && !state.over) say($('play-msg'), `Tap the same cell again to build a ${TOWER_NAMES[state.kind]} tower there.`, 'info');
    return;
  }
  place(c.x, c.y);
});
// The keyboard: arrows move a cursor, Enter or Space builds, 1 to 4 pick a tower, P pauses.
canvas.addEventListener('keydown', (ev) => {
  const w = state.wasm;
  if (!w || ev.altKey || ev.ctrlKey || ev.metaKey) return;
  const moves = /** @type {Record<string, number[]>} */ ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] });
  const h = state.hover ?? { x: Math.floor(w.W / 2), y: Math.floor(w.H / 2) };
  if (moves[ev.key]) {
    const [dx, dy] = moves[ev.key];
    state.hover = { x: Math.min(w.W - 1, Math.max(0, h.x + dx)), y: Math.min(w.H - 1, Math.max(0, h.y + dy)) };
  } else if (ev.key === 'Enter' || ev.key === ' ') {
    state.hover = h;
    place(h.x, h.y);
  } else if (/^[1-9]$/.test(ev.key) && Number(ev.key) <= TOWER_NAMES.length) {
    selectTower(Number(ev.key) - 1);
  } else if ((ev.key === 'p' || ev.key === 'P') && state.playing && !state.over) {
    $('pause').click();
  } else {
    return;
  }
  ev.preventDefault();
  state.keyCursor = true;
  canvas.setAttribute('aria-label', `Tower defense board. Cursor at column ${state.hover?.x + 1}, row ${state.hover?.y + 1}. ${TOWER_NAMES[state.kind]} tower selected.`);
  draw();
});
canvas.addEventListener('blur', () => draw());
// The run is kept in this browser as you play; warn on leaving only when it could not be written there.
addEventListener('beforeunload', (ev) => {
  if (state.playing && !state.submitted && state.placements.length && !state.saved) ev.preventDefault();
});
// Leaving the page (a reload, a closed tab, a phone putting it away) saves the tick it got to.
addEventListener('pagehide', () => persist());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persist(); });

function cellAt(/** @type {PointerEvent|MouseEvent} */ ev) {
  const w = state.wasm;
  if (!w) return null;
  const r = canvas.getBoundingClientRect();
  const x = Math.floor(((ev.clientX - r.left) / r.width) * w.W);
  const y = Math.floor(((ev.clientY - r.top) / r.height) * w.H);
  return x >= 0 && y >= 0 && x < w.W && y < w.H ? { x, y } : null;
}

function place(/** @type {number} */ x, /** @type {number} */ y) {
  const w = state.wasm;
  const msg = $('play-msg');
  if (!state.playing || state.over) {
    say(msg, 'Start a run first.', 'info');
    return;
  }
  if (state.placements.length >= w.maxPlacements) {
    say(msg, PLACE_ERRORS[1], 'error');
    return;
  }
  const at = state.frame.tick;
  const code = w.x.td_place(x, y, state.kind);
  if (code) {
    const short = code === 8 ? goldShortText(TOWER_NAMES[state.kind], w.tower(state.kind, 0), state.frame.gold) : '';
    say(msg, short || (/** @type {any} */ (PLACE_ERRORS)[code] ?? `Cannot build there (${code}).`), 'error');
    return;
  }
  say(msg, '');
  state.placements.push({ tick: at, x, y, kind: state.kind });
  state.frame = parseFrame(w.frame());
  persist();
  renderHud();
  draw();
}

$('pause').addEventListener('click', () => {
  state.paused = !state.paused;
  if (state.paused) persist();
  syncButtons();
});
$('faster').addEventListener('click', () => {
  state.speed = (state.speed + 1) % SPEEDS.length;
  syncButtons();
});

// ---------- on-chain: start, submit ----------

/** Find the start event for this player in a receipt. */
function startedRun(/** @type {any} */ receipt) {
  for (const ev of receipt?.events ?? []) {
    if (String(ev?.kind) === `${GAME}.started` && ev.data?.player === state.me) {
      return { id: String(ev.data.run), seed: String(ev.data.seed), rules: Number(ev.data.rules ?? 1) };
    }
  }
  return null;
}

$('start').addEventListener('click', async (ev) => {
  const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
  const msg = $('play-msg');
  if (!state.wasm) {
    say(msg, 'The game engine has not loaded yet.', 'error');
    return;
  }
  // An unsubmitted run picks up from this browser's save, or else replays from the top; its seed is already on chain.
  const open = await openRun();
  if (open) {
    if (!resumeLocal(open, readSave(store(), state.me))) beginLocal(open);
    return;
  }
  clearSave(store(), state.me);
  const receipt = await run(gameAction({ kind: 'start' }), msg, [btn]);
  if (!receipt) return;
  const r = startedRun(receipt) ?? (await openRun());
  if (!r) {
    say(msg, 'The run started but its seed was not in the receipt. Reload and try again.', 'error');
    return;
  }
  beginLocal(r);
  refreshMine();
});

$('submit').addEventListener('click', async (ev) => {
  const btn = /** @type {HTMLButtonElement} */ (ev.currentTarget);
  if (!state.run || !state.over || state.submitted) return;
  const receipt = await run(gameAction({ kind: 'submit', run: state.run.id, placements: state.placements }), $('play-msg'), [btn]);
  if (!receipt) {
    // Expired or submitted elsewhere: the save is no use any more.
    checkSave();
    return;
  }
  state.submitted = true;
  clearSave(store(), state.run.player ?? state.me);
  btn.hidden = true;
  $('start').disabled = false;
  $('start').textContent = 'Start new run';
  try {
    const r = await chain.game(GAME, { run: state.run.id });
    const local = state.frame.score;
    const note = r.score === local ? '' : ` (your screen showed ${local}: the chain's number is the one that counts)`;
    $('result').textContent = `On chain: score ${r.score}, ${r.waves_cleared} waves cleared, ${r.lives} lives left${note}.`;
  } catch (e) {
    $('result').textContent = `Submitted. Could not read the result back: ${errText(e)}`;
  }
  refreshBoard();
  refreshMine();
});

/** The chain's open run for this player as its `{run}` view, or null when it has none. Throws when the chain does not answer. */
async function openRunView() {
  const v = await chain.game(GAME, { player: state.me });
  if (!v?.open) return null;
  const r = await chain.game(GAME, { run: v.open });
  return r?.status === 'open' ? r : null;
}

const runOf = (/** @type {any} */ r) => ({ id: String(r.id), seed: String(r.seed), rules: Number(r.rules ?? 1) });

async function openRun() {
  try {
    const r = await openRunView();
    if (r) return runOf(r);
  } catch {
    /* no open run we can see */
  }
  return null;
}

/**
 * Check this browser's saved run against the chain. Picks it up when it is the open run (and nothing is in play), and
 * drops it when the chain says that run is no longer open: submitted, expired, or not this key's.
 */
async function checkSave() {
  const me = state.me;
  const saved = readSave(store(), me);
  if (!saved) return;
  let r;
  try {
    r = await openRunView();
  } catch {
    return; // the chain did not answer: keep the save for next time
  }
  if (me !== state.me) return;
  const at = { now: Date.now(), height: 0, rules: { runExpiryMs: state.runExpiryMs, runExpiryBlocks: state.runExpiryBlocks, clockFrom: state.clockFrom } };
  if (!resumable(saved, r, me, at)) {
    clearSave(store(), me);
    return;
  }
  if (!state.playing && state.wasm) resumeLocal(runOf(r), saved);
}

// ---------- leaderboard and my runs ----------

async function refreshBoard() {
  const list = $('lb');
  try {
    const v = await chain.game(GAME, state.week == null ? { view: 'leaderboard' } : { view: 'leaderboard', week: state.week });
    if (state.week == null || state.currentWeek == null) state.currentWeek = Number(v.week);
    state.week = Number(v.week);
    const ends = Number(v.ends_ms);
    const when = !Number.isFinite(ends) ? '' : ends > Date.now() ? ` · ends ${localTime(ends)}` : ` · ended ${localTime(ends)}`;
    $('lb-week').textContent = `· week ${v.week}${v.week === state.currentWeek ? ' (this week)' : ''}${when}`;
    const prizes = new Map((v.paid ?? []).map((/** @type {any} */ p) => [p.rank, p.amount]));
    list.replaceChildren(
      ...(v.entries.length
        ? v.entries.map((/** @type {any} */ e) =>
            el(
              'li',
              { class: e.player === state.me ? 'me' : '' },
              who(e.player),
              prizes.has(e.rank) && el('span', { class: 'prize' }, `+${money(prizes.get(e.rank), state.tdDecimals)} TDGOLD`),
              el('span', { class: 'score' }, String(e.score)),
            ),
          )
        : [el('li', { class: 'muted' }, 'No scores this week yet.')]),
    );
    $('lb-prev').disabled = v.week <= 0;
    $('lb-next').disabled = v.week >= state.currentWeek;
  } catch (e) {
    list.replaceChildren(el('li', { class: 'muted' }, `Could not load the leaderboard: ${errText(e)}`));
  }
}

$('lb-prev').addEventListener('click', () => { state.week = Math.max(0, (state.week ?? 0) - 1); refreshBoard(); });
$('lb-next').addEventListener('click', () => { state.week = (state.week ?? 0) + 1; refreshBoard(); });

async function refreshMine() {
  const ul = $('my');
  try {
    const [v, info] = await Promise.all([chain.game(GAME, { player: state.me }), chain.info().catch(() => null)]);
    const height = Number(info?.height ?? 0);
    {
      const fast = faucetFastNote(info);
      if (fast && $('wallet-msg').hidden) say($('wallet-msg'), fast);
    }
    // A run's score goes on chain only when you press Submit score. Until then it stays open for two hours
    // of block time (a run from before the clock rules: RUN_EXPIRY_BLOCKS, or two hours from the switch),
    // and Start picks it up from this browser's save, or replays it from the top.
    const note = (/** @type {any} */ r) => {
      if (r.status === 'scored') return `score ${r.score} · ${r.waves_cleared} waves cleared`;
      const rules = { runExpiryMs: state.runExpiryMs, runExpiryBlocks: state.runExpiryBlocks, clockFrom: state.clockFrom };
      const { ms: due, blocksLeft: left, expired } = runDeadline(r, { now: Date.now(), height, rules });
      if (expired) return 'expired: never submitted';
      const until = due != null ? ` (until ${localTime(due)})` : left != null ? ` (${left} blocks left)` : '';
      return `in progress: press Start to pick it up, then Submit score${until}`;
    };
    ul.replaceChildren(
      ...(v.runs.length
        ? v.runs.map((/** @type {any} */ r) =>
            el('li', {}, el('span', {}, `Run ${String(r.id).slice(0, 8)} · block ${r.start_height}`), el('span', { class: 'muted' }, note(r))),
          )
        : [el('li', { class: 'muted' }, 'No runs yet.')]),
    );
  } catch (e) {
    ul.replaceChildren(el('li', { class: 'muted' }, `Could not load your runs: ${errText(e)}`));
  }
}

// ---------- boot ----------

function refreshAll() {
  refreshAccount();
  refreshBoard();
  refreshMine();
}

function onBlock(/** @type {any} */ block) {
  let dirty = false;
  let mine = false;
  for (const r of block?.receipts ?? []) {
    for (const ev of r?.events ?? []) {
      const kind = String(ev?.kind ?? '');
      if (kind.startsWith(`${GAME}.`)) dirty = true;
      if (JSON.stringify(ev?.data ?? {}).includes(state.me)) mine = true;
    }
  }
  if (mine) refreshAccount();
  if (dirty) {
    refreshBoard();
    refreshMine();
  }
  if (dirty && mine) checkSave();
}

function setConn(/** @type {boolean} */ on) {
  const c = $('conn');
  c.dataset.state = on ? 'on' : 'off';
  c.textContent = on ? 'live' : 'reconnecting…';
  if (on) refreshAll();
}

// ---------- IronDivi wallets ----------

const wallets = mountWallets({
  chain,
  card: /** @type {HTMLElement} */ (document.querySelector('.card.wallet')),
  guestKey: state.key,
  onChange: () => {
    useWallet();
    showKey();
    refreshAll();
  },
});

/** Play with the connected wallet's session key, or with the guest key. */
function useWallet() {
  state.key = wallets.key;
  state.me = wallets.me;
}
useWallet();

async function boot() {
  $('chain-url').textContent = chain.baseUrl;
  showKey();
  try {
    state.wasm = await loadWasm();
    buildTowerButtons();
    state.frame = null;
    renderHud();
    draw();
  } catch (e) {
    say($('play-msg'), `Could not load the game engine: ${errText(e)}`, 'error');
    $('start').disabled = true;
  }
  chain.subscribe(onBlock, { onStatus: setConn });
  try {
    const [tokens, cfg] = await Promise.all([chain.tokens().catch(() => null), chain.game(GAME).catch(() => null)]);
    const list = Array.isArray(tokens) ? tokens : Array.isArray(tokens?.tokens) ? tokens.tokens : [];
    const find = (/** @type {string} */ s) => list.find((/** @type {any} */ t) => (t?.symbol ?? t?.token) === s);
    if (Number.isInteger(find('GOLD')?.decimals)) state.decimals = find('GOLD').decimals;
    if (Number.isInteger(cfg?.decimals)) state.tdDecimals = cfg.decimals;
    if (Number.isFinite(Number(cfg?.run_expiry_blocks))) state.runExpiryBlocks = Number(cfg.run_expiry_blocks);
    if (Number.isFinite(Number(cfg?.run_expiry_ms))) state.runExpiryMs = Number(cfg.run_expiry_ms);
    if (Number.isFinite(Number(cfg?.clock_rules_from_ms))) state.clockFrom = Number(cfg.clock_rules_from_ms);
    if (cfg?.weekly_pool) {
      $('lb-note').textContent = `Each week the top ten share ${money(cfg.weekly_pool, state.tdDecimals)} TDGOLD, paid when the week ends. One entry per player: your best run counts.`;
    }
  } catch {
    /* defaults stand */
  }
  refreshAll();
  checkSave();
}

boot();
