// The tower defense gold note: what the page says when the run's gold can't pay for the picked tower, and which
// picker entries the run can't afford yet. This is the run's own gold (the sim's whole numbers: START_GOLD to begin
// with, then each kill's bounty), not the GOLD token, so there is nothing to buy and no faucet to point to.
// Pure functions, no DOM.

/**
 * What to say when `gold` can't pay for a `name` tower costing `cost`, or '' when it can.
 * @param {string} name @param {number} cost @param {number} gold
 */
export function goldShortText(name, cost, gold) {
  if (gold >= cost) return '';
  const a = /^[AEIOU]/i.test(name) ? 'An' : 'A';
  return `${a} ${name} tower costs ${cost} gold and you have ${gold}. Kills pay gold: wait for a few, then try again.`;
}

/**
 * Whether the run's `gold` (null with no run) is short of `cost`.
 * @param {number} cost @param {number|null} gold
 */
export function cannotAfford(cost, gold) {
  return gold != null && gold < cost;
}
