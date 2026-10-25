// A tower defense run kept in this browser until it is submitted, so a reload, a closed tab or a trip to the /play
// hub does not lose the towers. Pure, no DOM, so tests/towerdefense/resume.test.mjs can run it against the wasm.
//
// A save is `{run, seed, rules, placements, tick, over}` under `dg.td.run.<address>`: testnet game data only, never a
// key. Rebuilding replays the placements against the seed exactly as live play made them, then steps to `tick`.

import { runDeadline } from '../deadlines.js';

const PREFIX = 'dg.td.run.';

export const saveKey = (/** @type {string} */ address) => `${PREFIX}${address}`;

const isTick = (/** @type {any} */ n) => Number.isInteger(n) && n >= 0;

/** A save read back from storage, if it has the shape writeSave gives it. */
function valid(/** @type {any} */ s) {
  return s && typeof s === 'object' && typeof s.run === 'string' && s.run && typeof s.seed === 'string'
    && isTick(s.rules) && isTick(s.tick) && typeof s.over === 'boolean' && Array.isArray(s.placements)
    && s.placements.every((/** @type {any} */ p) => p && isTick(p.tick) && isTick(p.x) && isTick(p.y) && isTick(p.kind));
}

/**
 * The save for `address`, or null when there is none, it is unreadable, or storage is blocked.
 * @param {Storage|null} storage @param {string} address
 */
export function readSave(storage, address) {
  try {
    const raw = storage && address ? storage.getItem(saveKey(address)) : null;
    const s = raw == null ? null : JSON.parse(raw);
    if (!valid(s)) return null;
    const { run, seed, rules, placements, tick, over } = s;
    return { run, seed, rules, placements: placements.map(({ tick: t, x, y, kind }) => ({ tick: t, x, y, kind })), tick, over };
  } catch {
    return null;
  }
}

/**
 * Write the save for `address`; false when storage is blocked or full.
 * @param {Storage|null} storage @param {string} address
 * @param {{run: string, seed: string, rules: number, placements: {tick: number, x: number, y: number, kind: number}[], tick: number, over: boolean}} s
 */
export function writeSave(storage, address, s) {
  try {
    if (!storage || !address) return false;
    const { run, seed, rules, placements, tick, over } = s;
    storage.setItem(saveKey(address), JSON.stringify({ run, seed, rules, placements, tick, over }));
    return true;
  } catch {
    return false;
  }
}

/** @param {Storage|null} storage @param {string} address */
export function clearSave(storage, address) {
  try {
    if (!storage || !address) return false;
    storage.removeItem(saveKey(address));
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `save` belongs to `r`, a `{run}` view, and the run is still open for `me`: same id and seed, `me`'s, not
 * submitted and not past its deadline. Anything else means the save is stale.
 * @param {any} save @param {any} r @param {string} me
 * @param {{now: number, height: number, rules: {runExpiryMs: number, runExpiryBlocks: number, clockFrom: number}}} at
 */
export function resumable(save, r, me, at) {
  if (!save || !r || r.status !== 'open' || !me || r.player !== me) return false;
  if (String(r.id) !== save.run || String(r.seed) !== save.seed) return false;
  return !runDeadline(r, at).expired;
}

/**
 * Rebuild the live sim in the wasm instance `x` from `save`: the run's rules and seed, each placement at its tick,
 * then on to the saved tick. Returns the frame (as `td_frame` lays it out), or null when the wasm refuses any of it
 * (an unknown rule set, a bad seed, a placement out of order or the sim will not take) or the save does not add up
 * (it says over and the run is not, or its tick is past the end). Then the caller replays from the top instead.
 * @param {any} x the wasm exports
 * @param {{seed: string, rules: number, placements: {tick: number, x: number, y: number, kind: number}[], tick: number, over: boolean}} save
 */
export function rebuild(x, save) {
  if (!/^[0-9a-f]{64}$/i.test(save.seed) || x.td_set_rules(Number(save.rules ?? 1))) return null;
  const maxTicks = x.td_const(2);
  const maxPlacements = x.td_const(6);
  if (!isTick(save.tick) || save.placements.length > maxPlacements) return null;
  new Uint8Array(x.memory.buffer, x.td_seed_ptr(), 32).set(Uint8Array.from(save.seed.match(/../g) ?? [], (b) => parseInt(b, 16)));
  x.td_init();
  const header = () => {
    const n = x.td_frame();
    return n ? new Int32Array(x.memory.buffer, x.td_frame_ptr(), n).slice() : null;
  };
  /** Step to tick `t`; the frame there, or null when the run ends first. */
  const stepTo = (/** @type {number} */ t) => {
    let f = header();
    if (!f) return null;
    if (t > f[0]) {
      x.td_step(t - f[0]);
      f = header();
    }
    return f && f[0] === t ? f : null;
  };
  let last = 0;
  for (const p of save.placements) {
    if (![p.tick, p.x, p.y, p.kind].every(isTick) || p.tick < last || p.tick >= maxTicks) return null;
    last = p.tick;
    const f = stepTo(p.tick);
    if (!f || f[5]) return null;
    if (x.td_place(p.x, p.y, p.kind)) return null;
  }
  if (save.tick < last) return null;
  const f = stepTo(save.tick);
  if (!f || !!f[5] !== !!save.over) return null;
  return f;
}

/** Split a flat frame (see crates/dg-td-wasm/src/lib.rs) into named parts. */
export function parseFrame(/** @type {Int32Array} */ f) {
  const [tick, gold, lives, wave, score, done, nc, nt, ns] = f;
  let o = 9;
  const creeps = [];
  for (let i = 0; i < nc; i++, o += 7) creeps.push({ id: f[o], x: f[o + 1], y: f[o + 2], hp: f[o + 3], max: f[o + 4], kind: f[o + 5], slow: f[o + 6] });
  const towers = [];
  for (let i = 0; i < nt; i++, o += 3) towers.push({ x: f[o], y: f[o + 1], kind: f[o + 2] });
  const shots = [];
  for (let i = 0; i < ns; i++, o += 5) shots.push({ fx: f[o], fy: f[o + 1], tx: f[o + 2], ty: f[o + 3], kind: f[o + 4] });
  return { tick, gold, lives, wave, score, done: !!done, creeps, towers, shots };
}
