// Deadlines that cost a player who walks away: a blackjack hand left on its player's turn, and a tower defense run
// left unsubmitted. Pure, no DOM, so tests/sdk/hub-deadlines.test.mjs can run it. The /play hub lists them
// (hub.js), and the tower defense page notes a run's expiry with runDeadline.

/** A finite number from a config view, else `fallback`. */
const num = (/** @type {any} */ v, /** @type {number} */ fallback) => (v != null && Number.isFinite(Number(v)) ? Number(v) : fallback);

/**
 * Blackjack's idle rules from its config view (`chain.game('blackjack')`), with the blackjack page's defaults.
 * @param {any} view
 */
export function bjRules(view) {
  return {
    idleMs: num(view?.idle_ms, 2 * 60 * 60 * 1000),
    idleMsV2: num(view?.idle_ms_v2, 10 * 60 * 1000),
    idleBlocks: num(view?.idle_blocks, 3600),
    clockFrom: num(view?.clock_rules_from_ms, Infinity),
    v2From: num(view?.rules_v2_from_ms, Infinity),
  };
}

/**
 * Tower defense's run expiry from its config view (`chain.game('towerdefense')`), with the page's defaults.
 * @param {any} cfg
 */
export function tdRules(cfg) {
  return {
    runExpiryMs: num(cfg?.run_expiry_ms, 2 * 60 * 60 * 1000),
    runExpiryBlocks: num(cfg?.run_expiry_blocks, 3600),
    clockFrom: num(cfg?.clock_rules_from_ms, Infinity),
  };
}

/**
 * When anyone may `expire` a hand whose player has gone quiet on their turn, as the chain counts it: `idleMs` of block
 * time from its last move (forfeited, the stake to the house), and from the second rules `idleMsV2` (the house stands
 * for the player). A hand from before the clock rules counts from the switch, or `idleBlocks` from its last height.
 * @param {any} h @param {ReturnType<typeof bjRules>} rules
 * @returns {{ms: number|null, height: number|null, stands: boolean}} ms: the block time, or null while only the
 *   height is known; height: the block height, for a hand from before the clock rules; stands: whether the house
 *   stands the hand then, rather than taking the stake.
 */
export function handDeadline(h, rules) {
  const old = h.updated_ms == null;
  const since = old ? rules.clockFrom : Number(h.updated_ms);
  let ms = null;
  let stands = false;
  if (Number.isFinite(since)) {
    if (since + rules.idleMsV2 >= rules.v2From) [ms, stands] = [since + rules.idleMsV2, true];
    else if (since + rules.idleMs < rules.v2From) [ms, stands] = [since + rules.idleMs, false];
    else [ms, stands] = [rules.v2From, true];
  }
  const height = old ? Number(h.updated_height ?? h.created_height ?? 0) + rules.idleBlocks : null;
  return { ms, height, stands };
}

/**
 * The active hand of a `{player}` view when it is on `me`'s turn and its deadline has not passed, else null.
 * @param {any} view `{active, hands}` @param {string} me
 * @param {{now: number, height: number, rules: ReturnType<typeof bjRules>}} at `height` 0 when unknown
 */
export function handOnMe(view, me, { now, height, rules }) {
  const hands = Array.isArray(view?.hands) ? view.hands : [];
  const h = view?.active ? hands.find((/** @type {any} */ x) => x?.id === view.active) : null;
  if (!h || h.status !== 'playing' || !me || h.player !== me) return null;
  const d = handDeadline(h, rules);
  if ((d.ms != null && now >= d.ms) || (d.height != null && height > 0 && height >= d.height)) return null;
  return { hand: h, ...d };
}

/**
 * When an open run stops counting, as the chain counts it: `runExpiryMs` of block time from its start; a run from
 * before the clock rules expires `runExpiryBlocks` after its start height, or two hours from the switch.
 * @param {any} r @param {{now: number, height: number, rules: ReturnType<typeof tdRules>}} at `height` 0 when unknown
 * @returns {{ms: number|null, blocksLeft: number|null, expired: boolean}}
 */
export function runDeadline(r, { now, height, rules }) {
  const ms = r.start_ms != null ? Number(r.start_ms) + rules.runExpiryMs
    : now >= rules.clockFrom ? rules.clockFrom + rules.runExpiryMs : null;
  const blocksLeft = r.start_ms == null && height ? Number(r.start_height) + rules.runExpiryBlocks - height : null;
  return { ms, blocksLeft, expired: (ms != null && now >= ms) || (blocksLeft != null && blocksLeft < 0) };
}

/**
 * `me`'s run (a `{run}` view) when it is open and has not expired, with its deadline, else null.
 * @param {any} r @param {string} me @param {{now: number, height: number, rules: ReturnType<typeof tdRules>}} at
 */
export function runOpen(r, me, at) {
  if (!r || r.status !== 'open' || !me || r.player !== me) return null;
  const { ms, blocksLeft, expired } = runDeadline(r, at);
  return expired ? null : { run: r, ms, blocksLeft };
}

/**
 * The soonest of `times` still after `now`, or null.
 * @param {(number|null|undefined)[]} times @param {number} now
 */
export function nextDeadline(times, now) {
  const ahead = times.filter((t) => t != null && t > now);
  return ahead.length ? Math.min(.../** @type {number[]} */ (ahead)) : null;
}
